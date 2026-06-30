# Signalman — Integration Guide

How to stand the system up, configure it, and call it from another system, with
concrete runnable examples for every integration surface.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [One-command demo stack](#2-one-command-demo-stack)
   - 2.1 [What comes up](#21-what-comes-up)
   - 2.2 [First booking](#22-first-booking)
   - 2.3 [Viewing the trace](#23-viewing-the-trace)
   - 2.4 [Tearing down](#24-tearing-down)
3. [Local development (no Docker)](#3-local-development-no-docker)
   - 3.1 [Start the full saga stack](#31-start-the-full-saga-stack)
   - 3.2 [Start only the gateway](#32-start-only-the-gateway)
4. [HTTP API — gateway](#4-http-api--gateway)
   - 4.1 [Start a booking](#41-start-a-booking)
   - 4.2 [Read a booking](#42-read-a-booking)
   - 4.3 [Health probe](#43-health-probe)
   - 4.4 [Error responses](#44-error-responses)
5. [gRPC — calling services directly](#5-grpc--calling-services-directly)
   - 5.1 [Coordinator.Book](#51-coordinatorbook)
   - 5.2 [Inventory — Hold / Release](#52-inventory--hold--release)
   - 5.3 [Payments — Authorize / Capture / Void](#53-payments--authorize--capture--void)
   - 5.4 [Supplier — Confirm / Cancel](#54-supplier--confirm--cancel)
   - 5.5 [Ledger — Commit / Reverse](#55-ledger--commit--reverse)
6. [Async events — the broker surface](#6-async-events--the-broker-surface)
7. [Inducing failures and compensations](#7-inducing-failures-and-compensations)
   - 7.1 [Force a supplier failure](#71-force-a-supplier-failure)
   - 7.2 [Force a PSP decline](#72-force-a-psp-decline)
   - 7.3 [Induce reconciler divergence](#73-induce-reconciler-divergence)
8. [Plugging in your own observability backend](#8-plugging-in-your-own-observability-backend)
9. [Connecting to an external NATS cluster](#9-connecting-to-an-external-nats-cluster)
10. [Connecting to an external Postgres instance](#10-connecting-to-an-external-postgres-instance)
11. [Environment variable reference](#11-environment-variable-reference)

---

## 1. Prerequisites

| Tool | Minimum version | Purpose |
|------|----------------|---------|
| Docker + Docker Compose | Docker 24, Compose v2 | One-command demo stack |
| Node.js | 20 | Local development |
| `grpcurl` | any | gRPC examples in this guide (optional) |
| `jq` | any | Pretty-printing JSON in the examples (optional) |

Node version is pinned in `.nvmrc`; `nvm use` sets it automatically.

---

## 2. One-command demo stack

```bash
git clone https://github.com/richardhealy/signalman
cd signalman
docker-compose up
```

The first run builds all services from source (one monorepo Dockerfile). Subsequent
starts skip the build and are fast.

### 2.1 What comes up

| Service | Address | Description |
|---------|---------|-------------|
| gateway (HTTP) | `http://localhost:3000` | Public booking entry point |
| Grafana | `http://localhost:3001` | Pre-provisioned dashboards + Tempo explore |
| NATS JetStream | `nats://localhost:4222` | Event broker |
| NATS monitoring | `http://localhost:8222` | NATS management UI |
| OTel Collector (OTLP/gRPC) | `grpc://localhost:4317` | Ingest from your own services |
| OTel Collector (OTLP/HTTP) | `http://localhost:4318` | Ingest from your own services |
| OTel Collector (Prometheus) | `http://localhost:8889/metrics` | Scraped by Grafana's bundled Prometheus |
| Grafana Tempo | `http://localhost:3200` | Trace storage (queried by Grafana) |
| Postgres | `postgresql://signalman:signalman@localhost:5432/signalman` | Per-service schemas |
| coordinator (gRPC) | `localhost:50050` | Drive the saga directly |
| inventory (gRPC) | `localhost:50051` | Inventory source of truth |
| payments (gRPC) | `localhost:50052` | Payments source of truth |
| supplier (gRPC) | `localhost:50053` | Supplier source of truth |
| ledger (gRPC) | `localhost:50054` | Ledger source of truth |

Grafana is pre-provisioned with:
- **Tempo** datasource (trace backend, pointed at `http://tempo:3200`)
- **Prometheus** datasource (pointed at the Collector's Prometheus exporter)
- **Signalman — Booking Platform** dashboard (RED metrics per service, per-step SLO panels, trace search)

No authentication is required. The Grafana instance runs with anonymous Admin access
(`GF_AUTH_ANONYMOUS_ENABLED=true`) for demo convenience.

### 2.2 First booking

Once all services have printed their startup messages, trigger a booking:

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

A successful response:

```json
{
  "bookingId": "01926a7e-f1d2-7000-b6e2-c8b7a9df1234",
  "status": "booked",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "holdId": "hold-abc",
  "authorizationId": "auth-xyz",
  "confirmationId": "conf-def",
  "captureId": "cap-ghi",
  "entryId": "entry-jkl"
}
```

The `traceId` is the W3C trace ID of the booking's end-to-end distributed trace.

### 2.3 Viewing the trace

1. Open **Grafana** at [http://localhost:3001](http://localhost:3001).
2. Go to **Explore** → select the **Tempo** datasource.
3. Set the query type to **TraceQL** and search by trace ID:
   ```
   { traceId="<value from the booking response>" }
   ```
   Or use the search tab and paste the `traceId` directly.
4. The trace waterfall shows every span across all eight services — from the
   gateway's root `POST /bookings` span down through the coordinator, each leg's
   gRPC hop, the outbox relay's async PRODUCER publish, and the notifier's
   fan-out CONSUMER span.

For the dashboard view, go to **Dashboards → Signalman — Booking Platform**. The
per-step SLO panels show p99 latency and error rate for each saga step (gateway,
coordinator, inventory hold, payments authorize, supplier confirm, payments capture,
ledger commit) with green/yellow/red thresholds.

### 2.4 Tearing down

```bash
docker-compose down           # stop and remove containers (data volumes retained)
docker-compose down -v        # stop, remove containers AND volumes (fresh start next time)
```

---

## 3. Local development (no Docker)

Install dependencies once:

```bash
npm install
```

### 3.1 Start the full saga stack

Run each service in a separate terminal. Disable the simulated failures so every
booking succeeds:

```bash
# Terminal 1 — inventory
npm run start:inventory

# Terminal 2 — payments (PSP failures off)
PSP_DECLINE_RATE=0 PSP_FAILURE_RATE=0 npm run start:payments

# Terminal 3 — supplier (partner failures off)
SUPPLIER_REJECT_RATE=0 SUPPLIER_FAILURE_RATE=0 npm run start:supplier

# Terminal 4 — ledger
npm run start:ledger

# Terminal 5 — coordinator (dials the four legs)
npm run start:coordinator

# Terminal 6 — notifier (async consumer, in-memory broker by default)
npm run start:notifier

# Terminal 7 — reconciler (periodic background job)
RECONCILER_INTERVAL_MS=10000 npm run start:reconciler

# Terminal 8 — gateway (HTTP entry point)
npm run start
```

Then trigger a booking:

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

Without a running OTel Collector the exporter will log export errors (spans are not
lost; the SDK buffers and retries). Set `OTEL_EXPORTER_OTLP_ENDPOINT` to suppress or
redirect them. For a quick trace preview, point at the docker-compose collector while
keeping services local:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run start
```

### 3.2 Start only the gateway

If you only need the HTTP surface (for example to test the health probe or the
booking request/response shape) you can start the gateway alone. Without a live
coordinator the saga fails, but the `POST /bookings` endpoint returns a structured
`502` rather than crashing, and `GET /health` always returns `200`:

```bash
npm run start
curl http://localhost:3000/health
# {"status":"ok","service":"gateway"}
```

---

## 4. HTTP API — gateway

The gateway is the only public HTTP surface. All booking operations go through it.
No authentication is required. The base URL in the docker-compose stack is
`http://localhost:3000`.

See [docs/api.md](api.md) for the full field-level reference; this section gives
runnable examples for each endpoint.

### 4.1 Start a booking

```http
POST /bookings
Content-Type: application/json
```

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "sku": "ECO",
    "qty": 2,
    "amount": 19800,
    "currency": "USD"
  }' | jq .
```

Supply a caller-controlled idempotency key with `bookingId` to make retries safe —
a retried `POST` with the same `bookingId` replays the saga without double-booking:

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "bookingId": "my-idempotency-key-001",
    "sku": "BUS",
    "qty": 1,
    "amount": 29900,
    "currency": "EUR"
  }' | jq .
```

The response is always `201`. A `status: "booked"` means every saga step succeeded;
`status: "failed"` means a step refused or a leg was unreachable — the booking
attempt is recorded either way:

```json
{
  "bookingId": "my-idempotency-key-001",
  "status": "failed",
  "request": { "sku": "BUS", "qty": 1, "amount": 29900, "currency": "EUR" },
  "traceId": "abc123",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "failedStep": "supplier.confirm",
  "reason": "no_availability",
  "compensated": true
}
```

`compensated: true` means every completed step before the failure was unwound
(the hold was released, the authorization was voided). Compensation spans appear in
the trace under the `Book` SERVER span with `signalman.saga.compensation=true`.

### 4.2 Read a booking

```http
GET /bookings/:bookingId
```

```bash
curl -s http://localhost:3000/bookings/my-idempotency-key-001 | jq .
```

Returns the recorded outcome for that `bookingId`. Useful for polling a booking's
final state from outside the system, or for navigating to its trace:

```bash
BOOKING_ID="01926a7e-f1d2-7000-b6e2-c8b7a9df1234"
TRACE_ID=$(curl -s http://localhost:3000/bookings/$BOOKING_ID | jq -r .traceId)
echo "Open: http://localhost:3001/explore?datasource=tempo&traceId=$TRACE_ID"
```

Returns `404` when the gateway has no record of that booking ID.

### 4.3 Health probe

```bash
curl -s http://localhost:3000/health
# {"status":"ok","service":"gateway"}
```

Always returns `200` while the gateway process is live, regardless of downstream
service availability. Use this as the liveness probe in orchestrators.

### 4.4 Error responses

| Status | Cause |
|--------|-------|
| `201 { status: "booked" }` | All saga steps succeeded |
| `201 { status: "failed" }` | A saga step refused or failed; compensations ran |
| `400` | Malformed request body (missing required field, wrong type) |
| `404` | `GET /bookings/:id` — no booking with that ID recorded |
| `502` | Coordinator unreachable (gateway is up, downstream is not) |

---

## 5. gRPC — calling services directly

The internal services speak gRPC. You can call them directly with `grpcurl` or any
gRPC client; the proto files live in `proto/`.

All gRPC services bind to `0.0.0.0` in the docker-compose stack (so `localhost` works
from the host). In a real deployment services are internal and only the gateway is
public.

### 5.1 Coordinator.Book

The coordinator drives the full saga. Calling it directly skips the gateway's HTTP
layer but produces the same trace.

```bash
grpcurl -plaintext \
  -import-path services/coordinator/src/proto \
  -proto coordinator.proto \
  -d '{
    "bookingId": "bk-grpc-001",
    "sku": "ECO",
    "qty": 1,
    "amount": 9900,
    "currency": "USD"
  }' \
  localhost:50050 signalman.coordinator.v1.Coordinator/Book
```

Happy-path response:

```json
{
  "booked": true,
  "holdId": "hold-abc",
  "authorizationId": "auth-xyz",
  "confirmationId": "conf-def",
  "captureId": "cap-ghi",
  "entryId": "entry-jkl"
}
```

Failed-path response (e.g. oversell):

```json
{
  "booked": false,
  "failedStep": "inventory.hold",
  "reason": "insufficient_stock",
  "compensated": false
}
```

### 5.2 Inventory — Hold / Release

```bash
# Reserve stock for a booking
grpcurl -plaintext \
  -import-path services/inventory/src/proto \
  -proto inventory.proto \
  -d '{"bookingId":"bk-inv-001","sku":"ECO","qty":1}' \
  localhost:50051 signalman.inventory.v1.Inventory/Hold

# Release the reservation (saga compensation)
grpcurl -plaintext \
  -import-path services/inventory/src/proto \
  -proto inventory.proto \
  -d '{"bookingId":"bk-inv-001"}' \
  localhost:50051 signalman.inventory.v1.Inventory/Release
```

Both commands are **idempotent** per `bookingId`. A retried `Hold` returns the
standing reservation without consuming more stock. A `Release` on an already-released
or unknown booking is a no-op (`released: true`).

### 5.3 Payments — Authorize / Capture / Void

```bash
# Authorize funds with the (simulated) PSP
grpcurl -plaintext \
  -import-path services/payments/src/proto \
  -proto payments.proto \
  -d '{"bookingId":"bk-pay-001","amount":9900,"currency":"USD"}' \
  localhost:50052 signalman.payments.v1.Payments/Authorize

# Capture the authorized funds
grpcurl -plaintext \
  -import-path services/payments/src/proto \
  -proto payments.proto \
  -d '{"bookingId":"bk-pay-001"}' \
  localhost:50052 signalman.payments.v1.Payments/Capture

# Void the authorization (saga compensation)
grpcurl -plaintext \
  -import-path services/payments/src/proto \
  -proto payments.proto \
  -d '{"bookingId":"bk-pay-001"}' \
  localhost:50052 signalman.payments.v1.Payments/Void
```

### 5.4 Supplier — Confirm / Cancel

```bash
# Confirm with the (simulated) external partner
grpcurl -plaintext \
  -import-path services/supplier/src/proto \
  -proto supplier.proto \
  -d '{"bookingId":"bk-sup-001","sku":"ECO","qty":1}' \
  localhost:50053 signalman.supplier.v1.Supplier/Confirm

# Cancel the confirmation (saga compensation)
grpcurl -plaintext \
  -import-path services/supplier/src/proto \
  -proto supplier.proto \
  -d '{"bookingId":"bk-sup-001"}' \
  localhost:50053 signalman.supplier.v1.Supplier/Cancel
```

### 5.5 Ledger — Commit / Reverse

```bash
# Post the booking amount to the financial record
grpcurl -plaintext \
  -import-path services/ledger/src/proto \
  -proto ledger.proto \
  -d '{"bookingId":"bk-led-001","amount":9900,"currency":"USD","captureId":"cap-ghi"}' \
  localhost:50054 signalman.ledger.v1.Ledger/Commit

# Reverse the posting (saga compensation)
grpcurl -plaintext \
  -import-path services/ledger/src/proto \
  -proto ledger.proto \
  -d '{"bookingId":"bk-led-001"}' \
  localhost:50054 signalman.ledger.v1.Ledger/Reverse
```

`amount` must be a positive integer (minor currency units, e.g. cents). A
non-positive amount returns `committed: false, reason: "invalid_amount"`.

---

## 6. Async events — the broker surface

The four producing services publish events to NATS JetStream on the `signalman`
stream. Events can be consumed by external systems subscribing to the same NATS
server.

**Stream name:** `signalman`  
**Subject patterns:** `inventory.*`, `payment.*`, `supplier.*`, `ledger.*`

| Subject | Produced by | When |
|---------|------------|------|
| `inventory.held` | inventory | Hold committed for a booking |
| `inventory.released` | inventory | Hold released (compensation or post-saga) |
| `payment.authorized` | payments | PSP authorization recorded |
| `payment.captured` | payments | PSP capture recorded |
| `payment.voided` | payments | Authorization voided (compensation) |
| `supplier.confirmed` | supplier | Partner confirmation recorded |
| `supplier.cancelled` | supplier | Confirmation cancelled (compensation) |
| `ledger.committed` | ledger | Financial entry posted |
| `ledger.reversed` | ledger | Financial entry reversed (compensation) |

Each message carries W3C `traceparent`/`tracestate` headers so an external consumer
can continue the booking trace.

**Subscribe to all booking events from a shell:**

```bash
nats sub --server nats://localhost:4222 "signalman.>"
```

**Subscribe with trace context extraction (Node.js snippet):**

```typescript
import { connect } from 'nats';
import { extractFromBrokerHeaders } from '@signalman/propagation';
import { context, propagation } from '@opentelemetry/api';

const nc = await connect({ servers: 'nats://localhost:4222' });
const js = nc.jetstream();

const sub = await js.subscribe('ledger.committed', {
  config: { durable_name: 'my-consumer', deliver_policy: 'all' },
});

for await (const msg of sub) {
  const headers: Record<string, string> = {};
  msg.headers?.keys().forEach((k) => { headers[k] = msg.headers!.get(k); });

  const ctx = propagation.extract(context.active(), headers, {
    get: (_c, k) => headers[k],
    keys: () => Object.keys(headers),
  });

  context.with(ctx, () => {
    const payload = JSON.parse(new TextDecoder().decode(msg.data));
    console.log('ledger.committed', payload);
    // Any spans opened here will join the booking trace.
  });

  msg.ack();
}
```

---

## 7. Inducing failures and compensations

The simulated external boundaries support controllable failure injection. All rates
are floats in `[0, 1]` where `0` means never and `1` means always.

### 7.1 Force a supplier failure

Run the docker-compose stack with the supplier set to always fail:

```bash
SUPPLIER_FAILURE_RATE=1 docker-compose up
```

Or, for a local run:

```bash
SUPPLIER_FAILURE_RATE=1 npm run start:supplier
```

Then trigger a booking. The saga will succeed at `inventory.hold` and
`payments.authorize`, reach `supplier.confirm`, receive an error (partner outage),
and run the compensations in reverse — `supplier.cancel → payments.void →
inventory.release` — all visible as `signalman.saga.compensation=true` spans in the
trace.

The booking response will be:

```json
{
  "status": "failed",
  "failedStep": "supplier.confirm",
  "reason": "partner_outage",
  "compensated": true
}
```

### 7.2 Force a PSP decline

A PSP decline is a **business rejection** (not an outage), so the coordinator records
the failure and runs compensations but the saga does not error the payments span:

```bash
PSP_DECLINE_RATE=1 docker-compose up
# or: PSP_DECLINE_RATE=1 npm run start:payments
```

The failed booking response:

```json
{
  "status": "failed",
  "failedStep": "payments.authorize",
  "reason": "card_declined",
  "compensated": true
}
```

Only `inventory.release` fires as a compensation (inventory was the only step that
had already completed).

### 7.3 Induce reconciler divergence

The headline scenario is **`supplier_confirmed_ledger_missing`**: the supplier
confirmed a booking but no ledger entry was committed. The reconciler catches it on
its next pass and emits a `reconcile.divergence` span with a link back to the
originating booking trace.

The easiest way to induce this in the docker-compose stack is to start the ledger
service with failures enabled **after** a booking has reached the supplier step:

```bash
# Start with ledger failures on (Commit always errors)
# Note: the ledger has no FAILURE_RATE knob because it has no external boundary —
# instead, call Reverse immediately after Commit to produce an orphan.
```

Alternatively, use the in-process test that pins this scenario directly:

```bash
npx jest --testPathPattern reconciler
```

The unit tests create an in-memory snapshot with `supplier.confirmed = true` and
`ledger.committed = false` and assert that the reconciler emits a finding with
`kind: "supplier_confirmed_ledger_missing"` and a span link to the booking trace.

---

## 8. Plugging in your own observability backend

The docker-compose stack ships an OTel Collector, Grafana Tempo, and Grafana. For
production, or when you already have a Jaeger/Honeycomb/Datadog/Grafana Cloud
environment, point the services' OTLP exporter at your own Collector instead.

**Override the collector endpoint** for all services at once by setting
`OTEL_EXPORTER_OTLP_ENDPOINT` before bringing the stack up:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://my-collector:4318 docker-compose up
```

Or, for a local run, set it per process:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycombio \
  OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=YOUR_KEY" \
  npm run start
```

The Collector config is at `docker/otel-collector-config.yaml`. To add a new
exporter (for example, OTLP to a remote backend in addition to Tempo):

```yaml
# docker/otel-collector-config.yaml
exporters:
  otlphttp/remote:
    endpoint: https://my-backend:4318
    headers:
      x-api-key: "${MY_API_KEY}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/tempo, otlphttp/remote]   # add the new exporter
```

To send spans from your **own services** into the same Signalman trace (so the
booking trace includes your downstream hop), inject the W3C `traceparent` from the
context your service receives into your outbound gRPC metadata or HTTP header:

```typescript
import { context, propagation } from '@opentelemetry/api';

// In an HTTP client:
const headers: Record<string, string> = {};
propagation.inject(context.active(), headers);
fetch('http://gateway:3000/bookings', { headers });
```

Any span you open under the active context will join the booking's trace.

---

## 9. Connecting to an external NATS cluster

By default the docker-compose stack uses the bundled NATS container. To use an
existing JetStream cluster, set the broker variables for the services that need them:

```bash
BROKER=nats \
NATS_URL=nats://my-nats-cluster:4222 \
docker-compose up
```

Or, for an authenticated cluster:

```bash
BROKER=nats \
NATS_SERVERS=nats://user:password@my-nats-cluster:4222 \
docker-compose up
```

The producing services (`inventory`, `payments`, `supplier`, `ledger`) will drain
their outboxes to the external cluster, and the consuming services (`notifier`,
`reconciler`) will subscribe from it.

The stream `signalman` is provisioned idempotently on first connect — existing
streams with the same name are reused. Ensure the connecting user has `publish` and
`subscribe` permissions on `signalman.>`.

To leave the broker at the in-memory default (useful for single-process tests), omit
`BROKER` or set it to `memory`.

---

## 10. Connecting to an external Postgres instance

The docker-compose stack uses a bundled Postgres container at
`postgresql://signalman:signalman@postgres:5432/signalman`. To use an external
instance:

```bash
POSTGRES_URL=postgresql://myuser:mypass@my-pg-host:5432/mydb \
docker-compose up
```

Each service creates its own schema on first boot (`inventory`, `payments`,
`supplier`, `ledger`, `gateway`) inside the target database. The DDL is
idempotent (`CREATE TABLE IF NOT EXISTS`) so restarts are safe.

Required Postgres version: **13+** (uses `SELECT … FOR UPDATE SKIP LOCKED`).

**Minimum privilege set** (one user is enough for the demo; production would isolate
per service):

```sql
GRANT CONNECT ON DATABASE mydb TO signalman;
GRANT CREATE ON DATABASE mydb TO signalman;  -- to create schemas
```

The services create their own tables; no manual schema migration is needed.

To run without Postgres at all (in-memory stores only, suitable for tests and
single-process demos), omit `POSTGRES_URL`. The services fall back to the in-memory
reference stores automatically.

---

## 11. Environment variable reference

### Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listener port |
| `COORDINATOR_GRPC_URL` | `localhost:50050` | Address of the coordinator gRPC server |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string; unset = in-memory booking store |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Coordinator

| Variable | Default | Description |
|----------|---------|-------------|
| `COORDINATOR_GRPC_URL` | `0.0.0.0:50050` | Bind address for the coordinator gRPC server |
| `INVENTORY_GRPC_URL` | `localhost:50051` | Address of the inventory gRPC server |
| `PAYMENTS_GRPC_URL` | `localhost:50052` | Address of the payments gRPC server |
| `SUPPLIER_GRPC_URL` | `localhost:50053` | Address of the supplier gRPC server |
| `LEDGER_GRPC_URL` | `localhost:50054` | Address of the ledger gRPC server |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Inventory

| Variable | Default | Description |
|----------|---------|-------------|
| `INVENTORY_GRPC_URL` | `0.0.0.0:50051` | Bind address |
| `BROKER` | `memory` | Broker transport: `memory` or `nats` |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL (when `BROKER=nats`) |
| `NATS_SERVERS` | _(unset)_ | Comma-separated NATS servers (overrides `NATS_URL`) |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Payments

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYMENTS_GRPC_URL` | `0.0.0.0:50052` | Bind address |
| `PSP_LATENCY_MS` | `50` | Simulated PSP call latency in milliseconds |
| `PSP_DECLINE_RATE` | `0` | Probability of a PSP decline (business rejection), float in `[0, 1]` |
| `PSP_FAILURE_RATE` | `0` | Probability of a PSP outage (thrown error), float in `[0, 1]` |
| `BROKER` | `memory` | Broker transport |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Supplier

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPPLIER_GRPC_URL` | `0.0.0.0:50053` | Bind address |
| `SUPPLIER_LATENCY_MS` | `200` | Simulated partner call latency (deliberately slow by default) |
| `SUPPLIER_REJECT_RATE` | `0.05` | Probability of a partner rejection (business "no"), float in `[0, 1]` |
| `SUPPLIER_FAILURE_RATE` | `0.02` | Probability of a partner outage (thrown error), float in `[0, 1]` |
| `BROKER` | `memory` | Broker transport |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Ledger

| Variable | Default | Description |
|----------|---------|-------------|
| `LEDGER_GRPC_URL` | `0.0.0.0:50054` | Bind address |
| `BROKER` | `memory` | Broker transport |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Notifier

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFIER_LATENCY_MS` | `30` | Simulated notification provider call latency |
| `NOTIFIER_FAILURE_RATE` | `0` | Probability of a provider outage, float in `[0, 1]` |
| `BROKER` | `memory` | Broker transport; must be `nats` for cross-service delivery |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |

### Reconciler

| Variable | Default | Description |
|----------|---------|-------------|
| `RECONCILER_INTERVAL_MS` | `30000` | How often to run a reconciliation pass (ms) |
| `RECONCILER_SETTLE_GRACE_MS` | `5000` | Minimum quiet time after the last source event before a booking is eligible for reconciliation (ms); prevents in-flight bookings from appearing divergent |
| `BROKER` | `memory` | Broker transport; must be `nats` for cross-service delivery |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `POSTGRES_URL` | _(unset)_ | Postgres connection string |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP export endpoint |
