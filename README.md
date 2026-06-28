# signalman

> Observability and reconciliation for a distributed booking platform. Trace one
> booking end to end across synchronous gRPC and asynchronous events, and surface
> the moment the sources of truth diverge.

A booking coordinates several services that each own part of the truth —
inventory holds, payment authorizations, an external supplier confirmation, and a
financial ledger. The failure mode that matters is not a crash, it is silent
**divergence**: the supplier confirmed but the ledger thinks it failed, or a hold
was never released. `signalman` makes one booking one connected trace across every
hop, and runs a reconciler that compares the sources of truth and links any drift
back to the originating trace.

See [`spec.md`](spec.md) for the full design and [`PROGRESS.md`](PROGRESS.md) for
current status.

## Status

Foundations plus the first two saga participants (milestones **M0 → M1**). The
monorepo, tooling, CI, the trace-context propagation library, the OpenTelemetry
bootstrap library, the trace-correlated logging library, the observability
interceptor (business spans + RED metrics), the transactional outbox library
(durable staging + trace-aware relay), the idempotent inbox library (dedup +
trace-continuing consumer), a gateway health endpoint, the **inventory
service** — a gRPC source of truth for holds — and the **payments service** — a
gRPC source of truth for authorizations/captures wrapping a simulated PSP — are
in place and verified, both staging outbox events. The remaining services, the
broker/Postgres/observability stack, and the coordinating saga are upcoming
milestones.

## Stack

Node / TypeScript · NestJS (microservices) · gRPC · an event broker (NATS
JetStream or Kafka) · Postgres per service · transactional outbox ·
OpenTelemetry JS exporting OTLP to Tempo + Grafana.

## Layout

```
signalman/
  services/
    gateway/        # HTTP entry point; opens a booking's root span (M0: health probe)
    inventory/      # gRPC source of truth for holds (Hold/Release) + outbox-staged events
    payments/       # gRPC source of truth for payments (Authorize/Capture/Void), wraps a simulated PSP
    …               # coordinator, supplier, ledger, notifier, reconciler (upcoming)
  libs/
    otel/           # OpenTelemetry SDK bootstrap: resource, OTLP exporters, lifecycle
    propagation/    # inject/extract W3C traceparent into broker message headers
    logging/        # trace-correlated structured JSON logger (NestJS LoggerService)
    interceptor/    # NestJS interceptor: per-handler business spans + RED metrics
    outbox/         # transactional outbox: durable event staging + trace-aware relay
    inbox/          # idempotent inbox: per-consumer dedup + trace-continuing consumer
```

The monorepo uses NestJS monorepo mode. Libraries are imported via path aliases
(e.g. `@signalman/otel`, `@signalman/propagation`, `@signalman/logging`,
`@signalman/interceptor`, `@signalman/outbox`, `@signalman/inbox`).

### `@signalman/otel`

A service boots telemetry once, before any application module loads, so the
registered instrumentations can patch what they hook into:

```ts
import { startTelemetry } from '@signalman/otel';

startTelemetry({ serviceName: 'coordinator', serviceVersion: '0.1.0' });
```

Traces and metrics export over OTLP/HTTP to the Collector, configured through the
standard `OTEL_EXPORTER_OTLP_*` environment variables (defaulting to
`http://localhost:4318`). The returned handle flushes on `SIGTERM`/`SIGINT` so no
spans are lost on shutdown.

### `@signalman/logging`

Every service logs structured JSON lines that carry the active span's
`trace_id`/`span_id`/`trace_flags`, so a log in Grafana/Loki links straight back
to the span — and therefore the booking — it was written under:

```ts
import { createLogger } from '@signalman/logging';

const logger = createLogger({ service: 'coordinator', context: 'BookingSaga' });
logger.info('hold placed', { booking_id: 'bk_1', qty: 2 });
// {"timestamp":"…","level":"info","service":"coordinator","context":"BookingSaga",
//  "message":"hold placed","trace_id":"…","span_id":"…","trace_flags":"01",
//  "booking_id":"bk_1","qty":2}
```

It implements the NestJS `LoggerService` interface, so `app.useLogger(logger)`
routes framework logs through the same correlated pipeline, and `logger.child({…})`
binds a context and fields for a unit of work.

### `@signalman/interceptor`

Each service imports the observability module once. Every inbound handler — HTTP
on the gateway, gRPC on the downstream services — is then wrapped in a SERVER
span (kept active for the call, so any child span the handler opens joins the
same trace) and metered with the RED method:

```ts
import { ObservabilityModule } from '@signalman/interceptor';

@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'inventory' })],
})
export class AppModule {}
```

It records a `signalman.operation.duration` histogram (rate via count, latency
via distribution) and a `signalman.operation.errors` counter, tagged with a
low-cardinality `operation`/transport/`outcome` dimension set, and maps HTTP and
gRPC contexts onto the OpenTelemetry RPC/HTTP semantic conventions. Errored spans
carry `error.type` and a recorded exception. Pass `global: false` to bind it
selectively with `@UseInterceptors` instead of registering it globally.

### `@signalman/outbox`

The transactional outbox defeats the dual-write problem: a service writes its
business state **and** an outbox row in one local transaction, so an event
publishes if and only if the state change committed — no events lost when a
service crashes between commit and publish, and no phantom events from a publish
whose transaction later rolled back.

`createOutboxRecord` stages an event, capturing the active trace context into its
headers; the service hands the row to its `OutboxStore` inside the same
transaction as the state change:

```ts
import { createOutboxRecord } from '@signalman/outbox';

await db.transaction(async (tx) => {
  await holds.insert(tx, hold);                       // business state
  await outboxStore.add(                              // …and its event, atomically
    createOutboxRecord({
      aggregateType: 'hold',
      aggregateId: hold.id,
      eventType: 'inventory.held',
      payload: { bookingId, qty },
    }),
  );
});
```

A background `OutboxRelay` then drains the store. For each row it opens a PRODUCER
span **parented to the staged trace**, re-injects that span's context into the
outgoing headers, and publishes through a broker-agnostic `Publisher` — so the
saga step, the publish hop, and the eventual consume span all hang off one
connected booking trace. Delivery is at-least-once (rows are leased while
in-flight and reclaimed after a crash; pair with the idempotent inbox for
effectively-once), with capped exponential back-off and dead-lettering:

```ts
import { OutboxRelay } from '@signalman/outbox';

const relay = new OutboxRelay({ store: outboxStore, publisher, messagingSystem: 'nats' });
relay.start(250); // poll every 250ms; relay.stop() on shutdown
```

`InMemoryOutboxStore` is the reference store implementation — it models leasing,
back-off, and dead-lettering exactly as a SQL store would, and serves as a fake
in tests until the Postgres-backed store lands with the services.

### `@signalman/inbox`

The outbox publishes **at-least-once** — a relay crash between handing a message
to the broker and marking it published leaves the row claimable, so the broker
may redeliver. The inbox is the other half of **effectively-once**: each consumer
records the ids of the messages it has handled and skips a redelivery it has seen
before. Recording that marker *in the same transaction* as the handler's side
effects is what makes the guarantee real — the work and the "I did this" commit
together, so a crash before commit rolls back both and the redelivery reprocesses
cleanly.

`IdempotentConsumer` wraps a handler: it extracts the upstream trace context from
the broker headers and opens a CONSUMER span **continuing the publish trace** (so
the consume span joins the same booking trace instead of orphaning), then dedups
through an `InboxStore`. A first delivery runs the handler under that active span;
a redelivery is skipped and tagged on the span so the duplicate is visible, not
silent; a handler error is recorded and rethrown so the caller can NACK and let
the broker redeliver:

```ts
import { IdempotentConsumer, InMemoryInboxStore } from '@signalman/inbox';

const ledger = new IdempotentConsumer({
  store: new InMemoryInboxStore(),
  consumer: 'ledger', // dedup namespace: fan-out consumers each use their own
  messagingSystem: 'nats',
});

// In the broker subscription, hand each delivered message to the consumer:
const { status } = await ledger.consume(
  { messageId: record.id, eventType: 'supplier.confirmed', headers },
  async () => commitLedgerEntry(record.payload), // runs at most once
);
// status === 'processed' on the first delivery, 'duplicate' on a redelivery
```

`InboxStore.processOnce` is the single atomic primitive — dedup-check, run, and
record in one transaction — because that is the only place the guarantee can be
made. `InMemoryInboxStore` is the reference store: it claims synchronously (so
interleaved redeliveries can't both run) and rolls the marker back when the
handler throws, modelling an `INSERT … ON CONFLICT DO NOTHING` plus the handler's
writes under one transaction, until the Postgres-backed store lands with the
services. Pair it with the outbox relay for effectively-once processing.

### `services/inventory`

The first downstream saga participant — the inventory **source of truth**. It
owns availability and holds, and exposes the saga's synchronous inventory
commands over gRPC (`proto/inventory.proto`):

- `Hold(bookingId, sku, qty)` reserves stock for a booking. It is **idempotent
  per booking**: a retried hold returns the standing reservation rather than
  reserving twice, so the coordinator and broker redeliveries can retry freely.
  A request that would oversell is rejected with `held = false` and a `reason`.
- `Release(bookingId)` gives the reservation back — the saga **compensation**.
  It is idempotent too: releasing an already-released or unknown booking is a
  successful no-op, so a compensation can fire more than once without
  over-restoring stock.

Each state change is paired with an outbox event (`inventory.held` /
`inventory.released`) staged through `@signalman/outbox`, so the rest of the
system learns what happened without the dual-write problem. Every gRPC handler
is wrapped by `@signalman/interceptor`'s SERVER span — the inventory hop of the
booking trace — and the staged events continue from it, so the whole leg hangs
off one connected trace. The in-memory hold and outbox stores are reference
implementations; the Postgres-backed stores and the relay that drains events to
the broker land with the datastore and broker milestones.

### `services/payments`

The money leg of the saga — the payments **source of truth**. It owns
authorizations and captures, and exposes the saga's synchronous payment commands
over gRPC (`proto/payments.proto`):

- `Authorize(bookingId, amount, currency)` reserves funds with the PSP. It is
  **idempotent per booking**: a retried authorization returns the standing one
  rather than charging twice.
- `Capture(bookingId)` takes the authorized funds — the saga's money-taking step.
  Idempotent: a retry returns the standing capture.
- `Void(bookingId)` releases the authorization — the saga **compensation**.
  Idempotent: voiding an already-voided or unknown booking is a successful no-op.

Behind the service sits a **simulated PSP**, the external source of truth the
spec calls out as where divergence is born. `SimulatedPsp` injects controllable
latency and decline/failure (`PSP_LATENCY_MS`, `PSP_DECLINE_RATE`,
`PSP_FAILURE_RATE`), and wraps every call in a **CLIENT span** — the external
boundary hop made visible in the booking trace. The service draws a sharp line
between a PSP **decline** (a business "no", returned as data) and a PSP
**outage** (a thrown error, propagated so the gRPC SERVER span errors and the
coordinator can retry the hop).

Each state change is paired with an outbox event (`payment.authorized` /
`payment.captured` / `payment.voided`) staged through `@signalman/outbox`. As
with inventory, the in-memory payment and outbox stores are reference
implementations; the Postgres-backed stores and the broker relay land with later
milestones.

## Getting started

Requires Node 20+ (see [`.nvmrc`](.nvmrc)).

```bash
npm install        # install dependencies
npm run build      # compile all projects
npm test           # run the full test suite
npm run lint       # eslint
npm run typecheck  # tsc --noEmit across the workspace
```

### Run the gateway

```bash
npm start                       # boots the gateway on PORT (default 3000)
curl http://localhost:3000/health
# {"status":"ok","service":"gateway"}
```

### Run the inventory service

```bash
npm run start:inventory         # boots the gRPC server on INVENTORY_GRPC_URL
                                # (default 0.0.0.0:50051)
```

It registers the `signalman.inventory.v1.Inventory` service; drive it with any
gRPC client (e.g. `grpcurl`) against `proto/inventory.proto`. Telemetry starts
before the transport, so spans and RED metrics flow from the first request.

### Run the payments service

```bash
npm run start:payments          # boots the gRPC server on PAYMENTS_GRPC_URL
                                # (default 0.0.0.0:50052)
```

It registers the `signalman.payments.v1.Payments` service. The simulated PSP's
behaviour is tunable via `PSP_LATENCY_MS`, `PSP_DECLINE_RATE`, and
`PSP_FAILURE_RATE` — set them all to `0` for a deterministic, always-approving
demo.

## Development

- **Tests** live next to the code as `*.spec.ts` and run under Jest + ts-jest.
- **Build** uses `nest build <project>`; output lands in `dist/`.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs install,
  lint, typecheck, build, and test on every push and pull request.
