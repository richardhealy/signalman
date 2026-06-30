# How-to guides — signalman

> Task-oriented guides for common developer workflows, observability scenarios,
> and troubleshooting. For the one-command demo and integration walkthroughs see
> [`integration.md`](integration.md). For service internals see
> [`architecture.md`](architecture.md).

## Contents

1. [Developer workflows](#1-developer-workflows)
   - 1.1 [Run the full test suite](#11-run-the-full-test-suite)
   - 1.2 [Run tests for a single project](#12-run-tests-for-a-single-project)
   - 1.3 [Run integration tests against real infrastructure](#13-run-integration-tests-against-real-infrastructure)
   - 1.4 [Typecheck and lint](#14-typecheck-and-lint)
   - 1.5 [Build the monorepo](#15-build-the-monorepo)
2. [Running services locally](#2-running-services-locally)
   - 2.1 [Run all eight services without Docker](#21-run-all-eight-services-without-docker)
   - 2.2 [Disable failure injection for a deterministic demo](#22-disable-failure-injection-for-a-deterministic-demo)
   - 2.3 [Use the NATS JetStream transport locally](#23-use-the-nats-jetstream-transport-locally)
3. [Observing a booking in Grafana](#3-observing-a-booking-in-grafana)
   - 3.1 [Find the trace for a booking](#31-find-the-trace-for-a-booking)
   - 3.2 [Read the span tree](#32-read-the-span-tree)
   - 3.3 [Jump from a metric to its trace (exemplars)](#33-jump-from-a-metric-to-its-trace-exemplars)
4. [Diagnosing a failed booking](#4-diagnosing-a-failed-booking)
   - 4.1 [Identify which step failed](#41-identify-which-step-failed)
   - 4.2 [Check whether compensations ran](#42-check-whether-compensations-ran)
   - 4.3 [Read the error span attributes](#43-read-the-error-span-attributes)
5. [Understanding a reconciler divergence](#5-understanding-a-reconciler-divergence)
   - 5.1 [Find divergence findings in Tempo](#51-find-divergence-findings-in-tempo)
   - 5.2 [Navigate from a finding to its booking trace](#52-navigate-from-a-finding-to-its-booking-trace)
6. [Tuning failure injection](#6-tuning-failure-injection)
7. [Common issues](#7-common-issues)

---

## 1. Developer workflows

### 1.1 Run the full test suite

```bash
npm install          # first time only
npm test
```

The default Jest run covers all unit tests across all 65 test suites. Three
integration-gated suites (NATS, Postgres) are automatically skipped unless you
set the environment variables described in §1.3. Expected output:

```
Test Suites: 3 skipped, 62 passed, 62 of 65 total
Tests:       16 skipped, 420 passed, 436 total
```

### 1.2 Run tests for a single project

Pass any Jest filter after `--`:

```bash
# Run all tests in a specific service or lib
npm test -- --testPathPattern services/coordinator
npm test -- --testPathPattern libs/outbox

# Run a single spec file by name
npm test -- outbox/durability

# Run only tests whose name matches a string
npm test -- --testNamePattern "atomically"
```

Jest respects the monorepo path aliases (`@signalman/*`), so imports resolve
correctly without any extra steps.

### 1.3 Run integration tests against real infrastructure

Three suites are gated by environment variables and skipped by default:

| Suite | Env var to set | What it exercises |
|-------|---------------|-------------------|
| `nats-broker.integration.spec.ts` | `NATS_TEST_URL=nats://localhost:4222` | Full NATS JetStream transport — fan-out, queue groups, redelivery, dead-letter, async trace continuity |
| `libs/outbox/src/pg-store.integration.spec.ts` | `POSTGRES_TEST_URL=postgres://…` | `PostgresOutboxStore` and `PostgresInboxStore` atomicity, rollback, SKIP LOCKED claiming |
| `services/inventory/src/pg-store.integration.spec.ts` (and others) | `POSTGRES_TEST_URL=postgres://…` | Per-service Postgres stores |

Start the required infrastructure, then set the env var:

```bash
# NATS integration tests
docker run --rm -p 4222:4222 nats -js
NATS_TEST_URL=nats://localhost:4222 npm test -- nats-broker.integration

# Postgres integration tests
docker run --rm -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16-alpine
POSTGRES_TEST_URL=postgres://postgres:test@localhost:5432/signalman npm test -- pg-store.integration
```

Or with the docker-compose stack running:

```bash
NATS_TEST_URL=nats://localhost:4222 \
POSTGRES_TEST_URL=postgres://signalman:signalman@localhost:5432/signalman \
npm test
```

### 1.4 Typecheck and lint

```bash
npm run typecheck    # tsc --noEmit across the workspace (strict mode)
npm run lint         # ESLint flat config across all projects
npm run lint -- --fix  # auto-fix what ESLint can
```

TypeScript is in strict mode throughout (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`). Every public API surface has
TSDoc comments — the typecheck pass validates those too.

### 1.5 Build the monorepo

```bash
npm run build        # compiles all libs and services; output in dist/
```

The Nest CLI compiles each project via its `nest-cli.json` configuration. Build
output lands in `dist/`; the Docker image runs from there.

To build a single project:

```bash
npx nest build gateway
npx nest build coordinator
npx nest build libs/otel   # any lib
```

---

## 2. Running services locally

For the full docker-compose workflow see [`integration.md § 2`](integration.md).
These steps cover running services directly on your machine.

### 2.1 Run all eight services without Docker

You need NATS JetStream for cross-service event delivery. Start it first:

```bash
docker run --rm -p 4222:4222 nats -js
```

Then, in separate terminals (or use a process manager):

```bash
# Terminal 1 — inventory
npm run start:inventory

# Terminal 2 — payments (disable PSP failures for a clean demo)
PSP_DECLINE_RATE=0 PSP_FAILURE_RATE=0 npm run start:payments

# Terminal 3 — supplier (disable partner failures)
SUPPLIER_REJECT_RATE=0 SUPPLIER_FAILURE_RATE=0 npm run start:supplier

# Terminal 4 — ledger
npm run start:ledger

# Terminal 5 — coordinator (all leg URLs default to localhost)
npm run start:coordinator

# Terminal 6 — notifier (subscribe to the real NATS broker)
BROKER=nats npm run start:notifier

# Terminal 7 — reconciler
BROKER=nats RECONCILER_INTERVAL_MS=5000 npm run start:reconciler

# Terminal 8 — gateway
BROKER=nats npm run start:gateway    # or: npm start
```

Trigger a booking:

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H 'Content-Type: application/json' \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}' | jq .
```

### 2.2 Disable failure injection for a deterministic demo

Each service that wraps an external boundary ships with a simulated boundary that
has controllable failure rates. Setting every rate to `0` makes the saga always
succeed:

| Service | Env var | Default | Set to `0` for |
|---------|---------|---------|---------------|
| payments | `PSP_DECLINE_RATE` | `0.05` | PSP never declines |
| payments | `PSP_FAILURE_RATE` | `0.02` | PSP never times out |
| supplier | `SUPPLIER_REJECT_RATE` | `0.10` | Partner never rejects |
| supplier | `SUPPLIER_FAILURE_RATE` | `0.05` | Partner never times out |
| notifier | `NOTIFIER_FAILURE_RATE` | `0.02` | Provider never times out |

To force failures instead of disabling them, set a rate to `1` (100%). For
example, `SUPPLIER_FAILURE_RATE=1` makes every supplier call time out, which
triggers the full compensation unwind every time.

### 2.3 Use the NATS JetStream transport locally

By default every service uses the in-memory broker. Because each process owns its
own in-memory broker, events do not cross process boundaries without NATS. To wire
them all together:

```bash
# Start NATS JetStream
docker run --rm -p 4222:4222 nats -js

# Set for every service that publishes or subscribes:
export BROKER=nats
export NATS_URL=nats://localhost:4222
```

With `BROKER=nats` set, the outbox relays in the four producing services publish
to JetStream, the notifier's subscription host receives `ledger.committed` off
JetStream, and the reconciler's source gateway receives `inventory.*` / `supplier.*`
/ `ledger.*` off JetStream — completing the full cross-process event loop.

---

## 3. Observing a booking in Grafana

The docker-compose stack ships a pre-wired Grafana at `http://localhost:3001`.

### 3.1 Find the trace for a booking

Every `POST /bookings` response includes a `traceId` field:

```json
{
  "bookingId": "bk_abc123",
  "status": "booked",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

In Grafana:

1. Go to **Explore** (compass icon in the left sidebar).
2. Select the **Tempo** datasource from the dropdown at the top.
3. In **Query type**, choose **TraceID**.
4. Paste the `traceId` from the booking response.
5. Click **Run query**.

The trace viewer opens with the full span tree for that booking.

Alternatively, use the **Signalman — Booking Platform** dashboard (Dashboards →
Signalman) and the Trace Search panel at the bottom — filter by service name or
time range to find recent traces.

### 3.2 Read the span tree

A connected happy-path booking produces spans across six services in one trace.
Here is what each entry in the span tree means:

| Span name | Service | Type | Meaning |
|-----------|---------|------|---------|
| `POST /bookings` | gateway | SERVER | Root span; the trace starts here. The booking's `traceId` is this span's trace ID. |
| `Coordinator/Book` | gateway | CLIENT | The gateway's outbound gRPC call to the coordinator. |
| `Coordinator/Book` | coordinator | SERVER | The coordinator receives the call and drives the saga. |
| `saga.inventory.hold` | coordinator | INTERNAL | Wraps the inventory gRPC pair; fails here on oversell. |
| `Inventory/Hold` | coordinator | CLIENT | Outbound gRPC call to inventory. |
| `Inventory/Hold` | inventory | SERVER | Inventory receives the hold request. |
| `saga.payments.authorize` | coordinator | INTERNAL | Wraps the payments authorize gRPC pair. |
| `Payments/Authorize` (client + server) | coordinator / payments | CLIENT + SERVER | Authorization leg; the PSP CLIENT span appears inside the SERVER span. |
| `psp.authorize` | payments | CLIENT | The call to the simulated PSP — the external boundary. |
| `saga.supplier.confirm` | coordinator | INTERNAL | Wraps the supplier confirm gRPC pair. |
| `Supplier/Confirm` (client + server) | coordinator / supplier | CLIENT + SERVER | Supplier confirmation leg. |
| `partner.confirm` | supplier | CLIENT | The call to the simulated external partner — the external boundary. |
| `saga.payments.capture` | coordinator | INTERNAL | Wraps the payments capture gRPC pair. |
| `Payments/Capture` (client + server) | coordinator / payments | CLIENT + SERVER | Money-taking step. |
| `saga.ledger.commit` | coordinator | INTERNAL | Wraps the ledger commit gRPC pair. |
| `Ledger/Commit` (client + server) | coordinator / ledger | CLIENT + SERVER | Financial record step. |
| `ledger.committed` | ledger (outbox relay) | PRODUCER | Async hop starts here; parented to the `Ledger/Commit` SERVER span. |

The notifier's fan-out `CONSUMER` span (`notifier.consume ledger.committed`)
appears on a **separate trace** linked back to the PRODUCER span via a span link.
Click the link icon on the PRODUCER span in Tempo to navigate to the notifier's
trace.

### 3.3 Jump from a metric to its trace (exemplars)

The Grafana dashboard's per-step SLO panels (Booking saga — per-step SLOs) show
p99 latency and error rate per saga step. Prometheus metric points carry
**exemplars** — individual sample annotations that embed the `traceId` of the
request that produced them.

To jump from a metric to its trace:

1. On any SLO panel, hover over a data point and click **Query with exemplars**,
   or switch the panel's time series view to show exemplar points (the scatter
   dots).
2. Click an exemplar dot — it shows the embedded `traceId`.
3. Click **View trace** or copy the `traceId` and switch to Explore → Tempo.

This is the "SLO breach → exact trace" linkage — useful for understanding why
p99 spiked on a particular step.

---

## 4. Diagnosing a failed booking

A booking response with `status: "failed"` means the saga stopped at a step and
could not complete. The `failedStep`, `reason`, and `compensated` fields in the
response tell you what happened at the surface level; the trace gives you the
full picture.

### 4.1 Identify which step failed

The booking response carries:

```json
{
  "status": "failed",
  "failedStep": "supplier.confirm",
  "reason": "partner_outage",
  "compensated": true
}
```

- `failedStep` — which saga step stopped. Values: `inventory.hold`,
  `payments.authorize`, `supplier.confirm`, `payments.capture`, `ledger.commit`.
- `reason` — the specific failure. Business refusals (`insufficient_stock`,
  `psp_declined`, `partner_rejected`, `invalid_amount`) are distinct from
  outage-class failures (`psp_outage`, `partner_outage`).
- `compensated` — `true` when the coordinator completed the reverse unwind; `false`
  when the failure happened before any step succeeded (nothing to compensate).

In the trace, the failed step's span is marked `error: true` and carries an
`error.type` attribute matching the `reason` above.

### 4.2 Check whether compensations ran

In Tempo, look for spans whose name starts with `saga.compensation.*`:

- `saga.compensation.supplier.cancel`
- `saga.compensation.payments.void`
- `saga.compensation.inventory.release`

Each carries the attribute `signalman.saga.compensation: true`. They appear in
reverse order of the completed forward steps. If a compensation span is marked
`error: true`, that individual unwind failed (the overall `compensated` field
reflects whether the full unwind completed successfully).

A failure at `inventory.hold` (the first step) produces no compensation spans —
there is nothing to unwind.

### 4.3 Read the error span attributes

On any error span in Tempo:

| Attribute | Meaning |
|-----------|---------|
| `error: true` | The span represents a failed operation. |
| `error.type` | The category (`partner_outage`, `psp_declined`, etc.). |
| `exception.message` | The raw error message from the external boundary or the business logic. |
| `signalman.saga.outcome` | `"failed"` on the step span; `"booked"` or `"failed"` on the root. |
| `signalman.saga.compensation` | `true` on compensation spans. |

---

## 5. Understanding a reconciler divergence

The reconciler runs a periodic pass (default every 30 s, `RECONCILER_INTERVAL_MS`)
comparing what each service knows about settled bookings. When it finds a mismatch
it records a `DivergenceFinding` and emits a `reconcile.divergence` span.

### 5.1 Find divergence findings in Tempo

Search for the span name `reconcile.divergence` in the Grafana Tempo Explore
panel (using the **Search** query type, filter by service name `reconciler`).

Each `reconcile.divergence` span carries:

| Attribute | Meaning |
|-----------|---------|
| `booking.id` | The booking whose sources of truth disagree. |
| `divergence.kind` | `supplier_confirmed_ledger_missing`, `ledger_committed_supplier_unconfirmed`, or `orphaned_hold`. |
| `signalman.trace.link` | The `traceId` of the original booking that caused the divergence. |

The three divergence kinds:

- **`supplier_confirmed_ledger_missing`** — the external partner confirmed the
  booking but the ledger has no committed financial record. Critical: money may
  be owed to the supplier but has not been posted.
- **`ledger_committed_supplier_unconfirmed`** — the financial record was posted
  but the partner has no confirmation. Critical: the booking may be taking money
  for a seat that was never actually confirmed.
- **`orphaned_hold`** — inventory is still held for a booking that never
  completed. The stock is unavailable for new bookings.

### 5.2 Navigate from a finding to its booking trace

In Tempo, when you have the `reconcile.divergence` span open:

1. Find the **Span links** section in the span detail panel.
2. Click the link — it navigates directly to the originating booking trace via the
   `signalman.trace.link` attribute.
3. In the booking trace, look for the step that failed silently (the one whose
   state the finding says is missing) to understand why the divergence occurred.

To induce a divergence deliberately for testing:

```bash
# Set supplier to always succeed but kill it after confirming:
#   (1) Run a booking — supplier confirms, saga proceeds.
#   (2) Crash the ledger container before the commit.
docker stop signalman-ledger-1

# The booking will show status: "failed" at the ledger step.
# The supplier has confirmed but the ledger has no record.
# After RECONCILER_SETTLE_GRACE_MS has passed, the reconciler detects it.
```

See [`integration.md § 5`](integration.md#5-induce-and-observe-a-reconciler-divergence)
for the full walkthrough.

---

## 6. Tuning failure injection

All three external boundaries are simulated with controllable knobs. The
parameters are set per-service via environment variables (see the full reference
in [`docs/api.md`](api.md#environment-variables)).

**Quick reference:**

```bash
# Payments — simulated PSP
PSP_LATENCY_MS=500    # added delay per PSP call (ms); default 100
PSP_DECLINE_RATE=0.2  # probability a PSP call returns "declined"; default 0.05
PSP_FAILURE_RATE=0.1  # probability a PSP call throws (outage); default 0.02

# Supplier — simulated external partner (deliberately slower and flakier)
SUPPLIER_LATENCY_MS=1000    # default 300
SUPPLIER_REJECT_RATE=0.3    # probability of a partner rejection; default 0.10
SUPPLIER_FAILURE_RATE=0.2   # probability of a partner outage; default 0.05

# Notifier — simulated notification provider
NOTIFIER_LATENCY_MS=200     # default 50
NOTIFIER_FAILURE_RATE=0.1   # probability of a provider outage; default 0.02
```

In the docker-compose stack, override any of these in the `environment` section
of `docker-compose.yml`, or pass them with `-e`:

```bash
docker-compose up -e SUPPLIER_FAILURE_RATE=1   # every supplier call times out
```

For the latency variables, note that the simulated partner adds a random `[0, n]`
jitter on top of the configured base latency — so `SUPPLIER_LATENCY_MS=1000` can
produce calls anywhere from 0 ms to 1000 ms. This makes the p99 latency panels
particularly interesting under load.

---

## 7. Common issues

**`jest: not found` when running `npm test`**

Dependencies are not installed. Run `npm install` first.

**Service fails to start with `ECONNREFUSED` to `localhost:50050`**

The coordinator is not running. Start it before the gateway (the coordinator must
be up before the first booking request hits the gateway). Under docker-compose,
service dependencies are wired via `depends_on`.

**`GET /bookings/:id` returns `404`**

The gateway's in-memory booking store is empty. Either the booking was made
against a different process instance (e.g., a docker restart reset the in-memory
state), or the `bookingId` is wrong. With `POSTGRES_URL` set the booking store is
persistent — restarts do not lose records.

**The notifier logs "ready (subscribed to ledger.committed)" but no notifications fire**

The notifier is subscribed to the in-memory broker, but the ledger's outbox relay
is draining onto a different broker instance. Set `BROKER=nats` on every service
(including the gateway, coordinator, and all four producing legs) so all processes
share one JetStream broker.

**The reconciler logs "pass complete" but never finds divergences**

The settle-grace window (`RECONCILER_SETTLE_GRACE_MS`, default 5 000 ms) filters
out bookings whose last event is too recent. If you are testing the reconciler
immediately after a booking, wait at least the grace period before the next pass.
Reduce the grace window for faster feedback:

```bash
RECONCILER_SETTLE_GRACE_MS=1000 RECONCILER_INTERVAL_MS=2000 npm run start:reconciler
```

**Trace IDs do not match between services**

The `traceparent` W3C header is not being propagated. Check that:
- The gRPC call goes through the coordinator's `callWithTrace` wrapper (not a raw
  stub call).
- The receiving service's `@signalman/interceptor` is registered (the
  `ObservabilityModule.forRoot` import is in the service's `AppModule`).
- Both services are using the same OTel SDK version (the lock file pins this).

**Exemplar dots do not appear on Grafana panels**

Prometheus exemplar support requires Prometheus 2.43+ and the Grafana panel must
have **Exemplars** enabled in the query editor. The docker-compose stack ships a
compatible configuration; if you are wiring Prometheus separately, add
`enable_exemplars: true` to the `otlp` receiver config in the Collector.
