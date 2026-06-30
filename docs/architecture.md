# Architecture dossier — signalman

> Observability and reconciliation for a distributed booking platform.
> Trace one booking end to end across synchronous gRPC and asynchronous events,
> and surface the moment the sources of truth diverge.

## Table of contents

1. [System overview](#1-system-overview)
2. [Component map](#2-component-map)
3. [Data and control flow](#3-data-and-control-flow)
   - 3.1 [Happy-path booking saga](#31-happy-path-booking-saga)
   - 3.2 [Compensation (failure) path](#32-compensation-failure-path)
   - 3.3 [Async event pipeline](#33-async-event-pipeline)
   - 3.4 [Reconciliation pass](#34-reconciliation-pass)
4. [Library layer](#4-library-layer)
   - 4.1 [@signalman/otel](#41-signalmanotel)
   - 4.2 [@signalman/propagation](#42-signalmanpropagation)
   - 4.3 [@signalman/logging](#43-signalmanlogging)
   - 4.4 [@signalman/interceptor](#44-signalmaninterceptor)
   - 4.5 [@signalman/outbox](#45-signalmanoutbox)
   - 4.6 [@signalman/inbox](#46-signalmaninbox)
   - 4.7 [@signalman/broker](#47-signalmanbroker)
5. [Service layer](#5-service-layer)
   - 5.1 [gateway](#51-gateway)
   - 5.2 [coordinator](#52-coordinator)
   - 5.3 [inventory](#53-inventory)
   - 5.4 [payments](#54-payments)
   - 5.5 [supplier](#55-supplier)
   - 5.6 [ledger](#56-ledger)
   - 5.7 [notifier](#57-notifier)
   - 5.8 [reconciler](#58-reconciler)
6. [Observability pipeline](#6-observability-pipeline)
   - 6.1 [Trace propagation](#61-trace-propagation)
   - 6.2 [RED metrics](#62-red-metrics)
   - 6.3 [Structured logging](#63-structured-logging)
7. [Key design decisions](#7-key-design-decisions)
8. [External dependencies](#8-external-dependencies)
9. [Where the spec maps to code](#9-where-the-spec-maps-to-code)

---

## 1. System overview

`signalman` is a distributed booking platform built around three engineering concerns:

1. **Orchestrated saga** — a single booking coordinates five services synchronously over gRPC and one service asynchronously over an event broker. A forced failure anywhere in the chain unwinds all completed steps in reverse through explicit compensations.

2. **Reliable messaging** — every domain event is durably staged in a transactional outbox (written atomically with the business state change) and relayed to the broker by a background process. Consumers are idempotent, so at-least-once broker delivery becomes effectively-once processing.

3. **Reconciliation** — a periodic background job compares what each service claims happened and links any divergence finding back to the originating booking trace, so the failure mode that matters — silent disagreement between sources of truth — is caught and explained, not silently tolerated.

OpenTelemetry is the connective tissue: every hop, whether a synchronous gRPC call, an asynchronous broker event, or an external boundary, carries the same `traceId`. One booking is one trace.

---

## 2. Component map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  External clients                                                            │
└──────────────────────────────────────────┬───────────────────────────────────┘
                                           │ HTTP (port 3000)
                                           ▼
┌─────────────────────┐         ┌──────────────────────┐
│  gateway            │         │  reconciler          │
│  POST /bookings     │         │  periodic job        │
│  GET  /bookings/:id │         │  (no sync surface)   │
│  GET  /health       │         └──────────────────────┘
└────────┬────────────┘                    │ subscribes
         │ gRPC (port 50050)               │ inventory.* / supplier.* / ledger.*
         ▼                                 │
┌─────────────────────┐                   │
│  coordinator        │    ◄──────────────┘
│  saga orchestrator  │
└──┬──────────────────┘
   │ gRPC to four legs
   │
   ├──► inventory (port 50051)  ──── inventory.held / .released ──►┐
   │                                                                │
   ├──► payments  (port 50052)  ──── payment.authorized / .captured / .voided ──►│
   │                                                                │
   ├──► supplier  (port 50053)  ──── supplier.confirmed / .cancelled ──►│
   │                                                                │
   └──► ledger    (port 50054)  ──── ledger.committed / .reversed ──►│
                                                                    │
                                       NATS JetStream ◄─────────────┘
                                             │
                                             ▼
                                       notifier
                                       (consumes ledger.committed)

Infrastructure:
  Postgres (port 5432)    — one schema per service, single instance
  NATS JetStream (4222)   — durable stream, fan-out + queue-group delivery
  OTel Collector (4317/4318) — OTLP receiver → Tempo (traces) + Prometheus (metrics)
  Grafana Tempo (3200)    — distributed trace backend
  Grafana (3001)          — dashboards + trace explorer
```

### Monorepo layout

```
signalman/
  services/
    gateway/        # HTTP entry point; opens the root span; drives coordinator over gRPC
    coordinator/    # saga orchestrator; drives hold→auth→confirm→capture→commit; compensations
    inventory/      # gRPC: Hold / Release; holds + per-SKU availability + outbox
    payments/       # gRPC: Authorize / Capture / Void; wraps simulated PSP + outbox
    supplier/       # gRPC: Confirm / Cancel; wraps simulated partner + outbox
    ledger/         # gRPC: Commit / Reverse; financial record + outbox
    notifier/       # event consumer: ledger.committed → simulated notification provider
    reconciler/     # periodic: source-of-truth comparison + divergence findings
  libs/
    otel/           # OTel SDK bootstrap: resource, OTLP exporters, SIGTERM/SIGINT flush
    propagation/    # W3C traceparent inject/extract for broker headers
    logging/        # trace-correlated structured JSON logger (NestJS LoggerService)
    interceptor/    # NestJS interceptor: SERVER span + RED metrics per handler
    outbox/         # transactional outbox: staging + trace-aware relay
    inbox/          # idempotent consumer: dedup + trace continuation
    broker/         # broker boundary: MessageBroker interface + InMemoryBroker + NatsBroker
  proto/            # gRPC .proto definitions (shared; loaded per service at runtime)
  docker/           # OTel Collector config, Tempo config, Grafana provisioning + dashboard
```

Libraries are imported via path aliases (`@signalman/otel`, `@signalman/broker`, etc.) configured in `tsconfig.json` and `nest-cli.json`.

---

## 3. Data and control flow

### 3.1 Happy-path booking saga

```
 HTTP client
     │
     │ POST /bookings {skuId, quantity, amount, customerId}
     ▼
 gateway
     │ opens ROOT span (POST /bookings [SERVER])
     │ injects traceparent into gRPC metadata
     │
     │ Coordinator.Book [CLIENT span]
     ▼
 coordinator
     │ Book [SERVER span] — continues the gateway's trace
     │
     ├─[saga.inventory.hold]
     │   Inventory.Hold [CLIENT] → inventory [SERVER]
     │   inventory: check availability, write hold + outbox row (one transaction)
     │   ← holdId
     │
     ├─[saga.payments.authorize]
     │   Payments.Authorize [CLIENT] → payments [SERVER]
     │   payments: PSP authorize [CLIENT → external], write auth + outbox row
     │   ← authorizationId
     │
     ├─[saga.supplier.confirm]
     │   Supplier.Confirm [CLIENT] → supplier [SERVER]
     │   supplier: partner confirm [CLIENT → external], write confirm + outbox row
     │   ← confirmationId
     │
     ├─[saga.payments.capture]
     │   Payments.Capture [CLIENT] → payments [SERVER]
     │   payments: PSP capture, write capture + outbox row
     │   ← captureId
     │
     └─[saga.ledger.commit]
         Ledger.Commit [CLIENT] → ledger [SERVER]
         ledger: write entry + outbox row (ledger.committed)
         ← entryId
     │
     ← BookResponse {booked:true, holdId, authorizationId, …, entryId}
     ▼
 gateway
     │ records outcome (PostgresBookingStore)
     │ ← 201 {bookingId, status:"booked", …, traceId}
     ▼
 HTTP client

 ── async, on the same traceId ───────────────────────────────────────────────

 ledger outbox relay
     │ drains outbox row; opens PRODUCER span (parented to Ledger.Commit [SERVER])
     │ publishes ledger.committed to NATS JetStream
     ▼
 NATS JetStream
     │ fan-out delivery
     │
     ├─► notifier (BrokerSubscriptionHost → IdempotentConsumer)
     │       CONSUMER span (fan-out: new root trace, span link to PRODUCER)
     │       SimulatedNotificationChannel.send [CLIENT]
     │       record notification (idempotent per bookingId)
     │
     └─► reconciler (BrokerSourceOfTruthGateway)
             projects event into per-booking cross-source snapshot
             (no span opened at subscribe time; reconcile.pass opens one later)
```

### 3.2 Compensation (failure) path

When any saga step rejects or throws, the coordinator unwinds all completed steps in reverse:

```
 coordinator: Book [SERVER]
     │
     ├─ saga.inventory.hold    ✓  holdId recorded
     ├─ saga.payments.authorize ✓  authorizationId recorded
     ├─ saga.supplier.confirm  ✗  partner outage → error span, saga stops
     │
     │  compensation unwind begins (reverse order of what succeeded):
     │
     ├─[saga.compensation.supplier.cancel]   signalman.saga.compensation=true
     │    Supplier.Cancel → supplier: idempotent no-op (nothing confirmed)
     │
     ├─[saga.compensation.payments.void]     signalman.saga.compensation=true
     │    Payments.Void → payments: PSP void, write voided + outbox row
     │
     └─[saga.compensation.inventory.release] signalman.saga.compensation=true
          Inventory.Release → inventory: release hold, write released + outbox row
     │
     ← BookResponse {booked:false, failedStep:"supplier.confirm", compensated:true}
```

All six spans (the three forward steps and the three compensations) appear under the single `Book [SERVER]` span in Tempo, making the full saga shape visible in one view.

### 3.3 Async event pipeline

The outbox→broker→inbox hop is where at-least-once delivery and idempotent consumption combine to give effectively-once processing, while keeping the trace connected:

```
Service (e.g. ledger)
  └─ runInTransaction(tx => {
       ledgerRepository.commit(entry, tx)       ← business state
       outboxStore.add(record, tx)              ← outbox row, same tx
     })
       ↑ both commit or neither does

OutboxRelay (polling every ~250ms)
  └─ for each claimable row:
       open PRODUCER span (parent = staged trace context)
       BrokerPublisher.publish(brokerMessage)
       mark row as published
         ↑ crash here → row re-claimable → re-delivered (at-least-once)

MessageBroker (NATS JetStream / InMemoryBroker)
  └─ fan-out to all subscribers on matching subjects

Consumer (e.g. notifier via BrokerSubscriptionHost)
  └─ toConsumedMessage(brokerMessage)
       IdempotentConsumer.consume(msg, handler)
         open CONSUMER span (fan-out=true → new root trace + span link to PRODUCER)
         InboxStore.processOnce(messageId, consumer, handler)
           INSERT … ON CONFLICT DO NOTHING  ← dedup marker
           handler()                        ← side effect
           commit both together
             ↑ crash here → redelivered → dedup skips re-run

```

**Subject routing** (NATS JetStream stream `signalman`):

| Subject | Produced by | Consumed by |
|---------|-------------|-------------|
| `inventory.held` | inventory | reconciler |
| `inventory.released` | inventory | reconciler |
| `payment.authorized` | payments | reconciler |
| `payment.captured` | payments | reconciler |
| `payment.voided` | payments | reconciler |
| `supplier.confirmed` | supplier | reconciler |
| `supplier.cancelled` | supplier | reconciler |
| `ledger.committed` | ledger | notifier, reconciler |
| `ledger.reversed` | ledger | reconciler |

The reconciler uses a wildcard subscription (`inventory.*`, `supplier.*`, `ledger.*`) to build its cross-service snapshot without knowing every event type up front.

### 3.4 Reconciliation pass

```
ReconciliationScheduler (interval: RECONCILER_INTERVAL_MS, default 30s)
  └─ ReconcilerService.runOnce()
       open reconcile.pass [SERVER span]
       SourceOfTruthGateway.getSettledBookings()
         ← all bookings whose last event is older than RECONCILER_SETTLE_GRACE_MS
       for each booking snapshot:
         detectDivergences(snapshot) → DivergenceKind[]
         for each new divergence (idempotent per bookingId + kind):
           open reconcile.divergence [span]
           add span link → booking's trace context  ← the key: jump to root cause
           FindingRepository.save(finding with traceId)
```

Three invariants checked by `detectDivergences`:

| Kind | Meaning | Severity |
|------|---------|----------|
| `supplier_confirmed_ledger_missing` | Partner confirmed, no financial record | Critical |
| `ledger_committed_supplier_unconfirmed` | Money posted, partner not holding | Critical |
| `orphaned_hold` | Inventory held, booking did not complete | Warning |

---

## 4. Library layer

Libraries are the shared, framework-light kernel. Each is importable via a `@signalman/*` alias. They carry their own unit tests and expose minimal, well-typed public surfaces.

### 4.1 `@signalman/otel`

**Role:** boot the OTel SDK once, before any application module loads, so auto-instrumentations can register their hooks.

**Key export:** `startTelemetry({ serviceName, serviceVersion })`

Returns a handle whose `shutdown()` flushes all pending spans and metrics. The module registers `SIGTERM`/`SIGINT` listeners to call it, so no spans are dropped on a graceful shutdown. Traces and metrics export over OTLP/HTTP; the endpoint is resolved from the standard `OTEL_EXPORTER_OTLP_*` environment variables (default `http://localhost:4318`). Exposes `getTracer(name)` and `getMeter(name)` for the libraries that create spans and metrics downstream.

**Design note:** Every service calls `startTelemetry` as the very first line of its `main.ts`, before `NestFactory.create`, so the NestJS HTTP and gRPC auto-instrumentations are patched before the first request arrives.

### 4.2 `@signalman/propagation`

**Role:** carry the W3C `traceparent` header across broker message headers, bridging the gap between OTel's standard HTTP/gRPC propagation and an async message envelope.

**Key exports:** `injectBrokerHeaders(carrier)`, `extractBrokerContext(carrier)`

The carrier is the `BrokerMessage.headers` record, which may hold `string`, `string[]` (NATS multi-value headers), or `Buffer` (Kafka) values. Normalisation is done at the boundary so callers see a plain `Record<string, string>` in both directions.

**Used by:** `@signalman/outbox` (inject when staging a record) and `@signalman/inbox` (extract on consume).

### 4.3 `@signalman/logging`

**Role:** structured JSON logger that automatically annotates every log line with the active span's `trace_id`, `span_id`, and `trace_flags`.

**Key exports:** `createLogger({ service, context? })`, `StructuredLogger`

Implements the NestJS `LoggerService` interface so `app.useLogger(logger)` routes all NestJS framework logs through the same correlated pipeline. `logger.child({ requestId, bookingId })` binds per-request fields without threading a context object through every call. Output is one JSON object per line; a log aggregator (e.g. Loki) can correlate directly to the trace.

### 4.4 `@signalman/interceptor`

**Role:** wrap every inbound handler in a SERVER span and record RED metrics.

**Key export:** `ObservabilityModule.forRoot({ scope, global? })`

On each inbound call the interceptor:
1. Resolves the transport context (HTTP or gRPC).
2. Extracts the upstream `traceparent` from gRPC metadata via `resolveParentContext` and starts a SERVER span that **continues** the caller's trace (or starts a root span for HTTP requests with no upstream parent).
3. Keeps the span active for the entire call duration so any child span the handler opens (a downstream CLIENT span, an outbox PRODUCER, a PSP call) is automatically parented to it.
4. On success, records the call in the `signalman.operation.duration` histogram and increments the request counter.
5. On error, marks the span `ERROR`, records the exception, and increments `signalman.operation.errors`.

Span and metric attributes map to the OTel RPC semantic conventions (`rpc.system`, `rpc.service`, `rpc.method` for gRPC; `http.request.method`, `url.template` for HTTP).

### 4.5 `@signalman/outbox`

**Role:** defeat the dual-write problem — a service writes its business state and an outbox row in one transaction so an event publishes if and only if the state change committed.

**Key exports:**
- `createOutboxRecord(opts)` — stages an event, capturing the active span context into the record's headers.
- `runInTransaction(fn)` / `UnitOfWork` — thread a unit of work through the business state write and the outbox `add` so both commit together or roll back together.
- `OutboxStore` — the broker- and database-agnostic persistence contract (add, claim, markPublished, markFailed, etc.).
- `InMemoryOutboxStore` — the reference store: models leasing, back-off, and dead-lettering exactly as a Postgres store would, so it can be used as a test double and a single-process reference.
- `PostgresOutboxStore` — production store: `SELECT … FOR UPDATE SKIP LOCKED` claiming prevents concurrent relay instances from double-publishing; staging and publish marking share a `PgUnitOfWork` so atomicity is real.
- `OutboxRelay` — background polling loop: for each claimable row it opens a PRODUCER span parented to the staged trace, publishes through a `Publisher`, and marks the row published. Capped exponential back-off on publish failure; dead-lettering after `maxAttempts`.
- `PgUnitOfWork` / `runInPgTransaction` — the Postgres counterpart to `runInTransaction`: threads a live pool client mid-transaction so the business write and the outbox row share one `BEGIN … COMMIT`.

**Durability guarantee (proven in `durability.spec.ts`):**
- A staging transaction that rolls back leaves no outbox row → no phantom event.
- A committed row is still published when the relay crashes mid-publish → no lost event.
- A crash between the broker accepting the message and the relay marking it published → redelivery, absorbed by the idempotent inbox.

### 4.6 `@signalman/inbox`

**Role:** the dedup half of effectively-once processing — a consumer records handled message IDs and skips redeliveries.

**Key exports:**
- `InboxStore` / `InboxStore.processOnce(messageId, consumer, fn)` — the single atomic primitive: dedup-check, run the handler, and record the marker in the **same transaction** as the handler's side effects.
- `InMemoryInboxStore` — reference store: claims synchronously (interleaved redeliveries cannot both run), rolls back on handler error, models `INSERT … ON CONFLICT DO NOTHING` semantics.
- `PostgresInboxStore` — production store: `INSERT … ON CONFLICT DO NOTHING` inside the handler's own transaction for race-free dedup under concurrent redelivery.
- `IdempotentConsumer` — wraps a broker handler: extracts the upstream trace context, opens a CONSUMER span continuing the publish trace (or a new root trace with a span link for fan-out), delegates to `InboxStore.processOnce`, and rethrows handler errors so the caller can NACK.

**Fan-out mode** (`fanOut: true`): the CONSUMER span opens a new root trace instead of continuing the PRODUCER's trace, and carries a span link back to the PRODUCER span. Used by the notifier and reconciler (both subscribe to overlapping subjects), so each consumer's trace is independent but navigable to the source event via the link.

### 4.7 `@signalman/broker`

**Role:** the transport boundary between the outbox and the inbox — the only thing either side depends on for async delivery.

**Key exports:**

*Core interface and reference:*
- `MessageBroker` — `publish(message)` + `subscribe(subjects, handler, opts?)` — the transport-agnostic surface.
- `InMemoryBroker` — reference implementation: NATS wildcard subject matching (`*` one token, `>` tail), fan-out per subscriber, queue-group load-balancing, at-least-once delivery (NACK → redelivery up to `maxDeliver` → dead-letter).

*Adapters:*
- `BrokerPublisher` — implements the outbox relay's `Publisher` over a `MessageBroker` (`toBrokerMessage` maps `eventType` to subject, preserves trace headers).
- `toConsumedMessage(brokerMessage)` — turns a delivered `BrokerMessage` into the inbox's `ConsumedMessage` (so the broker → inbox handoff is a one-liner).

*NATS JetStream transport (`NatsBroker`):*
- Maps `MessageBroker` onto JetStream primitives: a durable stream per `publish`, ephemeral push consumers for fan-out, shared durable consumers for queue groups, `ack()`/`nak()`/`term()` for at-least-once delivery with dead-lettering.
- `NatsBroker.connect(opts)` — owns a connection and provisions the stream idempotently.
- `NatsBroker.create(nc, opts)` — adapts a caller-owned connection.
- Trace-carrying headers round-trip via `encodeNatsHeaders`/`decodeNatsHeaders`.
- Verified end to end against a live JetStream server (`nats-broker.integration.spec.ts`, gated on `NATS_TEST_URL`).

*Per-service lifecycle helpers:*
- `createBrokerFromEnv()` — selects the transport from `BROKER` / `SIGNALMAN_BROKER` (`memory` default, `nats` for JetStream); returns `{ broker, kind, close }`.
- `OutboxRelayHost` — lifecycle owner on the producing side: starts the relay on `onApplicationBootstrap`, stops + flushes + closes on `onApplicationShutdown`. Registered as a NestJS provider, driven by Nest's lifecycle hooks.
- `BrokerSubscriptionHost` — lifecycle owner on the consuming side: establishes subscriptions on `onApplicationBootstrap`, drops them and closes on `onApplicationShutdown`.

---

## 5. Service layer

All eight services are built with NestJS and TypeScript. Each service's `main.ts` calls `startTelemetry` first, then `NestFactory.create` (or `createMicroservice` for gRPC services). All use the same built Docker image, differentiated by the `SERVICE_NAME` environment variable.

### 5.1 `gateway`

**Transport:** HTTP (Express, port `PORT`, default 3000).

**Responsibilities:**
- Open the booking's root span (`POST /bookings` SERVER span is the trace root).
- Validate the request body; mint a `bookingId` when the caller omits one.
- Call `Coordinator.Book` over gRPC, inject `traceparent` into the metadata.
- Record the outcome (success or failure) in `PostgresBookingStore` (`gateway.bookings` table).
- Serve `GET /bookings/:id` to read the recorded outcome back (carries `traceId` for operator navigation).
- Serve `GET /health`.

**Ports (hexagonal):** `CoordinatorPort` (gRPC client), `BookingStore` (Postgres-backed in production, in-memory reference in tests).

**Key env vars:** `PORT`, `COORDINATOR_GRPC_URL`.

### 5.2 `coordinator`

**Transport:** gRPC server (port from `COORDINATOR_GRPC_URL`, default `0.0.0.0:50050`).

**Responsibilities:**
- Drive the booking saga: `inventory.hold → payments.authorize → supplier.confirm → payments.capture → ledger.commit`.
- On any rejection or outage, unwind completed steps in reverse: `supplier.cancel → payments.void → inventory.release`.
- Make the saga shape visible as spans: one span per step, one per compensation, all under the `Book [SERVER]` span.
- Propagate the booking trace to each leg over gRPC (`callWithTrace` injects `traceparent` into request metadata).

**Ports (hexagonal):** `InventoryPort`, `PaymentsPort`, `SupplierPort`, `LedgerPort` (gRPC client adapters in production, in-memory fakes in tests).

**Key env vars:** `COORDINATOR_GRPC_URL`, `INVENTORY_GRPC_URL`, `PAYMENTS_GRPC_URL`, `SUPPLIER_GRPC_URL`, `LEDGER_GRPC_URL`.

### 5.3 `inventory`

**Transport:** gRPC server (port from `INVENTORY_GRPC_URL`, default `0.0.0.0:50051`).

**gRPC service:** `signalman.inventory.v1.Inventory`

| RPC | Behaviour |
|-----|-----------|
| `Hold(bookingId, sku, qty)` | Reserve stock; idempotent per booking; reject with `insufficient_stock` if would oversell |
| `Release(bookingId)` | Return reservation (compensation); idempotent no-op for unknown/released holds |

**Domain logic:** per-SKU availability counter; oversell guard is eager (checked before the transaction so a would-oversell request rolls the whole unit of work back before anything commits).

**Outbox events:** `inventory.held`, `inventory.released`.

**Datastore:** `PostgresHoldRepository` + `PostgresOutboxStore` when `POSTGRES_URL` is set; in-memory references otherwise.

### 5.4 `payments`

**Transport:** gRPC server (port from `PAYMENTS_GRPC_URL`, default `0.0.0.0:50052`).

**gRPC service:** `signalman.payments.v1.Payments`

| RPC | Behaviour |
|-----|-----------|
| `Authorize(bookingId, amount, currency)` | PSP authorize; idempotent per booking; returns decline reason as data |
| `Capture(bookingId)` | PSP capture; idempotent |
| `Void(bookingId)` | PSP void (compensation); idempotent no-op for unknown/voided |

**External boundary:** `SimulatedPsp` — controllable via `PSP_LATENCY_MS`, `PSP_DECLINE_RATE`, `PSP_FAILURE_RATE`. Every PSP call is wrapped in a CLIENT span. The PSP call runs *before* the transaction (cannot roll back); a rollback never leaves a charged PSP without a recorded payment.

**Outbox events:** `payment.authorized`, `payment.captured`, `payment.voided`.

**Datastore:** `PostgresPaymentRepository` + `PostgresOutboxStore` when `POSTGRES_URL` is set.

### 5.5 `supplier`

**Transport:** gRPC server (port from `SUPPLIER_GRPC_URL`, default `0.0.0.0:50053`).

**gRPC service:** `signalman.supplier.v1.Supplier`

| RPC | Behaviour |
|-----|-----------|
| `Confirm(bookingId, sku, qty)` | Partner confirmation; idempotent per booking; returns rejection reason as data |
| `Cancel(bookingId)` | Partner cancel (compensation); idempotent no-op for unknown/cancelled |

**External boundary:** `SimulatedSupplierPartner` — deliberately slower and flakier than the PSP; controllable via `SUPPLIER_LATENCY_MS`, `SUPPLIER_REJECT_RATE`, `SUPPLIER_FAILURE_RATE`. The partner call runs before the transaction. This is the service most likely to induce divergence in demos.

**Outbox events:** `supplier.confirmed`, `supplier.cancelled`.

**Datastore:** `PostgresConfirmationRepository` + `PostgresOutboxStore` when `POSTGRES_URL` is set.

### 5.6 `ledger`

**Transport:** gRPC server (port from `LEDGER_GRPC_URL`, default `0.0.0.0:50054`).

**gRPC service:** `signalman.ledger.v1.Ledger`

| RPC | Behaviour |
|-----|-----------|
| `Commit(bookingId, amount, currency, captureId)` | Post the financial entry; idempotent per booking; reject non-positive amounts as `invalid_amount` |
| `Reverse(bookingId)` | Back out the posting (compensation); idempotent no-op for unknown/reversed |

**No external boundary:** the ledger is the internal financial record; a `Commit` with a valid amount always succeeds. The `uint64 amount` is decoded as a JS `number` at the gRPC boundary (`loader: { longs: Number }`).

**Outbox events:** `ledger.committed`, `ledger.reversed`. The `ledger.committed` event is the trigger for both the notifier and the reconciler's snapshot.

**Datastore:** `PostgresLedgerRepository` + `PostgresOutboxStore` when `POSTGRES_URL` is set.

### 5.7 `notifier`

**Transport:** none (pure event consumer; boots as a NestJS application context).

**Responsibilities:**
- Subscribe to `ledger.committed` via `BrokerSubscriptionHost` on bootstrap.
- Process each delivery through `IdempotentConsumer` (dedup namespace `notifier`, `fanOut: true`).
- Tell the customer via `SimulatedNotificationChannel` (CLIENT span on the booking trace).
- Guard against provider outages by propagating errors (broker NACKs and redelivers).
- Idempotent at two layers: inbox dedup by message id, `NotifierService` notifies each booking at most once.

**External boundary:** `SimulatedNotificationChannel` — controllable via `NOTIFIER_LATENCY_MS`, `NOTIFIER_FAILURE_RATE`. No business rejection: a send either succeeds or the provider is unreachable (outage → NACK).

**Datastore:** in-memory notification store (Postgres-backed version behind the same DI token for production).

### 5.8 `reconciler`

**Transport:** none (periodic background job; boots as a NestJS application context).

**Responsibilities:**
- Subscribe to `inventory.*`, `supplier.*`, `ledger.*` via `BrokerSubscriptionHost`; project each event into a per-booking cross-source snapshot (`BrokerSourceOfTruthGateway`).
- Apply a settle-grace window (`RECONCILER_SETTLE_GRACE_MS`, default 5 s) so in-flight bookings are never flagged as divergent before their saga completes.
- Run `ReconcilerService.runOnce()` on an interval (`RECONCILER_INTERVAL_MS`, default 30 s), never letting a failed pass kill the loop.
- For each settled booking, run `detectDivergences(snapshot)` and persist new findings (idempotent per `(bookingId, kind)`).
- Open a `reconcile.divergence` span per finding with a span link to the originating booking's trace context.

**Key env vars:** `RECONCILER_INTERVAL_MS`, `RECONCILER_SETTLE_GRACE_MS`.

---

## 6. Observability pipeline

### 6.1 Trace propagation

The trace flows through three transport types; `@signalman/propagation` bridges them.

**gRPC hops (synchronous):**
- The calling side opens a CLIENT span and calls `injectTraceMetadata(metadata)` to write the W3C `traceparent` into the gRPC request metadata.
- The receiving side's `@signalman/interceptor` calls `resolveParentContext(metadata)` to extract it and uses the result as the SERVER span's parent context.
- Result: the receiving service's SERVER span is a child of the calling service's CLIENT span, both on the same `traceId`.

**Broker hops (async):**
- The outbox relay opens a PRODUCER span parented to the trace context captured when the record was staged.
- It calls `injectBrokerHeaders(headers)` to write `traceparent` into the broker message headers.
- The `IdempotentConsumer` calls `extractBrokerContext(headers)` and opens a CONSUMER span. For `fanOut: false` the CONSUMER span continues the PRODUCER's trace; for `fanOut: true` it opens a new root trace and carries a span link to the PRODUCER's `spanContext`.

**External boundary hops:**
- Each external call (PSP, partner, notification provider) is wrapped in a CLIENT span as the child of the service's SERVER span. Errors on that span mark the external boundary failure distinctly from the service itself.

**Reconciler findings:**
- Each `reconcile.divergence` span carries a span link to the originating booking's trace context (looked up from the snapshot). A span link in Tempo is a clickable navigation to the linked trace — the "jump to root cause" payoff.

### 6.2 RED metrics

`@signalman/interceptor` records two OTel metrics per handler:

| Metric | Type | Tags |
|--------|------|------|
| `signalman.operation.duration` | Histogram (seconds) | `operation`, `transport`, `outcome` |
| `signalman.operation.errors` | Counter | `operation`, `transport`, `error.type` |

The OTel Collector exports these via its Prometheus exporter (port 8889). The pre-provisioned Grafana dashboard reads them, with:
- A **RED summary** row (rate, error ratio, p50/p99 across all operations).
- A **per-service RED** row.
- A **per-step SLO** row — 14 stat panels (p99 latency SLO + error-rate SLO per saga step: gateway, coordinator, inventory hold, payments authorize, supplier confirm, payments capture, ledger commit), each showing green/yellow/red against step-specific thresholds.
- A **trace explorer** panel linking metric exemplars to traces via Tempo.

### 6.3 Structured logging

`@signalman/logging` wraps every `logger.info(msg, fields)` call in a JSON object:

```json
{
  "timestamp": "2026-06-30T12:00:00.000Z",
  "level": "info",
  "service": "coordinator",
  "context": "BookingSaga",
  "message": "hold placed",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "trace_flags": "01",
  "booking_id": "bk_1"
}
```

`trace_id` and `span_id` are lifted from the active OTel span at log time (via `context.active().getValue`), so every log line is linked to the span — and therefore the booking — it was written under. A log aggregator indexing on `trace_id` (e.g. Grafana Loki) can correlate logs to the corresponding trace in Tempo.

---

## 7. Key design decisions

### Orchestrated saga, not choreographed

The coordinator is an explicit orchestrator: it drives each step and knows the full saga shape. This makes compensations and the saga's state trivially visible as spans under one SERVER span — a choreographed approach would scatter that state across independent event handlers, requiring cross-service correlation to reconstruct the saga's path. The spec explicitly calls for trace clarity, and orchestration wins here.

### Hexagonal architecture per service

Every service depends on *ports* (interfaces) rather than concrete adapters. The coordinator depends on `InventoryPort`, not a gRPC client; a service depends on `HoldRepository`, not a Postgres table. This lets unit tests swap in in-memory fakes without mocking the OTel SDK or gRPC transport, and lets the datastore tier (Postgres) and the broker tier (NATS) slot in behind the same DI tokens without touching business logic.

### Transactional outbox over dual-write

Writing to a broker directly from a service creates a dual-write: if the service crashes after the broker accepts the message but before the database commits, the event exists without the state — or vice versa. The outbox writes both in one transaction and lets a relay drain the outbox onto the broker separately. The relay's at-least-once semantics mean a crash redelivers rather than loses; the idempotent inbox absorbs the duplicate.

### Idempotency at the legs, not the coordinator

The coordinator retries by replaying `Book` with the same `bookingId`. Each leg is idempotent per `bookingId` — a retried `Hold` returns the standing reservation rather than reserving twice. This means the coordinator's retry logic is simple (replay the whole saga), and no central idempotency store is needed.

### Fan-out via span links, not child spans

When the same event is consumed by multiple independent consumers (the notifier and the reconciler both subscribe to `ledger.*`), each consumer's work belongs on its own trace — it has its own latency budget, its own failure semantics, and its own lifecycle. Child spans would tie those independent traces together. Instead, `fanOut: true` opens a new root trace per consumer and carries a span link back to the PRODUCER span, so each trace is independent but navigable to the source.

### Settle-grace window in the reconciler

The reconciler compares snapshots built from events. A saga that is still in flight will look divergent (inventory held, no ledger commit yet) until the saga completes. The settle-grace window (`RECONCILER_SETTLE_GRACE_MS`) filters out bookings whose last event is too recent, so only bookings whose event stream has gone quiet are eligible for comparison. This prevents false-positive divergence findings on healthy, in-progress bookings.

### External calls outside the transaction

Both payments and the supplier call an external party (PSP, partner) before writing their state and outbox row to the database. This is intentional: a database transaction can roll back, but a PSP charge or a partner confirmation cannot. Running the external call outside the transaction means:
- A rollback never leaves a charged PSP without a recorded payment.
- A retried call (`bookingId` already known) is idempotent at the external boundary.
- The transaction scope covers only things that can roll back.

---

## 8. External dependencies

| Dependency | Version | Role |
|------------|---------|------|
| NestJS | 10.x | Service framework (HTTP + gRPC microservices, DI, lifecycle hooks) |
| `@grpc/grpc-js` | 1.x | gRPC transport |
| `@nestjs/microservices` | 10.x | NestJS gRPC microservice support |
| `nats` | 2.x | NATS JetStream client library |
| `pg` | 8.x | Postgres client |
| `@opentelemetry/sdk-node` | 0.5x | OTel Node.js SDK |
| `@opentelemetry/exporter-trace-otlp-http` | 0.5x | OTLP/HTTP trace exporter |
| `@opentelemetry/exporter-metrics-otlp-http` | 0.5x | OTLP/HTTP metrics exporter |
| `@opentelemetry/semantic-conventions` | 1.4x | OTel semconv constants |
| TypeScript | 5.x | Language |
| Jest + ts-jest | 29.x | Test runner |
| ESLint (flat config) | 9.x | Linter |

**Infrastructure (docker-compose):**

| Service | Image | Role |
|---------|-------|------|
| NATS JetStream | `nats:2.10-alpine` | Event broker; durable stream |
| Postgres | `postgres:16-alpine` | One schema per service, single instance |
| OTel Collector | `otel/opentelemetry-collector-contrib:0.104.0` | OTLP receiver; batch processor; Tempo exporter; Prometheus exporter |
| Grafana Tempo | `grafana/tempo:2.5.0` | Distributed trace backend; queried by Grafana |
| Grafana | `grafana/grafana:11.0.0` | Dashboards + trace explorer; anonymous access |

---

## 9. Where the spec maps to code

| Spec requirement | Primary code location |
|------------------|-----------------------|
| 4–5 NestJS services, each with its own datastore | `services/{inventory,payments,supplier,ledger,coordinator,gateway,notifier,reconciler}` |
| gRPC for synchronous commands | `proto/*.proto`, `@grpc/grpc-js`, `@nestjs/microservices` |
| Broker events for async coordination | `@signalman/broker`, `OutboxRelayHost`, `BrokerSubscriptionHost` |
| Saga coordinator with compensations | `services/coordinator/src/saga/booking-saga.ts` |
| Transactional outbox | `libs/outbox/src/{record,store,relay,transaction}.ts`, `PostgresOutboxStore` |
| Outbox proven under crash | `libs/outbox/src/durability.spec.ts` |
| Idempotent consumers | `libs/inbox/src/{store,consumer}.ts`, `IdempotentConsumer` |
| OpenTelemetry — one booking one trace | `libs/{otel,propagation,interceptor}`, CLIENT/SERVER span injection in `services/coordinator/src/grpc/leg-clients.ts` |
| Fan-out span links | `libs/inbox/src/consumer.ts` (`fanOut: true`), `libs/broker/src/trace-continuity.spec.ts` |
| Reconciler + divergence findings | `services/reconciler/src/reconciliation/{reconciliation,reconciler.service,broker-gateway}.ts` |
| RED metrics + per-step SLOs | `libs/interceptor/src/{interceptor,metrics}.ts`, `docker/grafana/dashboards/signalman.json` |
| Trace-correlated logs | `libs/logging/src/logger.ts` |
| `docker-compose up` one-command stack | `docker-compose.yml`, `Dockerfile`, `docker/` |
| External supplier timeout/failure injection | `services/supplier/src/partner/simulated-partner.ts` |
| Spans align to OTel semconv | `libs/interceptor/src/operation.spec.ts`, `libs/broker/src/trace-continuity.spec.ts` |
