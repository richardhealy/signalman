# Signalman — Documentation

> Observability and reconciliation for a distributed booking platform. Trace one
> booking end to end across synchronous gRPC and asynchronous events, and surface
> the moment the sources of truth diverge.

## Documentation index

| Document | What it covers |
|----------|----------------|
| **[API reference](api.md)** | HTTP and gRPC surface, the async event catalogue, and every environment variable |
| **[Architecture dossier](architecture.md)** | Component map, data/control flow, library internals, key design decisions |
| **[Integration guide](integration.md)** | Stand the system up, call it from another system, reuse the library patterns |

---

## How-to guides

Quick walkthroughs for the four most common tasks. Each links to the integration
guide for the full version with grpcurl examples and environment-variable tables.

### 1 · Trigger a booking and trace it end to end

**Requirements:** Docker + Docker Compose.

```bash
# Start the full stack (first run takes a few minutes; subsequent starts are fast).
docker-compose up

# In another terminal, trigger one booking.
curl -s -X POST http://localhost:3000/bookings \
  -H 'Content-Type: application/json' \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

The response includes a `traceId`:

```json
{
  "bookingId": "bk_01jzb...",
  "status": "booked",
  "holdId": "...",
  "authorizationId": "...",
  "confirmationId": "...",
  "captureId": "...",
  "entryId": "...",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Open Grafana at **[http://localhost:3001](http://localhost:3001)**, navigate to
**Explore → Tempo** (or the "Signalman — Booking Platform" dashboard), and paste
the `traceId` to browse the connected booking trace. You will see:

- The gateway `POST /bookings` SERVER span as the trace root.
- The coordinator `Book` SERVER span, with one child span per saga step.
- Each leg's gRPC CLIENT + SERVER span pair (inventory, payments, supplier, ledger).
- The simulated-PSP and simulated-partner CLIENT spans on the payments and supplier legs.
- The `ledger.committed` PRODUCER span (outbox relay publishing to NATS).
- A separate fan-out trace for the notifier's CONSUMER span and its notification CLIENT span.

See [Trigger a booking and read the trace](integration.md#3-trigger-a-booking-and-read-the-trace)
for the full walkthrough including grpcurl examples.

### 2 · Force a compensation path and observe it in the trace

Set the supplier to fail every booking, then trigger one. The coordinator reaches
the supplier step, gets an outage, and unwinds the completed steps in reverse.

```bash
# Restart the stack with the supplier failing every call.
SUPPLIER_FAILURE_RATE=1 docker-compose up

# Trigger a booking.
curl -s -X POST http://localhost:3000/bookings \
  -H 'Content-Type: application/json' \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

The response will have `"status":"failed"` and `"compensated":true`. In Tempo, the
booking trace shows:

```
Coordinator/Book [S]  signalman.saga.failed=true
├─ saga.inventory.hold ✓
├─ saga.payments.authorize ✓
├─ saga.supplier.confirm ✗   error.type=partner_outage
├─ saga.compensation.supplier.cancel   signalman.saga.compensation=true
├─ saga.compensation.payments.void     signalman.saga.compensation=true
└─ saga.compensation.inventory.release signalman.saga.compensation=true
```

See [Force a compensation path](integration.md#4-force-a-compensation-path) for
the full walkthrough.

### 3 · Induce and observe a reconciler divergence

Inject a divergence by having the supplier confirm a booking while the ledger
commit fails. Run the reconciler and watch it link the divergence back to the
booking trace.

```bash
# Fail every ledger commit (but let supplier confirm succeed).
LEDGER_FAILURE_RATE=1 docker-compose up

curl -s -X POST http://localhost:3000/bookings \
  -H 'Content-Type: application/json' \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
# -> status: failed, failedStep: ledger.commit
```

After the reconciler's next pass (interval controlled by `RECONCILER_INTERVAL_MS`,
default 30 s), Tempo shows a `reconcile.divergence` span on the reconciler's pass
trace that carries a **span link** back to the original booking trace:

```
reconcile.pass [S, reconciler]
└─ reconcile.divergence [S]
       kind=supplier_confirmed_ledger_missing
       booking.id=bk_abc123
       signalman.trace.link → <traceId of the original booking>
```

Clicking the link in Grafana Tempo navigates directly to the booking that explains
the divergence.

See [Induce and observe a reconciler divergence](integration.md#5-induce-and-observe-a-reconciler-divergence)
for the full walkthrough.

### 4 · Run without Docker (local development)

```bash
# Install dependencies once.
npm install

# In five separate terminals (or a tool such as tmux / foreman):
PSP_DECLINE_RATE=0 PSP_FAILURE_RATE=0 npm run start:payments
SUPPLIER_REJECT_RATE=0 SUPPLIER_FAILURE_RATE=0 npm run start:supplier
npm run start:inventory
npm run start:ledger
npm run start:coordinator

# In a sixth terminal:
npm start   # gateway on http://localhost:3000
```

All services default to in-memory stores and the in-memory broker, so no external
infrastructure is needed for a local walkthrough. Telemetry defaults to
`http://localhost:4318` — start an OTel Collector if you want to collect spans and
metrics; otherwise the exporters log a connection error and the services keep
running.

For the full per-service URLs, Postgres wiring, and NATS transport instructions,
see [Running without Docker](integration.md#8-running-without-docker).

---

## Key concepts

| Concept | Where to learn more |
|---------|---------------------|
| Saga orchestration and compensations | [Architecture § 3.1–3.2](architecture.md#31-happy-path-booking-saga) |
| Transactional outbox (dual-write closed) | [Architecture § 4.5](architecture.md#45-signalmanoutbox) |
| Idempotent inbox (effectively-once delivery) | [Architecture § 4.6](architecture.md#46-signalmaninbox) |
| Trace propagation across gRPC + async events | [Architecture § 6](architecture.md#6-observability-pipeline) |
| Fan-out span links (one event, many consumers) | [Architecture § 4.6](architecture.md#46-signalmaninbox) |
| Reconciler and divergence findings | [Architecture § 5.8](architecture.md#58-reconciler) |
| RED metrics and per-step SLOs in Grafana | [Architecture § 6](architecture.md#6-observability-pipeline) |
| Reusing the library patterns in your own services | [Integration guide § 9](integration.md#9-reusing-the-library-patterns) |

---

## Running the test suite

```bash
npm install
npm test          # 420+ assertions, 62 suites (3 gated integration suites skipped by default)
npm run lint      # ESLint flat config
npm run typecheck # tsc --noEmit across the workspace
npm run build     # nest build for all services and libs
```

The three skipped suites are gated integration tests that require live
infrastructure:

| Test file | Gate | Infrastructure |
|-----------|------|----------------|
| `libs/broker/src/nats-broker.integration.spec.ts` | `NATS_TEST_URL` | NATS JetStream (`nats-server -js`) |
| `libs/outbox/src/pg-store.integration.spec.ts` | `POSTGRES_TEST_URL` | PostgreSQL 16 |
| `services/gateway/src/bookings/pg-booking-store.integration.spec.ts` | `POSTGRES_TEST_URL` | PostgreSQL 16 |

Run them individually when the relevant infrastructure is available:

```bash
nats-server -js
NATS_TEST_URL=nats://localhost:4222 npm test -- nats-broker.integration

# Or for Postgres:
POSTGRES_TEST_URL=postgres://user:pass@localhost:5432/signalman npm test -- pg-store.integration
```
