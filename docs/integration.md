# Integration guide — signalman

> How to stand the system up, call it from another system, observe it end to end,
> and reuse the library patterns inside your own services.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [One-command demo stack](#2-one-command-demo-stack)
3. [Trigger a booking and read the trace](#3-trigger-a-booking-and-read-the-trace)
4. [Force a compensation path](#4-force-a-compensation-path)
5. [Induce and observe a reconciler divergence](#5-induce-and-observe-a-reconciler-divergence)
6. [Calling the gateway from your own code](#6-calling-the-gateway-from-your-own-code)
7. [Calling the gRPC services directly](#7-calling-the-gRPC-services-directly)
8. [Running without Docker](#8-running-without-docker)
9. [Reusing the library patterns](#9-reusing-the-library-patterns)
   - 9.1 [@signalman/otel — telemetry bootstrap](#91-signalmanotel--telemetry-bootstrap)
   - 9.2 [@signalman/logging — trace-correlated logs](#92-signalmanlogging--trace-correlated-logs)
   - 9.3 [@signalman/interceptor — per-handler spans + RED metrics](#93-signalmaninterceptor--per-handler-spans--red-metrics)
   - 9.4 [@signalman/outbox — transactional outbox](#94-signalmanoutbox--transactional-outbox)
   - 9.5 [@signalman/inbox — idempotent consumer](#95-signalmaninbox--idempotent-consumer)
   - 9.6 [@signalman/broker — the async-event hop](#96-signalmanbroker--the-async-event-hop)
10. [Environment variable reference](#10-environment-variable-reference)

---

## 1. Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Docker + Docker Compose | Docker 24+, Compose v2 | Required for the one-command demo stack |
| Node.js | 20+ | Required only for local development and running tests |
| `npm` | 10+ | Bundled with Node 20 |
| `grpcurl` | any | Optional — for calling gRPC services directly from the terminal |
| `jq` | any | Optional — formats the JSON responses in the examples below |

Clone the repository and you are ready to go:

```bash
git clone https://github.com/richardhealy/signalman
cd signalman
```

---

## 2. One-command demo stack

```bash
docker-compose up
```

This builds all eight services from the monorepo in a single Docker image and
starts the full infrastructure:

| Container | What it is | Exposed locally |
|-----------|-----------|-----------------|
| `postgres` | Postgres 16 — one instance, per-service schemas inside `signalman` db | `localhost:5432` |
| `nats` | NATS JetStream 2.10 — the event broker | `localhost:4222` (clients), `localhost:8222` (monitoring) |
| `otel-collector` | OTel Collector — receives OTLP, exports to Tempo + Prometheus | `localhost:4317` (gRPC), `localhost:4318` (HTTP), `localhost:8889` (Prometheus metrics) |
| `tempo` | Grafana Tempo 2.5 — the distributed trace backend | `localhost:3200` |
| `grafana` | Grafana 11 — dashboards, anonymous admin access | **`http://localhost:3001`** |
| `gateway` | HTTP entry point for bookings | **`http://localhost:3000`** |
| `coordinator` | gRPC saga orchestrator | `localhost:50050` |
| `inventory` | gRPC inventory service | `localhost:50051` |
| `payments` | gRPC payments service | `localhost:50052` |
| `supplier` | gRPC supplier service | `localhost:50053` |
| `ledger` | gRPC ledger service | `localhost:50054` |
| `notifier` | Async consumer — no external port | — |
| `reconciler` | Periodic background job — no external port | — |

The first build takes a few minutes as `npm install` and `npm run build` run
inside the image. Subsequent starts reuse the cached image and come up in
seconds. Wait until you see the gateway log line:

```
[signalman/gateway] Listening on port 3000
```

before sending your first request.

---

## 3. Trigger a booking and read the trace

### Trigger a booking

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

A successful booking returns `201` with `"status": "booked"`:

```json
{
  "bookingId": "01926a7e-f1d2-7000-b6e2-c8b7a9df1234",
  "status": "booked",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "holdId": "hold-abc",
  "authorizationId": "auth-xyz",
  "confirmationId": "conf-123",
  "captureId": "cap-456",
  "entryId": "entry-789"
}
```

The `traceId` is the W3C trace ID of the booking's root span. Copy it.

### Find the trace in Grafana

1. Open **[http://localhost:3001](http://localhost:3001)** — Grafana, anonymous
   Admin access, no login required.
2. Click **Explore** (compass icon in the left rail).
3. Make sure the datasource in the top-left is **Tempo**.
4. In the query row, set **Query type → TraceID**, paste the `traceId` from the
   response, and press **Run query**.

Grafana renders the connected booking trace: the gateway's `POST /bookings`
SERVER span is at the root, and every downstream gRPC leg and the async notifier
fan-out hang off it. See the [trace anatomy in README.md](../README.md#trace-anatomy)
for the full annotated span tree.

### View the RED dashboard

1. In Grafana, click **Dashboards** (grid icon) → **Signalman — Booking Platform**.
2. The dashboard has three rows:
   - **Booking saga — RED** — rate, error ratio, and latency across the whole saga.
   - **Per-service RED** — one panel per service, same three signals.
   - **Booking saga — per-step SLOs** — fourteen stat panels (one p99-latency + one
     error-rate per saga step), colour-coded green/yellow/red against per-step
     thresholds.
3. Click any red/yellow stat panel and then the trace exemplar link (the diamond
   icon) to jump from a metric data point directly to the originating trace in Tempo.

### Read a booking's status back

```bash
curl -s http://localhost:3000/bookings/<bookingId> | jq .
# Returns the recorded outcome: status, traceId, holdId, …
# 404 when the gateway has no record of that id.
```

---

## 4. Force a compensation path

The supplier service wraps a simulated external partner. You can configure it to
fail at a controlled rate, which causes the saga to unwind the completed steps.

**Set supplier failure rate to 100 %** via an environment override in
docker-compose:

```bash
docker-compose up -e SUPPLIER_FAILURE_RATE=1
```

Then trigger a booking:

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

The response will be `201` with `"status": "failed"`:

```json
{
  "bookingId": "01926a7e-f1d2-7000-b6e2-c8b7a9df5678",
  "status": "failed",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "3a99f37ddc47b843b26b82c28a5e1987",
  "recordedAt": "2026-06-30T12:00:05.000Z",
  "failedStep": "supplier.confirm",
  "reason": "partner_outage",
  "compensated": true
}
```

Paste the `traceId` into Grafana Tempo. You will see:
- `saga.supplier.confirm [S]` — the failing step, marked errored.
- `saga.compensation.supplier.cancel [S]` — marked with
  `signalman.saga.compensation=true`.
- `saga.compensation.payments.void [S]` — compensation.
- `saga.compensation.inventory.release [S]` — compensation.

All compensations appear under the same coordinator `Book` SERVER span, so the
entire unwind is in one connected trace.

Other injectable failure knobs (all default to `0`, meaning no injection):

| Env var | What it injects |
|---------|----------------|
| `SUPPLIER_REJECT_RATE` | Probability (0–1) the supplier returns a business rejection (`no_availability`). |
| `SUPPLIER_FAILURE_RATE` | Probability (0–1) the supplier throws an outage error. |
| `SUPPLIER_LATENCY_MS` | Fixed extra latency added to every supplier call (ms). |
| `PSP_DECLINE_RATE` | Probability (0–1) the PSP declines the authorization (`card_declined`). |
| `PSP_FAILURE_RATE` | Probability (0–1) the PSP throws an outage error. |
| `PSP_LATENCY_MS` | Fixed extra latency added to every PSP call (ms). |
| `NOTIFIER_FAILURE_RATE` | Probability (0–1) the notification provider throws an outage error. |
| `NOTIFIER_LATENCY_MS` | Fixed extra latency added to every notification call (ms). |

---

## 5. Induce and observe a reconciler divergence

A divergence occurs when the sources of truth disagree: for example, the supplier
confirmed a booking but the ledger has no committed record (the headline case the
spec is built around).

The simplest way to induce this in the demo stack is to configure the ledger to
reject commits while the supplier still confirms. Since the coordinator runs
`supplier.confirm` before `payments.capture → ledger.commit`, a ledger rejection
triggers a compensation — but if you force the compensation to also fail (by
restarting services out of order while mid-saga), you can leave the supplier
confirmed and the ledger empty.

For a **deterministic divergence without chaos**, you can seed the reconciler's
in-memory snapshot directly in a unit test — see
`services/reconciler/src/reconciliation/reconciler.spec.ts` — or drive it
through the broker-backed gateway by publishing `supplier.confirmed` and
withholding `ledger.committed` in an integration test.

Once a divergence is recorded, the reconciler emits a `reconcile.divergence` span:

```bash
# Check the reconciler logs for a finding:
docker-compose logs reconciler | grep divergence
# reconciler: divergence found { bookingId: 'bk_abc', kind: 'supplier_confirmed_ledger_missing', traceId: '…' }
```

In Grafana Tempo, query the service name `reconciler` in the **Search** tab.
You'll find a `reconcile.pass` trace containing a `reconcile.divergence` span.
Click the span link inside that span — Tempo navigates directly to the originating
booking trace, the one whose saga left the sources of truth in disagreement.

The reconciler's settle-grace window (`RECONCILER_SETTLE_GRACE_MS`, default
`5000` ms) means a booking must be "quiet" for that long before it is eligible
for reconciliation. In tests you can set it to `0`:

```bash
RECONCILER_SETTLE_GRACE_MS=0 npm run start:reconciler
```

---

## 6. Calling the gateway from your own code

The gateway is the only service with a public HTTP surface. All booking operations
go through it.

### Start a booking

```
POST http://localhost:3000/bookings
Content-Type: application/json
```

**Request body:**

```json
{
  "sku": "ECO",
  "qty": 1,
  "amount": 9900,
  "currency": "USD",
  "bookingId": "my-idempotency-key-uuid"
}
```

`bookingId` is optional. When omitted the gateway mints a UUID. Pass a stable key
to make the call **idempotent** across retries — a second `POST` with the same key
overwrites the previous recorded outcome, so a retried success is safe.

**On success** (`201 Created`, `status: "booked"`):

```json
{
  "bookingId": "my-idempotency-key-uuid",
  "status": "booked",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "holdId": "hold-abc",
  "authorizationId": "auth-xyz",
  "confirmationId": "conf-123",
  "captureId": "cap-456",
  "entryId": "entry-789"
}
```

**On a saga business failure** (`201 Created`, `status: "failed"`):

```json
{
  "bookingId": "my-idempotency-key-uuid",
  "status": "failed",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "3a99f37ddc47b843b26b82c28a5e1987",
  "recordedAt": "2026-06-30T12:00:05.000Z",
  "failedStep": "supplier.confirm",
  "reason": "no_availability",
  "compensated": true
}
```

Note that a saga business failure is `201`, not `4xx` — the booking attempt was
processed and recorded, it just didn't succeed. Use the `status` field to
distinguish success from failure. A `400` means the request body is invalid; a
`502` means the coordinator is unreachable.

**Example — Node.js `fetch`:**

```ts
const response = await fetch('http://localhost:3000/bookings', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sku: 'ECO', qty: 1, amount: 9900, currency: 'USD' }),
});
const booking = await response.json();

if (booking.status === 'booked') {
  console.log('Booking confirmed, trace:', booking.traceId);
} else {
  console.error('Saga failed at', booking.failedStep, '—', booking.reason);
}
```

**Propagating the trace into your own service:**

The gateway's response includes `traceId`. If you want your caller's trace to
join the booking trace, propagate the W3C `traceparent` header on the request:

```ts
// Your service has an active OTel span. Inject its context into the request.
import { propagation, context } from '@opentelemetry/api';

const headers: Record<string, string> = {
  'Content-Type': 'application/json',
};
propagation.inject(context.active(), headers);

await fetch('http://localhost:3000/bookings', { method: 'POST', headers, body: … });
```

The gateway's interceptor will extract the `traceparent` and make the booking's
root SERVER span a child of your span, so your trace and the booking trace are
one connected chain.

### Read a booking's status

```
GET http://localhost:3000/bookings/:bookingId
```

Returns the same shape as `POST /bookings`. Returns `404` when the gateway has no
record of that id. Use this to poll for the result of a booking without
re-triggering the saga, or to retrieve the `traceId` for an in-flight booking.

### Health check

```
GET http://localhost:3000/health
```

```json
{ "status": "ok", "service": "gateway" }
```

Useful as a readiness probe. Returns `200` when the service is running; does not
check downstream connectivity (the gateway stays healthy even when the
coordinator is down — the `POST /bookings` surface surfaces a `502` in that case).

---

## 7. Calling the gRPC services directly

The internal gRPC services use proto definitions in the `proto/` directory at the
monorepo root. All services run without TLS in this configuration (plaintext
gRPC).

### Prerequisites

Install `grpcurl` for ad-hoc calls:

```bash
brew install grpcurl        # macOS
go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest  # other
```

### Coordinator — Book

```bash
grpcurl -plaintext \
  -import-path proto -proto coordinator.proto \
  -d '{"bookingId":"bk-1","sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' \
  localhost:50050 signalman.coordinator.v1.Coordinator/Book
```

A successful booking:

```json
{
  "booked": true,
  "holdId": "hold-abc",
  "authorizationId": "auth-xyz",
  "confirmationId": "conf-123",
  "captureId": "cap-456",
  "entryId": "entry-789"
}
```

A failed booking (for example, insufficient stock):

```json
{
  "booked": false,
  "failedStep": "inventory.hold",
  "reason": "insufficient_stock",
  "compensated": false
}
```

### Inventory — Hold / Release

```bash
# Hold 2 units of SKU-A for booking bk-2
grpcurl -plaintext \
  -import-path proto -proto inventory.proto \
  -d '{"bookingId":"bk-2","sku":"SKU-A","qty":2}' \
  localhost:50051 signalman.inventory.v1.Inventory/Hold

# Release the hold for booking bk-2
grpcurl -plaintext \
  -import-path proto -proto inventory.proto \
  -d '{"bookingId":"bk-2"}' \
  localhost:50051 signalman.inventory.v1.Inventory/Release
```

### Payments — Authorize / Capture / Void

```bash
# Authorize $99.00 for booking bk-2
grpcurl -plaintext \
  -import-path proto -proto payments.proto \
  -d '{"bookingId":"bk-2","amount":9900,"currency":"USD"}' \
  localhost:50052 signalman.payments.v1.Payments/Authorize

# Capture the authorization
grpcurl -plaintext \
  -import-path proto -proto payments.proto \
  -d '{"bookingId":"bk-2"}' \
  localhost:50052 signalman.payments.v1.Payments/Capture

# Void the authorization (compensation)
grpcurl -plaintext \
  -import-path proto -proto payments.proto \
  -d '{"bookingId":"bk-2"}' \
  localhost:50052 signalman.payments.v1.Payments/Void
```

### Supplier — Confirm / Cancel

```bash
grpcurl -plaintext \
  -import-path proto -proto supplier.proto \
  -d '{"bookingId":"bk-2","sku":"ECO","qty":1}' \
  localhost:50053 signalman.supplier.v1.Supplier/Confirm

grpcurl -plaintext \
  -import-path proto -proto supplier.proto \
  -d '{"bookingId":"bk-2"}' \
  localhost:50053 signalman.supplier.v1.Supplier/Cancel
```

### Ledger — Commit / Reverse

```bash
grpcurl -plaintext \
  -import-path proto -proto ledger.proto \
  -d '{"bookingId":"bk-2","amount":9900,"currency":"USD","captureId":"cap-456"}' \
  localhost:50054 signalman.ledger.v1.Ledger/Commit

grpcurl -plaintext \
  -import-path proto -proto ledger.proto \
  -d '{"bookingId":"bk-2"}' \
  localhost:50054 signalman.ledger.v1.Ledger/Reverse
```

All RPCs are **idempotent per booking**: a retry on any RPC returns the standing
result for that `bookingId` rather than duplicating the operation. A leg's
compensation (`Release`, `Void`, `Cancel`, `Reverse`) is a no-op when the
operation was never performed or has already been compensated.

---

## 8. Running without Docker

For local development or running individual services, use the npm scripts
directly. Node 20+ is required.

```bash
npm install        # install all dependencies
npm run build      # compile all projects into dist/
npm test           # run the full suite (420+ assertions, 62 suites, ~30s)
npm run lint       # eslint across all services and libs
npm run typecheck  # tsc --noEmit across the workspace
```

### Start all services in separate terminals

Disable the simulated failures for a deterministic happy path:

```bash
# Terminal 1 — inventory
npm run start:inventory

# Terminal 2 — payments (failure injection off)
PSP_DECLINE_RATE=0 PSP_FAILURE_RATE=0 npm run start:payments

# Terminal 3 — supplier (failure injection off)
SUPPLIER_REJECT_RATE=0 SUPPLIER_FAILURE_RATE=0 npm run start:supplier

# Terminal 4 — ledger
npm run start:ledger

# Terminal 5 — coordinator (dials the four legs above)
npm run start:coordinator

# Terminal 6 — gateway (dials the coordinator)
npm run start

# Terminal 7 — notifier (event consumer, in-memory broker)
npm run start:notifier

# Terminal 8 — reconciler (periodic job, in-memory broker)
npm run start:reconciler
```

Under the in-memory broker (the default when `BROKER` is unset), each process
owns its own in-memory broker instance — so the notifier and reconciler will not
receive events published by the producing legs. For real cross-service event
delivery without Docker, run a local NATS server and set `BROKER=nats`:

```bash
# Start NATS JetStream locally (requires nats-server)
nats-server -js

# Then start all services with the real broker
BROKER=nats NATS_URL=nats://localhost:4222 npm run start:notifier
BROKER=nats NATS_URL=nats://localhost:4222 npm run start:reconciler
# (and the producing legs too, same env vars)
```

### Telemetry without the Collector

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (the default outside Docker), traces
and metrics export to `http://localhost:4318` — which goes nowhere if the
Collector is not running. The SDK logs a warning and the service continues
normally; no spans are lost, they just do not reach Tempo. To suppress the noise:

```bash
OTEL_SDK_DISABLED=true npm run start:gateway
```

Or start just the Collector with Docker while running services locally:

```bash
docker-compose up otel-collector tempo grafana
```

This starts only the observability tier; then point the local services at it with
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

---

## 9. Reusing the library patterns

The seven libraries under `libs/` encapsulate the patterns that make this system
work. They are framework-agnostic at the core; NestJS is an integration detail
(the `ObservabilityModule` wiring, the lifecycle host method names) that each
library keeps as thin as possible. Import them by path alias:
`@signalman/otel`, `@signalman/propagation`, `@signalman/logging`,
`@signalman/interceptor`, `@signalman/outbox`, `@signalman/inbox`,
`@signalman/broker`.

### 9.1 `@signalman/otel` — telemetry bootstrap

Call `startTelemetry` once, before any application module loads. The
OpenTelemetry SDK must be active before the instrumentation patches land:

```ts
import { startTelemetry } from '@signalman/otel';

startTelemetry({ serviceName: 'my-service', serviceVersion: '1.0.0' });

// Now start your NestJS app
const app = await NestFactory.create(AppModule);
await app.listen(3000);
```

`startTelemetry` reads the standard OTel environment variables. The two most
important ones:

| Env var | Default | Purpose |
|---------|---------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export target (set to the Collector address in production). |
| `OTEL_SERVICE_NAME` | the `serviceName` argument | Overrides the service name in the resource. |

The returned handle flushes telemetry on `SIGTERM`/`SIGINT`. In practice you do
not need to hold it; the signal handlers are registered as a side effect.

After `startTelemetry`, use the standard OTel API (`@opentelemetry/api`) for
custom spans and attributes:

```ts
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

const span = tracer.startSpan('my.operation', {}, context.active());
try {
  await doWork();
  span.setStatus({ code: SpanStatusCode.OK });
} catch (err) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
  span.recordException(err);
  throw err;
} finally {
  span.end();
}
```

### 9.2 `@signalman/logging` — trace-correlated logs

```ts
import { createLogger } from '@signalman/logging';

const logger = createLogger({ service: 'my-service', context: 'BookingFlow' });
logger.log('booking started', { bookingId: 'bk-1', sku: 'ECO' });
// {"timestamp":"…","level":"log","service":"my-service","context":"BookingFlow",
//  "message":"booking started","trace_id":"4bf92f35…","span_id":"a3ce929d…",
//  "trace_flags":"01","bookingId":"bk-1","sku":"ECO"}
```

The `trace_id`/`span_id`/`trace_flags` fields come from the active span at the
time of the log call. In Grafana Loki you can filter by `trace_id` to pull all
logs for a booking, or click a log line's trace ID to jump straight to the span
in Tempo.

Wire it as the NestJS logger so framework messages (bootstrap, errors) go through
the same pipeline:

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(createLogger({ service: 'my-service' }));
```

`logger.child({ bookingId: 'bk-1' })` returns a bound logger that attaches
`bookingId` to every subsequent log line — useful for a unit-of-work context.

### 9.3 `@signalman/interceptor` — per-handler spans + RED metrics

Import `ObservabilityModule.forRoot` in your root module. Every inbound handler —
HTTP or gRPC — is then wrapped automatically:

```ts
import { ObservabilityModule } from '@signalman/interceptor';

@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'my-service' })],
})
export class AppModule {}
```

This registers a global NestJS interceptor that:
- Opens a SERVER span for each handler, kept active during the call so any span
  the handler opens becomes a child.
- Records `signalman.operation.duration` (histogram — rate and latency) and
  `signalman.operation.errors` (counter) tagged by `operation`/transport/`outcome`.
- Maps HTTP context onto OTel HTTP semconv and gRPC context onto OTel RPC semconv.
- For inbound gRPC, lifts the upstream `traceparent` from the request metadata
  so the SERVER span **continues** the caller's trace (instead of starting an
  orphan). For inbound HTTP at the gateway, lifts the `traceparent` from HTTP
  headers if present.

To limit the interceptor to specific handlers instead of registering it globally,
pass `global: false` and use `@UseInterceptors` selectively:

```ts
ObservabilityModule.forRoot({ scope: 'my-service', global: false })
// Then in a controller:
@UseInterceptors(ObservabilityInterceptor)
```

The metrics land in your OTel metric pipeline and are exported by the Collector
to Prometheus. The Grafana dashboard panels read the two metric names directly;
if you instrument your own services the same way, the same panels and SLO
thresholds apply with no dashboard edits.

### 9.4 `@signalman/outbox` — transactional outbox

The outbox defeats the dual-write problem: the business state write and the
outbox row commit together, so events publish if and only if the state change
committed — no lost events on a service crash, no phantom events from a rolled-back
transaction.

**Stage an event inside a transaction:**

```ts
import { createOutboxRecord, runInTransaction } from '@signalman/outbox';
import { InMemoryOutboxStore } from '@signalman/outbox';

const outboxStore = new InMemoryOutboxStore();

await runInTransaction(async (tx) => {
  await myRepository.save(entity, tx);           // business state
  await outboxStore.add(                         // …and its event, atomically
    createOutboxRecord({
      aggregateType: 'my_entity',
      aggregateId: entity.id,
      eventType: 'my.entity.created',
      payload: { id: entity.id, name: entity.name },
    }),
    tx,
  );
});
```

`createOutboxRecord` captures the active OTel trace context into the record's
headers, so the relay later publishes the event as a PRODUCER span parented to
the span that was active when the record was staged — the async-event hop joins
the same booking trace.

**Run the relay to drain staged events onto the broker:**

```ts
import { OutboxRelay } from '@signalman/outbox';
import { BrokerPublisher } from '@signalman/broker';

const relay = new OutboxRelay({
  store: outboxStore,
  publisher: new BrokerPublisher(broker),
  messagingSystem: 'nats',           // or 'memory' — becomes messaging.system attribute
});

relay.start(250);     // poll every 250ms
// On shutdown: relay.stop(); await relay.flush()
```

For **Postgres-backed durability**, swap in `PostgresOutboxStore` and
`runInPgTransaction` — same interface, real database:

```ts
import { PostgresOutboxStore, runInPgTransaction } from '@signalman/outbox';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
const outboxStore = new PostgresOutboxStore(pool, { schema: 'my_service' });
await outboxStore.ensureSchema();  // creates the table on first boot

await runInPgTransaction(pool, async (tx) => {
  await myRepository.save(entity, tx);
  await outboxStore.add(createOutboxRecord({ … }), tx);
});
```

The Postgres store uses `SELECT … FOR UPDATE SKIP LOCKED` for safe concurrent
relay instances (multiple relay processes claiming rows without collision), and
dead-letters rows after a configurable attempt budget.

### 9.5 `@signalman/inbox` — idempotent consumer

The inbox is the other half of effectively-once delivery. It wraps a handler,
deduplicates by message id, and opens a CONSUMER span continuing the publisher's
trace:

```ts
import { IdempotentConsumer, InMemoryInboxStore } from '@signalman/inbox';

const consumer = new IdempotentConsumer({
  store: new InMemoryInboxStore(),
  consumer: 'my-consumer',           // dedup namespace — use one per logical consumer
  messagingSystem: 'nats',
});

// Hand each delivered message to the consumer:
const { status } = await consumer.consume(
  {
    messageId: message.id,           // the unique id the outbox assigned
    eventType: message.subject,
    headers: message.headers,        // carries the traceparent
  },
  async () => {
    // This runs at most once per messageId.
    await processEvent(message.payload);
  },
);
// status: 'processed' on first delivery, 'duplicate' on a redelivery
```

For fan-out (multiple consumers subscribing to the same event), pass
`fanOut: true`. The consumer then opens a new root trace and carries a span link
back to the PRODUCER span, so each consumer's trace is independent but navigable
to the source event:

```ts
const consumer = new IdempotentConsumer({
  store: new InMemoryInboxStore(),
  consumer: 'notifier',
  messagingSystem: 'nats',
  fanOut: true,   // opens a new root trace with a link to the producer
});
```

For **Postgres-backed dedup**, swap in `PostgresInboxStore` — the
`INSERT … ON CONFLICT DO NOTHING` marker commits in the same transaction as the
handler's side effects, so the dedup is race-free under concurrent redelivery:

```ts
import { PostgresInboxStore } from '@signalman/inbox';

const inboxStore = new PostgresInboxStore(pool, { schema: 'my_service' });
await inboxStore.ensureSchema();

const consumer = new IdempotentConsumer({ store: inboxStore, consumer: 'notifier' });
```

### 9.6 `@signalman/broker` — the async-event hop

`MessageBroker` is the transport-agnostic boundary between the outbox and the
inbox. Import the in-memory reference for tests and single-process demos; swap in
`NatsBroker` for real cross-service delivery.

**In-memory reference (tests and single-process demos):**

```ts
import {
  InMemoryBroker,
  BrokerPublisher,
  toConsumedMessage,
} from '@signalman/broker';
import { OutboxRelay } from '@signalman/outbox';
import { IdempotentConsumer, InMemoryInboxStore } from '@signalman/inbox';

const broker = new InMemoryBroker();

// Producer side
const relay = new OutboxRelay({
  store: outboxStore,
  publisher: new BrokerPublisher(broker),
  messagingSystem: 'memory',
});
relay.start(250);

// Consumer side
const consumer = new IdempotentConsumer({
  store: new InMemoryInboxStore(),
  consumer: 'notifier',
});
broker.subscribe('ledger.committed', (message) =>
  consumer
    .consume(toConsumedMessage(message), () => handleEvent(message))
    .then(() => undefined),
);
```

Subjects follow NATS wildcard conventions: `*` matches one token (`ledger.*`
matches `ledger.committed` and `ledger.reversed`), and `>` matches the remaining
tail (`inventory.>` matches any `inventory.*`).

**NATS JetStream (production):**

```ts
import { NatsBroker } from '@signalman/broker';

const broker = await NatsBroker.connect({
  connection: { servers: process.env.NATS_URL ?? 'nats://localhost:4222' },
  stream: { name: 'signalman', subjects: ['inventory.>', 'supplier.>', 'ledger.>'] },
});

// Wait for all subscriptions to be established before the first publish:
await broker.whenReady();

// Swap it in anywhere a MessageBroker is expected — the relay and consumer
// code is identical to the in-memory version above.

// On shutdown:
await broker.close();
```

**Env-driven transport selection (per-service wiring):**

`createBrokerFromEnv` reads `BROKER` and returns the appropriate transport, so
the same service code works in all environments:

```ts
import {
  createBrokerFromEnv,
  OutboxRelayHost,
  BrokerSubscriptionHost,
} from '@signalman/broker';

const { broker, kind, close } = await createBrokerFromEnv();
// BROKER unset → { broker: InMemoryBroker, kind: 'memory', close: () => {} }
// BROKER=nats  → { broker: NatsBroker, kind: 'nats', close: broker.close }

// Register with NestJS lifecycle (producing service):
const relayHost = new OutboxRelayHost({
  store: outboxStore,
  broker,
  messagingSystem: kind,
  close,
});
// NestJS calls relayHost.onApplicationBootstrap() / onApplicationShutdown()
// as a lifecycle provider.

// Or for a consuming service:
const subscriptionHost = new BrokerSubscriptionHost({
  broker,
  subscriptions: [
    {
      subjects: 'ledger.committed',
      handler: (msg) =>
        consumer.consume(toConsumedMessage(msg), () => handleEvent(msg)).then(() => undefined),
    },
  ],
  close,
});
```

Set `BROKER=nats` (and `NATS_URL=nats://localhost:4222`) to switch to the real
transport. The rest of the service code is unchanged.

---

## 10. Environment variable reference

### Gateway (`services/gateway`)

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | HTTP listen port. |
| `COORDINATOR_GRPC_URL` | `localhost:50050` | Address of the coordinator gRPC server. |
| `POSTGRES_URL` | — | PostgreSQL connection string. When set, activates the Postgres-backed booking store. Falls back to in-memory when absent. |

### Coordinator (`services/coordinator`)

| Env var | Default | Description |
|---------|---------|-------------|
| `COORDINATOR_GRPC_URL` | `0.0.0.0:50050` | Bind address for the coordinator's gRPC server. |
| `INVENTORY_GRPC_URL` | `localhost:50051` | Address of the inventory leg. |
| `PAYMENTS_GRPC_URL` | `localhost:50052` | Address of the payments leg. |
| `SUPPLIER_GRPC_URL` | `localhost:50053` | Address of the supplier leg. |
| `LEDGER_GRPC_URL` | `localhost:50054` | Address of the ledger leg. |

### Inventory (`services/inventory`)

| Env var | Default | Description |
|---------|---------|-------------|
| `INVENTORY_GRPC_URL` | `0.0.0.0:50051` | Bind address for the gRPC server. |
| `BROKER` | `memory` | Broker transport: `memory` (in-process reference) or `nats` (JetStream). |
| `NATS_URL` | `nats://localhost:4222` | NATS server address(es). Used when `BROKER=nats`. |
| `POSTGRES_URL` | — | PostgreSQL connection string. When set, activates the Postgres-backed hold repository and outbox store. |

### Payments (`services/payments`)

| Env var | Default | Description |
|---------|---------|-------------|
| `PAYMENTS_GRPC_URL` | `0.0.0.0:50052` | Bind address for the gRPC server. |
| `PSP_LATENCY_MS` | `0` | Fixed latency added to every PSP call (ms). |
| `PSP_DECLINE_RATE` | `0` | Probability (0–1) the PSP declines the authorization. |
| `PSP_FAILURE_RATE` | `0` | Probability (0–1) the PSP throws an outage error. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server address(es). |
| `POSTGRES_URL` | — | PostgreSQL connection string. |

### Supplier (`services/supplier`)

| Env var | Default | Description |
|---------|---------|-------------|
| `SUPPLIER_GRPC_URL` | `0.0.0.0:50053` | Bind address for the gRPC server. |
| `SUPPLIER_LATENCY_MS` | `50` | Fixed latency added to every partner call (ms). |
| `SUPPLIER_REJECT_RATE` | `0.05` | Probability (0–1) the partner returns a business rejection. |
| `SUPPLIER_FAILURE_RATE` | `0.02` | Probability (0–1) the partner throws an outage error. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server address(es). |
| `POSTGRES_URL` | — | PostgreSQL connection string. |

### Ledger (`services/ledger`)

| Env var | Default | Description |
|---------|---------|-------------|
| `LEDGER_GRPC_URL` | `0.0.0.0:50054` | Bind address for the gRPC server. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server address(es). |
| `POSTGRES_URL` | — | PostgreSQL connection string. |

### Notifier (`services/notifier`)

| Env var | Default | Description |
|---------|---------|-------------|
| `NOTIFIER_LATENCY_MS` | `0` | Fixed latency added to every notification provider call (ms). |
| `NOTIFIER_FAILURE_RATE` | `0` | Probability (0–1) the notification provider throws an outage error. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server address(es). |
| `POSTGRES_URL` | — | PostgreSQL connection string. |

### Reconciler (`services/reconciler`)

| Env var | Default | Description |
|---------|---------|-------------|
| `RECONCILER_INTERVAL_MS` | `30000` | How often to run a reconciliation pass (ms). |
| `RECONCILER_SETTLE_GRACE_MS` | `5000` | A booking must be "quiet" for this long (no new source events) before it is eligible for reconciliation (ms). Set to `0` in tests for immediate eligibility. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server address(es). |
| `POSTGRES_URL` | — | PostgreSQL connection string. |

### Shared OTel variables (all services)

| Env var | Default | Description |
|---------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint (point at the Collector). |
| `OTEL_SERVICE_NAME` | (set by `startTelemetry`) | Overrides the service name in the OTel resource. |
| `OTEL_SDK_DISABLED` | — | Set to `true` to disable the OTel SDK entirely (no spans, no metrics, no warnings about a missing Collector). |
