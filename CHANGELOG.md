# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — 2026-06-29
- `services/notifier`: the async **tail** of the saga — the `… -> notify` step,
  and the first real consumer of `@signalman/inbox`. Unlike the four legs the
  notifier is not a synchronous gRPC participant; it is a pure **event consumer**
  that reacts to a booking's terminal `ledger.committed` event off the broker and
  tells the customer. A `BookingNotificationConsumer` wraps the
  `IdempotentConsumer` (dedup namespace `notifier`): it continues the booking's
  trace — the consume span is a CONSUMER child of the publisher's span, so the
  notification lands on the *same* trace — and dedups by message id, turning
  at-least-once delivery into effectively-once processing. A `NotifierService`
  does the work **idempotently per booking** (notified at most once), so a second
  message about the same booking sends nothing twice. Behind it sits a **simulated
  notification provider** (`SimulatedNotificationChannel`) — another external
  boundary with controllable latency/failure (`NOTIFIER_LATENCY_MS`,
  `NOTIFIER_FAILURE_RATE`), every send a **CLIENT span** on the booking trace; a
  provider **outage** propagates so the consumer NACKs and the broker redelivers,
  recording nothing so the redelivery genuinely retries. Being terminal, the
  notifier keeps a notification source-of-truth record (a fourth thing the
  reconciler can check) but stages no outbox event. It boots as a standalone Nest
  application context (no synchronous surface) and is unit-tested end to end —
  process-once, redelivery, two-layer dedup, trace continuation with the provider
  hop nested under the consume span, and NACK-on-outage. The Postgres-backed
  notification/inbox stores and the broker subscription that feeds the consumer
  land with later milestones.

### Added — 2026-06-28
- `services/coordinator`: the saga orchestrator — the coordinating heart of the
  system, and the happy-path booking end to end (M1). A NestJS gRPC microservice
  serves the `Coordinator` contract (`Book`, `proto/coordinator.proto`); a single
  `Book` drives the booking through five legs in order — `inventory.hold →
  payments.authorize → supplier.confirm → payments.capture → ledger.commit` — and
  returns either every leg's truth handle or the step that stopped the saga, its
  reason, and whether the completed steps were unwound. On any **rejection** (a
  leg's business "no", returned as data) or **outage** (a thrown error) the saga
  runs the completed steps' **compensations in reverse** (`supplier.cancel →
  payments.void → inventory.release`), best-effort over the idempotent leg
  compensations so a partial unwind still completes (M4 in shape). Idempotency is
  delegated to the legs (every downstream command is keyed by `booking_id`), so a
  retried `Book` replays the saga without double-booking. Every forward step and
  compensation runs in its own span under the `Book` SERVER span — a rejection
  annotates its span with the outcome and reason, an outage marks it errored, and
  a compensation span is flagged. The orchestrator depends only on four leg
  **ports**, so it is unit-tested against in-memory fakes; in production those
  ports are gRPC client adapters dialling the real services (`INVENTORY_GRPC_URL`,
  `PAYMENTS_GRPC_URL`, `SUPPLIER_GRPC_URL`, `LEDGER_GRPC_URL`). The service boots
  as a standalone gRPC microservice with telemetry started first, and the whole
  booking — happy path and a first-step rejection — is verified end to end against
  all four live leg services over gRPC.
- `services/ledger`: the fourth saga participant — the financial-record source of
  truth, the `capture + commit to ledger` leg of the booking saga. A NestJS gRPC
  microservice serves the `Ledger` contract (`Commit`/`Reverse`,
  `proto/ledger.proto`) and owns the record of what actually happened
  financially. `Commit` posts the booking's money and is idempotent per booking
  (a retry returns the standing entry; a non-positive amount is reported as data
  with a reason), and `Reverse` — the saga compensation — is an idempotent no-op
  once already reversed or absent. Unlike the inventory, payments, and supplier
  legs the ledger wraps **no external boundary**: it is our own authoritative
  record, so a commit has no outage path, only the business rejection. The
  `uint64 amount` field is decoded as a JS number at the gRPC boundary
  (`loader: { longs: Number }`) so the posted amount and its event payloads are
  plain numbers — what the reconciler later compares against the other sources of
  truth. Each state change stages a `ledger.committed`/`.reversed` event through
  `@signalman/outbox`, and every gRPC handler is wrapped in
  `@signalman/interceptor`'s SERVER span. In-memory ledger and outbox stores stand
  in until the Postgres-backed stores land; the service boots as a standalone gRPC
  microservice with telemetry started first, verified end to end with a real gRPC
  client.

### Added — 2026-06-28
- `services/supplier`: the third saga participant — the partner source of truth,
  the confirmation leg of the booking saga. A NestJS gRPC microservice serves the
  `Supplier` contract (`Confirm`/`Cancel`, `proto/supplier.proto`) and owns
  partner confirmations. `Confirm` is idempotent per booking (a retry returns the
  standing confirmation; a partner rejection is reported as data with a reason),
  and `Cancel` — the saga compensation — is an idempotent no-op once already
  cancelled or absent. Behind it sits a **simulated external partner**
  (`SimulatedSupplierPartner`) — the source of truth the spec calls *deliberately
  slow and flaky*, where divergence is born — with controllable latency and
  reject/failure injection (`SUPPLIER_LATENCY_MS`, `SUPPLIER_REJECT_RATE`,
  `SUPPLIER_FAILURE_RATE`, defaulting slower/flakier than the PSP); every partner
  call is a CLIENT span (the external boundary hop), and the service distinguishes
  a rejection (returned data) from a partner outage (a thrown error that errors
  the gRPC span so the hop is observable). Each state change stages a
  `supplier.confirmed`/`.cancelled` event through `@signalman/outbox`, and every
  gRPC handler is wrapped in `@signalman/interceptor`'s SERVER span. In-memory
  confirmation and outbox stores stand in until the Postgres-backed stores land;
  the service boots as a standalone gRPC microservice with telemetry started
  first, verified end to end with a real gRPC client.

### Added — 2026-06-28
- `services/payments`: the second saga participant — the payments source of
  truth, the money leg of the booking saga. A NestJS gRPC microservice serves
  the `Payments` contract (`Authorize`/`Capture`/`Void`, `proto/payments.proto`)
  and owns authorizations and captures. `Authorize` is idempotent per booking (a
  retry returns the standing authorization; a PSP decline is reported as data
  with a reason), `Capture` is the idempotent money-taking step, and `Void` —
  the saga compensation — is an idempotent no-op once already voided or absent.
  Behind it sits a **simulated PSP** (`SimulatedPsp`) — the external source of
  truth the spec calls out as where divergence is born — with controllable
  latency and decline/failure injection (`PSP_LATENCY_MS`, `PSP_DECLINE_RATE`,
  `PSP_FAILURE_RATE`); every PSP call is a CLIENT span (the external boundary
  hop), and the service distinguishes a decline (returned data) from a PSP outage
  (a thrown error that errors the gRPC span so the hop is observable). Each state
  change stages a `payment.authorized`/`.captured`/`.voided` event through
  `@signalman/outbox`, and every gRPC handler is wrapped in
  `@signalman/interceptor`'s SERVER span. In-memory payment and outbox stores
  stand in until the Postgres-backed stores land; the service boots as a
  standalone gRPC microservice with telemetry started first, verified end to end
  with a real gRPC client.

### Added — 2026-06-28
- `services/inventory`: the first downstream saga participant — the inventory
  source of truth. A NestJS gRPC microservice serves the `Inventory` contract
  (`Hold`/`Release`, `proto/inventory.proto`) and owns holds plus per-SKU
  availability. `Hold` is idempotent per booking (a retry returns the standing
  reservation rather than reserving twice; an over-capacity request is rejected
  with a reason), and `Release` — the saga compensation — is an idempotent no-op
  once a hold is already released or absent, so it can fire repeatedly without
  over-restoring stock. Each state change stages an `inventory.held` /
  `inventory.released` event through `@signalman/outbox`, and every gRPC handler
  is wrapped in `@signalman/interceptor`'s SERVER span (the inventory hop of the
  booking trace) so the staged events continue from it. In-memory hold and
  outbox stores stand in until the Postgres-backed stores land; the service
  boots as a standalone gRPC microservice with telemetry started first, verified
  end to end with a real gRPC client.

### Added — 2026-06-28
- `libs/inbox`: idempotent inbox — the dedup half of effectively-once delivery.
  `InboxStore.processOnce` is the atomic dedup primitive: it records a per-consumer
  marker in the **same transaction** as the handler's side effects, so a first
  delivery runs the handler and commits both together while a redelivery is
  skipped without re-running it. `InMemoryInboxStore` is the reference
  implementation — it claims synchronously (interleaved redeliveries cannot both
  run) and rolls the marker back when the handler throws, modelling
  `INSERT … ON CONFLICT DO NOTHING` plus the handler under one transaction.
  `IdempotentConsumer` wraps a broker handler: it extracts the upstream trace
  context and opens a CONSUMER span continuing the publish trace (so the consume
  span joins the same booking trace), skips redeliveries (tagged
  `signalman.inbox.duplicate` on the span rather than dropped silently), and
  records then rethrows handler errors so the caller can NACK. Dedup is namespaced
  per consumer so fan-out consumers each process a message once. Pairs with
  `libs/outbox` for effectively-once processing.

### Added — 2026-06-28
- `libs/outbox`: transactional outbox. `createOutboxRecord` stages an event into
  a durable record, capturing the active trace context into its headers, so a
  service can write its state and its outbox row in one local transaction and
  defeat the dual-write problem (no lost or phantom events). `OutboxStore` is the
  broker- and database-agnostic persistence contract; `InMemoryOutboxStore` is a
  reference implementation modelling leasing, back-off rescheduling, and
  dead-lettering. `OutboxRelay` drains the store and publishes each row under a
  PRODUCER span parented to the staged trace — re-injecting that span's context
  into the outgoing headers — so the saga step, publish hop, and consume span
  form one connected booking trace. Delivery is at-least-once (claim leasing with
  crash recovery) with capped exponential back-off, dead-lettering after a
  configurable attempt budget, and an overlap-safe polling scheduler.

### Added — 2026-06-28
- `libs/interceptor`: NestJS observability interceptor. Wraps every inbound
  handler in a SERVER span made active for the call (so child spans join the
  trace) and records RED metrics — a `signalman.operation.duration` histogram
  (rate via count, duration via distribution) and a `signalman.operation.errors`
  counter — tagged with low-cardinality `operation`/transport/`outcome`
  dimensions. Resolves HTTP and gRPC contexts onto the OTel RPC/HTTP semantic
  conventions, marks errored spans with `error.type` and a recorded exception,
  and ships an `ObservabilityModule.forRoot({ scope })` that wires it (globally
  by default) using the `@signalman/otel` tracer and meter.

### Added — 2026-06-28
- `libs/logging`: trace-correlated structured JSON logger. `createLogger`/
  `StructuredLogger` emit one JSON object per line carrying `timestamp`, `level`,
  `service`, and the active span's `trace_id`/`span_id`/`trace_flags`, so logs
  link back to the span (and booking) they were written under. Implements the
  NestJS `LoggerService` interface (drops into `app.useLogger`), supports
  `child()` bindings for per-unit-of-work context/fields, level thresholds, and
  defensive serialisation of `Error`/`bigint`/circular field values.

### Added — 2026-06-28
- `libs/otel`: OpenTelemetry SDK bootstrap for services — `startTelemetry`
  wires resource identity, OTLP/HTTP trace and metric exporters (resolved from
  the standard `OTEL_EXPORTER_OTLP_*` env vars, defaulting to the local
  Collector), and a managed start/flush lifecycle with graceful shutdown on
  `SIGTERM`/`SIGINT`. Includes `getTracer`/`getMeter` accessors.

### Changed — 2026-06-28
- Upgraded the OpenTelemetry stack to the 2.x line (`@opentelemetry/core` 2.x,
  `semantic-conventions` 1.41) for a single consistent SDK major.

### Added — 2026-06-28
- NestJS + TypeScript monorepo scaffold with strict TypeScript, Jest, ESLint
  (flat config), Prettier, and a GitHub Actions CI pipeline (lint → typecheck →
  build → test).
- `libs/propagation`: W3C trace-context inject/extract helpers that carry
  `traceparent`/`tracestate` across broker message headers, normalising
  string, string-array (NATS), and `Buffer` (Kafka) carrier shapes.
- `services/gateway`: HTTP entry point exposing a `/health` probe.
