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
- ◐ Remaining services scaffolded:
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
  - ☐ `coordinator`, `notifier`, `reconciler`
- ☑ `libs/otel` — OpenTelemetry SDK bootstrap: OTLP/HTTP exporters, resource identity, managed start/flush lifecycle
- ☑ `libs/logging` — trace-correlated structured JSON logger (NestJS `LoggerService`, lifts `trace_id`/`span_id`/`trace_flags` from the active span)
- ☑ `libs/interceptor` — NestJS observability interceptor: per-handler SERVER span (active for the call so child spans join the trace) + RED metrics (duration histogram + error counter), HTTP/gRPC mapped to OTel semconv, wired via `ObservabilityModule.forRoot`
- ☑ Remaining libs scaffolded: `outbox` ☑, `inbox` ☑
  - ☑ `libs/outbox` — transactional outbox: durable record + trace capture (`createOutboxRecord`), `OutboxStore` contract, `InMemoryOutboxStore` reference (leasing, back-off, dead-letter), and a `OutboxRelay` that publishes each row under a PRODUCER span parented to the staged trace (at-least-once, capped exponential back-off, dead-lettering)
  - ☑ `libs/inbox` — idempotent consumer: `InboxStore.processOnce` dedup contract (marker committed atomically with the handler's side effects), `InMemoryInboxStore` reference (synchronous claim, rollback-on-failure), and an `IdempotentConsumer` that opens a CONSUMER span continuing the message's trace, skips redeliveries (tagged on the span), and rethrows handler errors for NACK — the dedup core that pairs with the outbox for effectively-once
- ☐ Postgres per service, broker (NATS JetStream/Kafka), OTel Collector
- ☐ One-command `docker-compose` stack (services + broker + collector + Tempo + Grafana)

### M1 — Happy-path saga ◐

- ◐ gRPC contracts for the synchronous commands — `inventory.proto`
  (`Hold`/`Release`), `payments.proto` (`Authorize`/`Capture`/`Void`),
  `supplier.proto` (`Confirm`/`Cancel`), and `ledger.proto` (`Commit`/`Reverse`)
  defined and served; the notifier contract upcoming
- ☐ Coordinator drives `hold → authorize → confirm → capture/commit → notify`
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

### M3 — Trace propagation ☐

- ☐ One booking = one connected trace across gRPC, async events, external hop
- ☐ Span links for fan-out (one event, many consumers)
- ☐ Spans align to OTel RPC + messaging semantic conventions

### M4 — Compensations ☐

- ☐ Failure paths unwind in reverse (release hold, void authorization)
- ☐ Compensations visible as spans

### M5 — Idempotency ◐

- ◐ Inbox dedup; redelivery-safe consumers — reusable `libs/inbox`
  (`processOnce` dedup contract, in-memory reference store, trace-aware
  `IdempotentConsumer`) is built and unit-tested; the Postgres-backed
  `InboxStore` and per-consumer wiring land with the services

### M6 — Reconciler ☐

- ☐ Periodic comparison of sources of truth (supplier vs ledger vs inventory)
- ☐ Divergence findings linked to the originating booking trace

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
