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

## Documentation

| Document | What it covers |
|----------|---------------|
| [docs/integration.md](docs/integration.md) | One-command setup, curl walkthroughs, grpcurl examples, library reuse recipes |
| [docs/api.md](docs/api.md) | HTTP API, gRPC service contracts, async event catalogue, env vars |
| [docs/architecture.md](docs/architecture.md) | Component map, data/control flow, design decisions, spec-to-code map |
| [docs/how-to.md](docs/how-to.md) | Developer workflows, Grafana navigation, failure diagnosis, troubleshooting |
| [docs/index.md](docs/index.md) | Docs hub — all documents with descriptions and key concepts |

See [`spec.md`](spec.md) for the full design and [`PROGRESS.md`](PROGRESS.md) for
current status.

## Status

**v1.0.0 — specification complete.** All eight milestones (M0 – M8) are done
and the full test suite is green (420+ assertions, 62 suites).

Every spec requirement is in place:

| # | Requirement | Status |
|---|-------------|--------|
| M0 | Scaffold — NestJS monorepo, CI, all eight services | ☑ done |
| M1 | Happy-path saga — hold / auth / confirm / capture / commit / notify | ☑ done |
| M2 | Transactional outbox — dual-write closed, crash-proven, relay wired | ☑ done |
| M3 | Trace propagation — one booking = one trace across gRPC + events + external hop | ☑ done |
| M4 | Compensations — failure paths unwind in reverse, all compensation spans visible | ☑ done |
| M5 | Idempotency — inbox dedup, redelivery-safe consumers, effectively-once delivery | ☑ done |
| M6 | Reconciler — source-of-truth comparison, divergence findings linked to traces | ☑ done |
| M7 | Metrics + logs — RED + per-step SLOs in Grafana, trace-correlated structured logs | ☑ done |
| M8 | Harden + ship — failure injection, trace anatomy, one-command docker-compose | ☑ done |

## Quick start

Requires Docker and Docker Compose.

```bash
docker-compose up
```

This builds all services from the monorepo and starts the full stack: NATS
JetStream, OTel Collector, Grafana Tempo, Grafana, and all eight application
services. The first build takes a few minutes; subsequent starts are fast.

Once all services are up, trigger a booking:

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{"skuId":"SKU-1","quantity":1,"amount":100,"customerId":"c1"}' | jq .
```

The response carries a `traceId`. Open **Grafana** at
[http://localhost:3001](http://localhost:3001), go to **Explore → Tempo**, and
paste the trace ID to browse the connected booking trace across all six services.
The **Signalman — Booking Platform** dashboard (under Dashboards → Signalman)
shows RED metrics per service and a live trace search panel.

To force a compensation path (supplier failure → saga unwind), set a 100 %
supplier failure rate:

```bash
docker-compose up \
  -e SUPPLIER_FAILURE_RATE=1
```

Then trigger a booking — the saga will reach the supplier step, fail, and unwind
`payments.void → inventory.release`. Both the failure and the compensations appear
as spans under the coordinator's `Book` SERVER span in Tempo.

## Trace anatomy

The trace diagram below shows exactly which spans appear in Grafana Tempo for a
booking. `[S]` = SERVER span, `[C]` = CLIENT span, `[P]` = PRODUCER span,
`[CON]` = CONSUMER span. Indentation is parent → child.

### Happy path — booking succeeds

```
POST /bookings [S, gateway]                           ← root span; traceId born here
└─ Coordinator/Book [C, gateway]
   └─ Coordinator/Book [S, coordinator]               ← same traceId, continues from gateway
      ├─ saga.inventory.hold [S, coordinator]
      │   └─ Inventory/Hold [C, coordinator]
      │      └─ Inventory/Hold [S, inventory]
      ├─ saga.payments.authorize [S, coordinator]
      │   └─ Payments/Authorize [C, coordinator]
      │      └─ Payments/Authorize [S, payments]
      │         └─ psp.authorize [C, payments]        ← external PSP boundary span
      ├─ saga.supplier.confirm [S, coordinator]
      │   └─ Supplier/Confirm [C, coordinator]
      │      └─ Supplier/Confirm [S, supplier]
      │         └─ partner.confirm [C, supplier]      ← external partner boundary span
      ├─ saga.payments.capture [S, coordinator]
      │   └─ Payments/Capture [C, coordinator]
      │      └─ Payments/Capture [S, payments]
      └─ saga.ledger.commit [S, coordinator]
          └─ Ledger/Commit [C, coordinator]
             └─ Ledger/Commit [S, ledger]

      ── async hop (outbox → NATS → inbox) ──────────────────────────────────────
      ledger.committed [P, ledger outbox relay]        ← parented to Ledger/Commit [S]

      ── fan-out: new root trace, span link to PRODUCER ─────────────────────────
      notifier.consume ledger.committed [CON, notifier]
      └─ notification.send [C, notifier]               ← external provider boundary span

      ── fan-out: reconciler's own trace ────────────────────────────────────────
      reconcile.pass [S, reconciler]
      └─ (no divergence found for a clean booking)
```

### Compensation path — supplier fails, saga unwinds

```
POST /bookings [S, gateway]
└─ Coordinator/Book [C, gateway]
   └─ Coordinator/Book [S, coordinator]   signalman.saga.failed=true
      ├─ saga.inventory.hold ✓
      ├─ saga.payments.authorize ✓
      ├─ saga.supplier.confirm ✗          signalman.saga.outcome=failed, error.type=partner_outage
      │                                   ── compensation unwind begins ──
      ├─ saga.compensation.supplier.cancel  [S] signalman.saga.compensation=true
      │   └─ Supplier/Cancel [C]
      │      └─ Supplier/Cancel [S, supplier]
      ├─ saga.compensation.payments.void   [S] signalman.saga.compensation=true
      │   └─ Payments/Void [C]
      │      └─ Payments/Void [S, payments]
      └─ saga.compensation.inventory.release [S] signalman.saga.compensation=true
          └─ Inventory/Release [C]
             └─ Inventory/Release [S, inventory]
```

### Reconciler divergence — supplier confirmed, ledger missing

When the reconciler detects a divergence (supplier confirmed a booking but the
ledger has no committed record), it emits a `reconcile.divergence` span on its
own pass trace that carries a **span link** back to the originating booking trace:

```
── reconciler's pass trace ────────────────────────────────────────────────────
reconcile.pass [S, reconciler]
└─ reconcile.divergence [S, reconciler]
       kind=supplier_confirmed_ledger_missing
       booking.id=bk_abc123
       signalman.trace.link → traceId of the original booking   ← jump straight to it
```

In Grafana Tempo, clicking the span link navigates from the divergence finding
directly to the booking trace that caused it — the payoff of linking reconciler
findings back to the source.

## Stack

Node / TypeScript · NestJS (microservices) · gRPC · an event broker (NATS
JetStream or Kafka) · Postgres per service · transactional outbox ·
OpenTelemetry JS exporting OTLP to Tempo + Grafana.

## Layout

```
signalman/
  services/
    gateway/        # HTTP entry point: opens a booking's root span, drives the coordinator (POST /bookings, GET /bookings/:id, /health)
    coordinator/    # saga orchestrator: drives the booking over gRPC + compensations (Book)
    inventory/      # gRPC source of truth for holds (Hold/Release) + outbox-staged events
    payments/       # gRPC source of truth for payments (Authorize/Capture/Void), wraps a simulated PSP
    supplier/       # gRPC source of truth for partner confirmations (Confirm/Cancel), wraps a simulated partner
    ledger/         # internal gRPC source of truth for the financial record (Commit/Reverse) + outbox-staged events
    notifier/       # async consumer: tells the customer on ledger.committed, via a simulated provider (inbox-deduped)
    reconciler/     # periodic job: compares the sources of truth, emits divergence findings linked to the trace
  libs/
    otel/           # OpenTelemetry SDK bootstrap: resource, OTLP exporters, lifecycle
    propagation/    # inject/extract W3C traceparent into broker message headers
    logging/        # trace-correlated structured JSON logger (NestJS LoggerService)
    interceptor/    # NestJS interceptor: per-handler business spans + RED metrics
    outbox/         # transactional outbox: durable event staging + trace-aware relay
    inbox/          # idempotent inbox: per-consumer dedup + trace-continuing consumer
    broker/         # the broker boundary + in-memory reference: outbox→broker→inbox on one trace
```

The monorepo uses NestJS monorepo mode. Libraries are imported via path aliases
(e.g. `@signalman/otel`, `@signalman/propagation`, `@signalman/logging`,
`@signalman/interceptor`, `@signalman/outbox`, `@signalman/inbox`,
`@signalman/broker`).

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

For an inbound gRPC call it also lifts the upstream `traceparent` from the
request metadata (`resolveParentContext`), so the SERVER span **continues** the
caller's booking trace rather than starting an orphan — the server half of the
cross-service trace whose client half lives in the coordinator's leg clients.
Inbound HTTP at the gateway carries no upstream parent, so its span is the
trace's root.

### `@signalman/outbox`

The transactional outbox defeats the dual-write problem: a service writes its
business state **and** an outbox row in one local transaction, so an event
publishes if and only if the state change committed — no events lost when a
service crashes between commit and publish, and no phantom events from a publish
whose transaction later rolled back.

`createOutboxRecord` stages an event, capturing the active trace context into its
headers; `runInTransaction` threads a `UnitOfWork` through the business-state
write and the outbox `add` so the two **commit together or not at all** — the
"transactional" in transactional outbox, which the in-memory reference models
(not just "in Postgres later"):

```ts
import { createOutboxRecord, runInTransaction } from '@signalman/outbox';

await runInTransaction(async (tx) => {
  await ledger.commit(entry, tx);                     // business state
  await outboxStore.add(                              // …and its event, atomically
    createOutboxRecord({
      aggregateType: 'ledger_entry',
      aggregateId: entry.id,
      eventType: 'ledger.committed',
      payload: { bookingId, amount },
    }),
    tx,
  );
});
```

All four producing legs wire exactly this — ledger (`commit`/`reverse`),
inventory (`hold`/`release`), payments (`authorize`/`capture`/`void`), and
supplier (`confirm`/`cancel`) — so none has a window where state committed but the
event was lost. Where a leg calls an external party (the PSP, the partner) that
call runs **before** the transaction, since it is the one side effect that cannot
roll back; inventory's oversell guard stays eager for the same reason, rolling the
unit of work back before anything commits. Maps onto one database transaction in
production; the in-memory unit of work buffers each enlisted write and applies
them together on commit.

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

The guarantee is **proven under crash** (`durability.spec.ts`): a staging
transaction that rolls back leaves no outbox row, so no phantom event ever
publishes; a committed row is still published when the relay crashes mid-publish
(the lease expires and a restarted relay re-claims it), so no event is lost; and
a crash between the broker accepting an event and the relay recording it
re-delivers rather than drops — the duplicate the idempotent inbox absorbs.

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

### `@signalman/broker`

The broker is the transport between the outbox and the inbox — the async-event
hop of the one-trace story. `MessageBroker` is the transport-agnostic boundary
(`publish` a message on its subject, `subscribe` a handler to subject patterns);
the rest of the system depends on it rather than on NATS or Kafka, so the
in-memory reference backs the tests and a single-process demo, and a JetStream
adapter slots in later behind the same interface.

`InMemoryBroker` is that reference. It models the semantics a real broker gives
the system: **subject matching** with NATS wildcards (`subjectMatches` — `*` for
one token, `>` for the tail), **fan-out** so every matching subscription gets its
own copy (with **queue groups** to load-balance a subject across members
instead), and **at-least-once delivery** — a handler that throws (NACK) is
redelivered up to `maxDeliver` attempts, then dead-lettered. Delivery is async
and decoupled from publish; `drain()` awaits quiescence for tests and graceful
shutdown.

Two thin adapters wire the broker to the libraries either side of it.
`BrokerPublisher` implements the outbox relay's `Publisher` over a broker
(`toBrokerMessage` maps a record's `eventType` to the subject and preserves the
trace-carrying headers), and `toConsumedMessage` turns a delivered
`BrokerMessage` into the inbox's `ConsumedMessage`. A service composes them in
one line, so at-least-once delivery and inbox dedup become effectively-once
processing on the booking trace:

```ts
import { InMemoryBroker, BrokerPublisher, toConsumedMessage } from '@signalman/broker';
import { OutboxRelay } from '@signalman/outbox';
import { IdempotentConsumer, InMemoryInboxStore } from '@signalman/inbox';

const broker = new InMemoryBroker();

// Producer side: the relay drains the outbox onto the broker.
const relay = new OutboxRelay({ store, publisher: new BrokerPublisher(broker), messagingSystem: 'memory' });
relay.start(250);

// Consumer side: each delivery flows through the idempotent inbox.
const consumer = new IdempotentConsumer({ store: new InMemoryInboxStore(), consumer: 'notifier' });
broker.subscribe('ledger.committed', (message) =>
  consumer.consume(toConsumedMessage(message), async () => notifyCustomer(message)).then(() => undefined),
);
```

Wired this way, a staged event's saga-step span, the relay's PRODUCER publish
span, and the inbox's CONSUMER consume span all hang off **one connected booking
trace** — the async half of "one booking = one trace", proven end to end in
[`libs/broker/src/trace-continuity.spec.ts`](libs/broker/src/trace-continuity.spec.ts).

#### NATS JetStream transport (`NatsBroker`)

`InMemoryBroker` is the reference; **`NatsBroker`** is the first *real* transport
behind the same `MessageBroker` boundary, so a service swaps it in without
touching the relay or its consumers:

```ts
import { NatsBroker, BrokerPublisher, toConsumedMessage } from '@signalman/broker';

// Connects, owns the connection, and provisions the durable stream.
const broker = await NatsBroker.connect({ connection: { servers: 'nats://localhost:4222' } });

const relay = new OutboxRelay({ store, publisher: new BrokerPublisher(broker), messagingSystem: 'nats' });
relay.start(250);

broker.subscribe('ledger.committed', (message) =>
  consumer.consume(toConsumedMessage(message), () => notifyCustomer(message)).then(() => undefined),
);
// await broker.close() on shutdown
```

It maps the reference semantics onto JetStream primitives. A publish lands in a
durable **stream** (the event survives a broker restart — the durability the
outbox assumes). Subject matching is JetStream's own NATS wildcards. **Fan-out**
is an *ephemeral* push consumer per subscriber (each gets its own copy); a
**queue group** is a shared *durable* consumer whose members load-balance the
subject. Delivery is **at-least-once**: the handler resolving `ack()`s the
message, throwing `nak()`s it for redelivery up to `maxDeliver` attempts, after
which it is `term()`-inated and surfaced to `onDeadLetter` — the same attempt
budget and dead-letter seam the reference models. The trace-carrying headers (and
the message id) round-trip across the wire, so the booking trace continues
through the broker.

`NatsBroker.create(connection, opts)` adapts a connection the caller owns;
`NatsBroker.connect(opts)` owns one and provisions the stream; `whenReady()`
awaits subscription establishment (closing the subscribe start-up race before the
first publish), and `close()` drains and tears down. The adapter is verified end
to end against a **live JetStream server** by a gated integration test
([`nats-broker.integration.spec.ts`](libs/broker/src/nats-broker.integration.spec.ts)),
which the default `npm test` skips so CI stays green without a broker:

```bash
nats-server -js                        # or: docker run --rm -p 4222:4222 nats -js
NATS_TEST_URL=nats://localhost:4222 npm test -- nats-broker.integration
```

It exercises fan-out, queue-group load-balancing, NACK redelivery, dead-lettering,
and the spec's headline async half — the saga step → JetStream publish → consume
spans on **one connected trace**, now with NATS in the middle.

#### Per-service wiring (`createBrokerFromEnv`, `OutboxRelayHost`, `BrokerSubscriptionHost`)

A producing service stages its events transactionally, but nothing leaves the
service until a relay drains those rows onto a broker; a consuming service needs the
mirror — a subscription that delivers each event to a handler. Three helpers make
that wiring uniform and env-driven, so the same code serves the unit suite, a
single-process demo, and the docker-compose stack:

```ts
import {
  createBrokerFromEnv,
  OutboxRelayHost,
  BrokerSubscriptionHost,
} from '@signalman/broker';

// Selected from the environment: the in-memory reference by default, the NATS
// JetStream adapter when BROKER=nats (servers from NATS_URL / NATS_SERVERS).
const broker = await createBrokerFromEnv();

// Producing side — drain the outbox onto the broker.
const relayHost = new OutboxRelayHost({
  store: outboxStore,            // the same outbox the service stages into
  broker: broker.broker,
  messagingSystem: broker.kind,  // 'memory' | 'nats' → the messaging.system attribute
  close: broker.close,           // drains/closes the transport on shutdown
});

// Consuming side — subscribe a handler to the events it reacts to.
const subscriptionHost = new BrokerSubscriptionHost({
  broker: broker.broker,
  subscriptions: [
    { subjects: 'ledger.committed', handler: (message) => consumer.consume(/* … */) },
  ],
  close: broker.close,           // a service uses one host's close, not both
});
```

`createBrokerFromEnv` reads `SIGNALMAN_BROKER`/`BROKER` (default `memory`,
case-insensitive, `nats` to opt in; an unrecognised value fails fast) and returns
the broker, its `kind`, and a `close`. `OutboxRelayHost` owns the relay's
lifecycle: it composes an `OutboxRelay` over the store and a `BrokerPublisher` on
the broker, **starts polling on `onApplicationBootstrap`**, and on
`onApplicationShutdown` **stops, flushes once, and closes the transport**.
`BrokerSubscriptionHost` is its consume-side mirror: it **establishes its
subscriptions on `onApplicationBootstrap`** and on `onApplicationShutdown` **drops
them and closes the transport**. The host owns subscription *lifecycle*, not consume
*semantics* — each handler is an ordinary broker handler, so one that throws NACKs
its message (route deliveries through the idempotent inbox for effectively-once).
Both hosts' method names match NestJS's lifecycle interfaces structurally, so the
library stays framework-agnostic while a service registers the host as a provider
and Nest drives it. All four producing legs register the relay host behind a
`MESSAGE_BROKER` token, and the **notifier registers the subscription host** —
subscribing its idempotent consumer to `ledger.committed`; each enables shutdown
hooks, so events flow on the booking trace. Set `BROKER=nats` (with the
docker-compose stack) for real cross-service delivery, or leave it unset for the
in-process default.

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
`inventory.released`) staged through `@signalman/outbox`, and the hold write and
its event are wrapped in `runInTransaction` so they **commit together or not at
all** — no hold without its event. The oversell guard stays eager, so a
would-oversell write rolls the unit of work back before anything commits. Every
gRPC handler is wrapped by `@signalman/interceptor`'s SERVER span — the inventory
hop of the booking trace — and the staged events continue from it, so the whole
leg hangs off one connected trace. The module registers an `OutboxRelayHost`
(§`@signalman/broker`) that drains those staged events onto the configured broker.
The in-memory hold and outbox stores are reference implementations; the
Postgres-backed stores land with the datastore milestone.

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
`payment.captured` / `payment.voided`) staged through `@signalman/outbox`, and
the payment write and its event are wrapped in `runInTransaction` so they
**commit together or not at all**. The PSP call runs **before** the transaction —
it is the one side effect that cannot roll back — so a rollback never leaves a
charged PSP without a recorded payment; a retried authorize replays it
idempotently. As with inventory, the module registers an `OutboxRelayHost` that
drains its staged events onto the configured broker; the in-memory payment and
outbox stores are reference implementations, and the Postgres-backed stores land
with the datastore milestone.

### `services/supplier`

The partner leg of the saga — the supplier **source of truth**. It owns partner
confirmations, and exposes the saga's synchronous supplier commands over gRPC
(`proto/supplier.proto`):

- `Confirm(bookingId, sku, qty)` books the reservation with the external partner.
  It is **idempotent per booking**: a retried confirmation returns the standing
  one rather than confirming twice.
- `Cancel(bookingId)` releases the confirmation — the saga **compensation**.
  Idempotent: cancelling an already-cancelled or unknown booking is a successful
  no-op, so a compensation can fire more than once.

Behind the service sits a **simulated external partner**, the source of truth the
spec calls out as *deliberately slow and flaky* — where divergence is born.
`SimulatedSupplierPartner` injects controllable latency and reject/failure
(`SUPPLIER_LATENCY_MS`, `SUPPLIER_REJECT_RATE`, `SUPPLIER_FAILURE_RATE`, with
slower/flakier defaults than the PSP), and wraps every call in a **CLIENT span** —
the partner boundary hop made visible in the booking trace. As with payments, the
service draws a sharp line between a partner **rejection** (a business "no",
returned as data with a reason) and a partner **outage** (a thrown error,
propagated so the gRPC SERVER span errors and the coordinator can retry the hop).

Each state change is paired with an outbox event (`supplier.confirmed` /
`supplier.cancelled`) staged through `@signalman/outbox`, and the confirmation
write and its event are wrapped in `runInTransaction` so they **commit together
or not at all**. The partner call runs **before** the transaction — the side
effect that cannot roll back — so a retried confirm replays it idempotently. The
module registers an `OutboxRelayHost` that drains its staged events onto the
configured broker; the in-memory confirmation and outbox stores are reference
implementations, and the Postgres-backed stores land with the datastore milestone.

### `services/ledger`

The financial-record leg of the saga — the ledger **source of truth**. It owns
the record of what actually happened financially, and exposes the saga's
synchronous ledger commands over gRPC (`proto/ledger.proto`):

- `Commit(bookingId, amount, currency, captureId)` posts the booking's money to
  the financial record — the saga's "commit to ledger" step, run after payments
  captures. It is **idempotent per booking**: a retried commit returns the
  standing entry rather than posting twice.
- `Reverse(bookingId)` backs the posting out — the saga **compensation**.
  Idempotent: reversing an already-reversed or unknown booking is a successful
  no-op, so a compensation can fire more than once.

Unlike the inventory, payments, and supplier legs, the ledger wraps **no external
boundary** — it is our own authoritative record, so a commit has no outage path.
Its only non-commit outcome is a business **rejection** (a non-positive amount,
returned as data with a reason). The `uint64 amount` field is decoded as a JS
number at the gRPC boundary (`loader: { longs: Number }`), so the amount the
ledger posts — and stages into its events — is the plain number its types
declare, ready for the reconciler to compare against the other sources of truth.

Each state change is paired with an outbox event (`ledger.committed` /
`ledger.reversed`) staged through `@signalman/outbox`, and the entry write and
its event are wrapped in `runInTransaction` so they **commit together or not at
all** — closing the dual-write window in the reference, not just "in Postgres
later." Every producing leg (inventory, payments, supplier, ledger) now stages
this way, each with a service test that pins the rollback: when the outbox `add`
throws, the state change rolls back with it. The module registers an
`OutboxRelayHost` that drains its staged events onto the configured broker; the
in-memory ledger and outbox stores are reference implementations, and the
Postgres-backed stores land with the datastore milestone.

### `services/coordinator`

The **saga orchestrator** — the coordinating heart of the system. It exposes one
synchronous command over gRPC (`proto/coordinator.proto`):

- `Book(bookingId, sku, qty, amount, currency)` drives the booking through five
  legs in order — `inventory.hold → payments.authorize → supplier.confirm →
  payments.capture → ledger.commit` — and returns either every leg's truth handle
  (hold/authorization/confirmation/capture/entry id) or the step that stopped the
  saga, its reason, and whether the completed steps were unwound.

The moment a leg **refuses** (a business "no", returned as data) or **fails** (an
outage, a thrown error) the saga unwinds the steps that already succeeded by
running their **compensations in reverse**: `supplier.cancel → payments.void →
inventory.release`. Each leg's compensation is idempotent, so the unwind is safe
to retry and a partial unwind still completes — a compensation that throws is
recorded and the rest still run. Idempotency is delegated to the legs (every
downstream command is keyed by `booking_id`), so a retried `Book` replays the
saga without double-booking.

Observability is the point, so the saga makes its shape visible: every forward
step and every compensation runs inside its own span, parented to the `Book`
SERVER span the interceptor opens — a rejection annotates its span with the
outcome and reason, an outage marks it errored, and a compensation span is
flagged so the unwind is legible at a glance. The orchestrator depends only on
four leg **ports**, so it is unit-tested end to end against in-memory fakes; in
production those ports are gRPC client adapters dialling the real services
(`INVENTORY_GRPC_URL`, `PAYMENTS_GRPC_URL`, `SUPPLIER_GRPC_URL`,
`LEDGER_GRPC_URL`). Those adapters now open a **CLIENT span** per RPC and inject
the booking's `traceparent` into the request metadata (`callWithTrace` /
`injectTraceMetadata`), so each leg's SERVER span continues this one trace —
the cross-service folding the trace-propagation milestone (M3) calls for, on the
synchronous gRPC hops. The async-event hop joins it once the broker lands.

### `services/notifier`

The async **tail** of the saga — the `… -> notify` step. Unlike the four legs the
notifier is not a synchronous gRPC participant; it is a pure **event consumer**.
When the booking reaches its financial terminal state it reacts to the
`ledger.committed` event off the broker and tells the customer.

- A `BrokerSubscriptionHost` (§`@signalman/broker`) subscribes the consumer to
  `ledger.committed` off the configured broker on application bootstrap, and drops
  the subscription and closes the transport on shutdown — the consume-side mirror of
  the producing legs' `OutboxRelayHost`, so the saga's tail is wired end to end over
  the broker.
- A `BookingNotificationConsumer` wraps `@signalman/inbox`'s `IdempotentConsumer`
  (dedup namespace `notifier`). It continues the booking's trace — the consume
  span is a CONSUMER child of the publisher's span, so the notification is on the
  *same* trace as the booking — and dedups by message id, so the broker's
  at-least-once delivery becomes effectively-once processing. A provider outage
  propagates out of the handler, so the broker NACKs and redelivers.
- A `NotifierService` does the work, **idempotently per booking**: a booking is
  notified at most once, so a second message about the same booking (a distinct
  id the inbox lets through) still sends nothing twice.

Behind it sits a **simulated notification provider** (`SimulatedNotificationChannel`)
— another external boundary, with controllable latency and failure
(`NOTIFIER_LATENCY_MS`, `NOTIFIER_FAILURE_RATE`) and every send wrapped in a
**CLIENT span**, the provider hop made visible on the booking trace. There is no
business "rejection" here: a send either succeeds or the provider is unreachable,
and an **outage** (a thrown error) propagates so the consumer NACKs and the broker
redelivers — nothing is recorded, so the redelivery genuinely retries. Being the
terminal consumer, the notifier keeps a notification source-of-truth record (a
fourth thing the reconciler can check — *was the customer actually told?*) but
stages no outbox event. The in-memory notification and inbox stores are reference
implementations; the Postgres-backed stores land with the datastore milestone,
behind the same DI tokens.

### `services/reconciler`

The **reconciler** — the spec's payoff. The failure mode that matters in this
system is not a crash, it is *silent divergence*: the supplier confirmed but the
ledger thinks it failed, or a hold was never released. The reconciler is the
backstop that catches it. Like the notifier it has no synchronous surface; it is a
periodic background job.

- A `ReconciliationScheduler` runs a pass on an interval (`RECONCILER_INTERVAL_MS`,
  default 30s) and never lets a single failed pass kill the loop — reconciliation
  must keep running precisely when something else is going wrong.
- Each pass pulls every *settled* booking from a `SourceOfTruthGateway` as a
  cross-source snapshot (what inventory, the supplier, and the ledger each report)
  and runs the pure `detectDivergences` engine over it. Three invariants:
  - **`supplier_confirmed_ledger_missing`** *(critical)* — the partner confirmed a
    booking with no committed financial record. The headline case.
  - **`ledger_committed_supplier_unconfirmed`** *(critical)* — the mirror: money
    posted for a booking the partner is not holding.
  - **`orphaned_hold`** *(warning)* — inventory still held for a booking that did
    not complete; the hold was never released.
- Each new disagreement becomes a `DivergenceFinding`, **idempotent per
  `(bookingId, kind)`** so a recurring drift is recorded once, not once per pass.

Observability is the point, so every finding is **linked back to the booking
trace**: the pass runs under a `reconcile.pass` span, and each new finding opens a
`reconcile.divergence` span that carries a **span link** to the originating
booking's trace context (and stamps the finding's `traceId`). From a divergence
you jump straight to the trace that explains how the booking got there — even
though the reconciler runs out-of-band on its own trace. Keeping liveness in the
gateway (it only emits bookings past a settle-grace window) lets the comparison
stay a pure function of the snapshot. The in-memory `SourceOfTruthGateway` and
findings store are reference implementations; the broker/Postgres-backed gateway
that subscribes to `inventory.*`/`supplier.*`/`ledger.*` to build the projection
lands with later milestones, behind the same DI tokens.

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

The gateway is the system's HTTP entry point — `POST /bookings` starts a booking
(and its trace), `GET /bookings/:id` reads the recorded outcome back. It dials the
coordinator at `COORDINATOR_GRPC_URL` (default `localhost:50050`), so a full
booking needs the coordinator and the four legs up too (see below); with the
coordinator down the call surfaces a `502`.

```bash
# Start a booking — booking_id is optional (the gateway mints one when omitted).
curl -X POST http://localhost:3000/bookings \
  -H 'content-type: application/json' \
  -d '{"sku":"seat-economy","qty":2,"amount":4200,"currency":"USD"}'
# 201 {"bookingId":"…","status":"booked","holdId":"…",…,"traceId":"…"}
# (a saga failure is also 201, with "status":"failed" and failedStep/reason)

# Read a booking's recorded outcome back.
curl http://localhost:3000/bookings/<booking_id>
# 200 {…} | 404 when the gateway has no record of that id
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

### Run the supplier service

```bash
npm run start:supplier          # boots the gRPC server on SUPPLIER_GRPC_URL
                                # (default 0.0.0.0:50053)
```

It registers the `signalman.supplier.v1.Supplier` service. The simulated
partner's behaviour is tunable via `SUPPLIER_LATENCY_MS`, `SUPPLIER_REJECT_RATE`,
and `SUPPLIER_FAILURE_RATE` — set them all to `0` for a deterministic,
always-confirming demo.

### Run the ledger service

```bash
npm run start:ledger            # boots the gRPC server on LEDGER_GRPC_URL
                                # (default 0.0.0.0:50054)
```

It registers the `signalman.ledger.v1.Ledger` service; drive it with any gRPC
client (e.g. `grpcurl`) against `proto/ledger.proto`. The ledger has no external
boundary to tune — a `Commit` with a positive amount always posts; a non-positive
amount is rejected as `invalid_amount`.

### Run the coordinator service

The coordinator is a gRPC **client** of the four legs and a gRPC **server** for
the gateway, so a booking needs all five processes up. In separate terminals
(disabling the simulated failures for a deterministic happy path):

```bash
PSP_DECLINE_RATE=0 PSP_FAILURE_RATE=0 npm run start:payments
SUPPLIER_REJECT_RATE=0 SUPPLIER_FAILURE_RATE=0 npm run start:supplier
npm run start:inventory
npm run start:ledger
npm run start:coordinator       # boots the gRPC server on COORDINATOR_GRPC_URL
                                # (default 0.0.0.0:50050)
```

It registers the `signalman.coordinator.v1.Coordinator` service. Drive a booking
with any gRPC client against `proto/coordinator.proto`:

```bash
grpcurl -plaintext -import-path services/coordinator/src/proto -proto coordinator.proto \
  -d '{"bookingId":"bk_1","sku":"seat-economy","qty":2,"amount":4200,"currency":"USD"}' \
  localhost:50050 signalman.coordinator.v1.Coordinator/Book
# { "booked": true, "holdId": "…", "authorizationId": "…", "confirmationId": "…",
#   "captureId": "…", "entryId": "…" }
```

A request that would oversell (`"qty": 1000000`) comes back
`{"booked": false, "failedStep": "inventory.hold", "reason": "insufficient_stock"}`
with nothing to compensate; a failure deeper in the saga returns
`compensated: true` after the completed legs unwind in reverse. Each leg's dial
address is overridable via `INVENTORY_GRPC_URL`, `PAYMENTS_GRPC_URL`,
`SUPPLIER_GRPC_URL`, and `LEDGER_GRPC_URL` so docker-compose can address services
by name.

### Run the notifier service

```bash
npm run start:notifier          # boots the consumer host; logs "notifier ready (subscribed to ledger.committed)"
BROKER=nats npm run start:notifier   # subscribe over the NATS JetStream transport
```

The notifier is a pure event consumer with no synchronous surface, so it boots as
an application context and stays resident awaiting messages. On bootstrap a
`BrokerSubscriptionHost` subscribes it to `ledger.committed` off the configured
broker (`createBrokerFromEnv` — the in-memory reference by default, NATS when
`BROKER=nats`); each delivery flows through the idempotent consumer
(consume-once, redelivery-safe, trace-continuing, NACK-on-outage). Under the
in-memory default each process owns its own broker, so real cross-service delivery
from the producing legs needs `BROKER=nats` (the docker-compose stack) so every
service shares one broker. Tune the simulated provider with `NOTIFIER_LATENCY_MS`
and `NOTIFIER_FAILURE_RATE`.

### Run the reconciler service

```bash
npm run start:reconciler        # boots the periodic job; logs "reconciler ready"
RECONCILER_INTERVAL_MS=5000 npm run start:reconciler   # reconcile every 5s
```

The reconciler is a periodic background job with no synchronous surface, so it
boots as an application context and runs a reconciliation pass on its interval (the
interval timer also keeps it resident). Its source gateway is the in-memory
reference until the broker/datastore-backed gateway lands, so passes find no
bookings for now — but the cadence, the comparison engine, and the trace-linked
findings are all live and exercised by the unit tests.

## Development

- **Tests** live next to the code as `*.spec.ts` and run under Jest + ts-jest.
- **Build** uses `nest build <project>`; output lands in `dist/`.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs install,
  lint, typecheck, build, and test on every push and pull request.
