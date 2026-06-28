# Progress

A living checklist tracking `signalman` against [`spec.md`](spec.md). Status
legend: ☐ not started, ◐ in progress, ☑ done.

## Implementation

Milestones are derived from the spec's milestone table. Each is broken into the
concrete slices needed to call it done.

### M0 — Scaffold ◐

- ☑ NestJS + TypeScript monorepo tooling (`nest-cli.json`, `tsconfig`, strict mode)
- ☑ Jest test runner wired to the monorepo path aliases
- ☑ ESLint (flat config) + Prettier
- ☑ CI workflow: install → lint → typecheck → build → test
- ☑ `libs/propagation` — W3C trace-context inject/extract for broker headers
- ☑ `services/gateway` — HTTP entry point with a health probe
- ☑ All eight services scaffolded:
  - ☑ `inventory` — gRPC `Hold`/`Release` over NestJS microservices, holds +
    per-SKU availability domain, outbox-staged `inventory.held`/`.released`
    events, observability interceptor on every gRPC handler; boots as a
    standalone gRPC microservice and verified end to end with a real client
  - ☑ `payments` — gRPC `Authorize`/`Capture`/`Void` over NestJS microservices,
    payment source of truth wrapping a **simulated PSP** (controllable latency +
    decline/failure injection, each call a CLIENT span — the external boundary
    hop), outbox-staged `payment.authorized`/`.captured`/`.voided` events,
    observability interceptor on every gRPC handler; boots as a standalone gRPC
    microservice and verified end to end with a real client
  - ☑ `supplier` — gRPC `Confirm`/`Cancel` over NestJS microservices, the
    partner source of truth wrapping a **simulated external partner**
    (deliberately slow + flaky: controllable latency + reject/failure injection,
    each call a CLIENT span — the partner boundary hop), outbox-staged
    `supplier.confirmed`/`.cancelled` events, observability interceptor on every
    gRPC handler; boots as a standalone gRPC microservice and verified end to end
    with a real client
  - ☑ `ledger` — gRPC `Commit`/`Reverse` over NestJS microservices, the
    **internal** financial-record source of truth (no external boundary: a commit
    is a posting that always succeeds for a positive amount, a non-positive amount
    is rejected as data), outbox-staged `ledger.committed`/`.reversed` events,
    observability interceptor on every gRPC handler; decodes the `uint64 amount`
    as a JS number at the boundary (`loader: { longs: Number }`) so posted amounts
    and event payloads are plain numbers; boots as a standalone gRPC microservice
    and verified end to end with a real client
  - ☑ `coordinator` — the saga orchestrator. Serves `Coordinator.Book` over
    NestJS gRPC microservices; a single `Book` drives `inventory.hold →
    payments.authorize → supplier.confirm → payments.capture → ledger.commit`
    through four gRPC leg-client ports and unwinds the completed steps in reverse
    on any failure (rejection or outage). Every step and compensation is its own
    span under the `Book` SERVER span; the orchestrator depends only on the leg
    ports so it is unit-tested against in-memory fakes, and the whole booking is
    verified end to end against all four live leg services over gRPC
  - ☑ `notifier` — the async tail of the saga. Boots as a standalone Nest
    application context (a pure event consumer, no synchronous gRPC/HTTP surface);
    a `BookingNotificationConsumer` wraps `@signalman/inbox`'s `IdempotentConsumer`
    (dedup namespace `notifier`) to consume `ledger.committed` on the booking's
    own trace and tell the customer via a **simulated notification provider**
    (`SimulatedNotificationChannel`: controllable latency + failure injection, each
    send a CLIENT span — the provider boundary hop). Idempotent at two layers —
    the inbox skips a redelivered message id, and `NotifierService` notifies each
    booking at most once — so neither redelivery double-sends; a provider outage
    rethrows for NACK without recording. Terminal consumer, so it keeps a
    notification source-of-truth record but stages no outbox event. Unit-tested
    end to end (process-once, redelivery, two-layer dedup, trace continuation with
    the provider hop nested under the consume span, NACK-on-outage) and verified to
    boot
  - ☑ `reconciler` — the periodic comparison of the sources of truth. Boots as a
    standalone Nest application context (a background job, no synchronous gRPC/HTTP
    surface); a `ReconciliationScheduler` runs `ReconcilerService.runOnce` on an
    interval (`RECONCILER_INTERVAL_MS`, surviving a failed pass so the backstop
    keeps running). Each pass pulls settled bookings from a `SourceOfTruthGateway`,
    compares each across inventory/supplier/ledger with the pure
    `detectDivergences` engine (three invariants: `supplier_confirmed_ledger_missing`
    — the headline — `ledger_committed_supplier_unconfirmed`, and `orphaned_hold`),
    and records each new disagreement as a `DivergenceFinding`, idempotent per
    `(bookingId, kind)`. Every pass runs under a `reconcile.pass` span and every
    new finding opens a `reconcile.divergence` span carrying a **span link** back
    to the originating booking trace (and stamps the finding's `traceId`) — the
    "finding linked to the trace" payoff. Unit-tested end to end against the
    in-memory gateway/findings reference stores (detection across all invariants,
    cross-pass idempotency, trace-linked spans, pass-error handling) and verified
    to boot; the broker/Postgres-backed gateway and findings store land with the
    datastore/broker milestones behind the same DI tokens
- ☑ `libs/otel` — OpenTelemetry SDK bootstrap: OTLP/HTTP exporters, resource identity, managed start/flush lifecycle
- ☑ `libs/logging` — trace-correlated structured JSON logger (NestJS `LoggerService`, lifts `trace_id`/`span_id`/`trace_flags` from the active span)
- ☑ `libs/interceptor` — NestJS observability interceptor: per-handler SERVER span (active for the call so child spans join the trace) + RED metrics (duration histogram + error counter), HTTP/gRPC mapped to OTel semconv, wired via `ObservabilityModule.forRoot`
- ☑ Remaining libs scaffolded: `outbox` ☑, `inbox` ☑
  - ☑ `libs/outbox` — transactional outbox: durable record + trace capture (`createOutboxRecord`), `OutboxStore` contract, `InMemoryOutboxStore` reference (leasing, back-off, dead-letter), and a `OutboxRelay` that publishes each row under a PRODUCER span parented to the staged trace (at-least-once, capped exponential back-off, dead-lettering)
  - ☑ `libs/inbox` — idempotent consumer: `InboxStore.processOnce` dedup contract (marker committed atomically with the handler's side effects), `InMemoryInboxStore` reference (synchronous claim, rollback-on-failure), and an `IdempotentConsumer` that opens a CONSUMER span continuing the message's trace, skips redeliveries (tagged on the span), and rethrows handler errors for NACK — the dedup core that pairs with the outbox for effectively-once
- ☐ Postgres per service, broker (NATS JetStream/Kafka), OTel Collector
- ☐ One-command `docker-compose` stack (services + broker + collector + Tempo + Grafana)

### M1 — Happy-path saga ◐

- ◐ gRPC contracts for the synchronous commands — `coordinator.proto` (`Book`),
  `inventory.proto` (`Hold`/`Release`), `payments.proto`
  (`Authorize`/`Capture`/`Void`), `supplier.proto` (`Confirm`/`Cancel`), and
  `ledger.proto` (`Commit`/`Reverse`) defined and served; the notifier contract
  upcoming
- ◐ Coordinator drives `hold → authorize → confirm → capture → commit` over gRPC
  (verified end to end against the four live leg services); the async `notify`
  step is implemented in the `notifier` service, which consumes `ledger.committed`
  and notifies the customer — the broker that delivers that event between the two
  lands with the broker milestone
- ◐ Per-service state — inventory owns holds and per-SKU availability; payments
  owns authorizations and captures, wrapping a simulated PSP; supplier owns
  partner confirmations, wrapping a simulated external partner; ledger owns the
  financial record (commit/reverse, no external boundary) (in-memory reference
  stores; the Postgres-backed stores land with the datastore milestone)

### M2 — Outbox ◐

- ◐ Transactional outbox table + relay per service — reusable `libs/outbox`
  (record staging, store contract, trace-aware relay) is built and unit-tested;
  the inventory service stages `inventory.held`/`inventory.released`, the
  payments service stages `payment.authorized`/`.captured`/`.voided`, the
  supplier service stages `supplier.confirmed`/`.cancelled`, and the ledger
  service stages `ledger.committed`/`.reversed` events through an `OutboxStore`
  alongside their state changes; the Postgres-backed `OutboxStore` and
  per-service relay wiring (broker) land next
- ☐ Crash test: no lost and no phantom events

### M3 — Trace propagation ◐

- ◐ One booking = one connected trace across gRPC, async events, external hop —
  the **synchronous gRPC half is wired**. The coordinator's leg clients open a
  CLIENT span per RPC and inject the W3C `traceparent` into the request metadata
  (`callWithTrace` / `injectTraceMetadata` in `services/coordinator/src/grpc`),
  and `@signalman/interceptor` extracts that context on the SERVER side
  (`resolveParentContext`) so each leg handler span **continues** the booking
  trace instead of starting an orphan. Round-tripped end to end in unit tests
  (client inject → server extract → same `traceId`, the CLIENT span as the
  remote parent). The async-event hop (outbox PRODUCER → broker → inbox
  CONSUMER) and the in-leg external supplier/PSP CLIENT hops are already
  span-shaped; folding them onto the same wire trace lands with the broker
  milestone
- ☐ Span links for fan-out (one event, many consumers)
- ◐ Spans align to OTel RPC + messaging semantic conventions — both sides of the
  gRPC hop now carry `rpc.system`/`rpc.service`/`rpc.method` (CLIENT and SERVER);
  the messaging-semconv check lands with the broker

### M4 — Compensations ◐

- ◐ Failure paths unwind in reverse — the coordinator saga runs the completed
  steps' compensations in reverse (`supplier.cancel → payments.void →
  inventory.release`) on any rejection or outage, best-effort over the idempotent
  leg compensations; unit-tested for every failure position and verified end to
  end. The compensation gRPC calls now carry the booking trace too (M3); the
  forced-mid-saga demo across the fully wired stack lands with the broker
- ◐ Compensations visible as spans — each compensation runs in its own
  compensation-flagged span under the `Book` SERVER span, and with M3's gRPC
  propagation the legs' own SERVER spans now fold into the same cross-service
  trace

### M5 — Idempotency ◐

- ◐ Inbox dedup; redelivery-safe consumers — reusable `libs/inbox`
  (`processOnce` dedup contract, in-memory reference store, trace-aware
  `IdempotentConsumer`) is built and unit-tested, and has its first real consumer:
  the `notifier` wires an `IdempotentConsumer` (namespace `notifier`) around its
  `ledger.committed` handler, redelivery-safe and trace-continuing. The
  Postgres-backed `InboxStore` and the remaining consumers land with the services
  and broker

### M6 — Reconciler ◐

- ◐ Periodic comparison of sources of truth (supplier vs ledger vs inventory) —
  the `reconciler` service runs `ReconcilerService.runOnce` on a scheduler, and
  the pure `detectDivergences` engine compares each settled booking's
  inventory/supplier/ledger states against the consistency invariants. The
  comparison, the scheduler, the findings store, and the trace linkage are built
  and unit-tested against the in-memory `SourceOfTruthGateway` reference; the
  broker/Postgres-backed gateway that feeds it real per-service state (subscribing
  to `inventory.*`/`supplier.*`/`ledger.*`) lands with the datastore/broker
  milestones
- ☑ Divergence findings linked to the originating booking trace — each new
  `DivergenceFinding` opens a `reconcile.divergence` span carrying a span link to
  the booking's trace context (lifted from the snapshot) and stamps the finding's
  `traceId`, so a finding is navigable straight back to the trace that explains
  it, even though the reconciler runs out-of-band on its own trace

### M7 — Metrics + logs ◐

- ◐ RED metrics and per-step SLOs in Grafana (RED instrumentation lives in `libs/interceptor`; Grafana dashboards/SLOs still to wire)
- ☑ Trace-correlated structured logging (`trace_id`/`span_id`) — `libs/logging`

### M8 — Harden + ship ☐

- ◐ External-boundary latency/failure injection — the payments `SimulatedPsp`
  injects controllable latency and decline/failure on the PSP hop, and the
  supplier `SimulatedSupplierPartner` applies the same pattern to the partner
  boundary (deliberately slower and flakier defaults), each an errored CLIENT
  span when it fails; the per-step SLOs and chaos wiring land later
- ☐ README trace screenshot including a compensation
- ☐ Release

## Documentation

Reached once the spec is fully implemented and the suite is green. One
deliverable per run.

- ☐ a. Doc comments across the public surface (TSDoc on modules, public functions, types)
- ☐ b. API reference (HTTP/gRPC reference + generated TypeDoc where useful)
- ☐ c. Architecture dossier — `docs/architecture.md`
- ☐ d. Integration guide(s) — `docs/integration.md`
- ☐ e. Usage/how-to guides, `docs/` index, final `README.md` pass
