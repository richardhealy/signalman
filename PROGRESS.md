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
- ☐ Remaining services scaffolded: `coordinator`, `inventory`, `payments`, `supplier`, `ledger`, `notifier`, `reconciler`
- ☑ `libs/otel` — OpenTelemetry SDK bootstrap: OTLP/HTTP exporters, resource identity, managed start/flush lifecycle
- ☑ `libs/logging` — trace-correlated structured JSON logger (NestJS `LoggerService`, lifts `trace_id`/`span_id`/`trace_flags` from the active span)
- ☐ Remaining libs scaffolded: `outbox`, `inbox`, `interceptor`
- ☐ Postgres per service, broker (NATS JetStream/Kafka), OTel Collector
- ☐ One-command `docker-compose` stack (services + broker + collector + Tempo + Grafana)

### M1 — Happy-path saga ☐

- ☐ gRPC contracts for the synchronous commands
- ☐ Coordinator drives `hold → authorize → confirm → capture/commit → notify`
- ☐ Per-service state in Postgres

### M2 — Outbox ☐

- ☐ Transactional outbox table + relay per service
- ☐ Crash test: no lost and no phantom events

### M3 — Trace propagation ☐

- ☐ One booking = one connected trace across gRPC, async events, external hop
- ☐ Span links for fan-out (one event, many consumers)
- ☐ Spans align to OTel RPC + messaging semantic conventions

### M4 — Compensations ☐

- ☐ Failure paths unwind in reverse (release hold, void authorization)
- ☐ Compensations visible as spans

### M5 — Idempotency ☐

- ☐ Inbox dedup; redelivery-safe consumers

### M6 — Reconciler ☐

- ☐ Periodic comparison of sources of truth (supplier vs ledger vs inventory)
- ☐ Divergence findings linked to the originating booking trace

### M7 — Metrics + logs ☐

- ☐ RED metrics and per-step SLOs in Grafana
- ☐ Trace-correlated structured logging (`trace_id`/`span_id`)

### M8 — Harden + ship ☐

- ☐ Supplier latency/failure injection
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
