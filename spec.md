# signalman — Implementation & Status Plan

**Stack:** Node / TypeScript. NestJS (microservices), gRPC transport, an event broker (NATS JetStream or Kafka), Postgres per service, transactional outbox, OpenTelemetry JS, OTLP export to Tempo + Grafana (or Jaeger).
**One-liner:** Observability and reconciliation for a distributed booking platform where several systems each own part of the truth: trace one booking end to end across synchronous gRPC and asynchronous events, and surface the moment the sources of truth diverge.
**The single concern it isolates:** Observability and reconciliation across distributed sources of truth in an event-driven system. Tracing is the mechanism; catching and explaining divergence is the payoff.

---

## Why this (the showcase)

A booking that spans inventory, payment, an external supplier, and a ledger is the textbook case where distributed tracing stops being a nice-to-have. Each system owns its own truth, the steps are part synchronous and part asynchronous, and the failure mode that matters is not a crash, it is silent divergence: the supplier confirmed but the ledger thinks it failed, or a hold was never released. The architectural decisions on show:

- **Saga across services** with explicit compensations, so a partial failure unwinds cleanly rather than leaving orphaned state.
- **Transactional outbox**, so events publish reliably without the dual-write problem (no lost or phantom events when a service crashes between writing its DB and publishing).
- **Idempotent consumers**, so broker redelivery is safe.
- **Reconciliation**, a process that compares the sources of truth and flags drift, with every finding linkable back to the originating trace.
- And the observability that ties it together: one booking is one connected trace across every hop, including the external boundary, so you can answer "how did this booking end up inconsistent?" in seconds.

The domain is swappable without changing the architecture: the same shape (distributed sources of truth, a coordinating saga, reconciliation, end-to-end tracing) covers **cost aggregation across multiple billing systems** just as well as bookings. Pick whichever reads better to your audience; the engineering is identical.

---

## The domain

A booking coordinates several services, each its own source of truth:

- **Inventory** owns availability and holds (its own Postgres).
- **Payments** owns authorizations and captures, wrapping an external PSP (a source of truth outside our boundary).
- **Supplier** confirms with an external partner (another external source of truth, deliberately slow and flaky in the simulator).
- **Ledger** owns the financial record of what actually happened.
- **Notifier** tells the customer.

The saga: `hold inventory -> authorize payment -> confirm with supplier -> capture + commit to ledger -> notify`. On any failure, compensations fire in reverse (release hold, void authorization). The external supplier and PSP are simulated, including induced latency and failures, because that is where divergence is born.

---

## Scope

**In:**
- 4 to 5 NestJS services, each with its own datastore, gRPC for synchronous commands, broker events for async coordination.
- A saga coordinator (orchestration, for trace clarity) driving the booking with explicit compensations.
- Transactional outbox in each service for reliable event publishing.
- OpenTelemetry: one booking is one trace across gRPC, broker events, and the external supplier hop; saga steps and compensations appear as spans.
- A reconciler that periodically compares the sources of truth (supplier-confirmed vs ledger-committed vs inventory-held) and emits divergence findings linked to the booking trace.
- RED metrics and per-step SLOs; trace-correlated structured logging; idempotent consumers.
- A one-command `docker-compose` stack: services, broker, OTel Collector, Tempo + Grafana.

**Explicitly out (for v1):**
- A real PSP or supplier (simulated, with controllable latency and failure injection).
- A customer-facing UI beyond Grafana and a thin booking-status endpoint.
- Multi-region or true exactly-once delivery; aim for effectively-once via idempotency + an inbox.

---

## Architecture

```
signalman/
  services/
    gateway/        # NestJS entry point: starts the trace, gRPC client
    coordinator/    # saga orchestrator: drives steps + compensations
    inventory/      # owns holds (Postgres + outbox)
    payments/       # owns auths/captures, wraps simulated PSP (+ outbox)
    supplier/       # confirms with simulated external partner (+ outbox)
    ledger/         # owns the financial record (+ outbox)
    notifier/       # async consumer
    reconciler/     # compares sources of truth, emits divergence findings
  libs/
    otel/           # tracer/meter setup, exporters
    propagation/    # inject/extract traceparent into broker headers
    outbox/         # transactional outbox + relay
    inbox/          # idempotent consume (dedup)
    interceptor/    # NestJS interceptor: business spans + RED metrics
    logging/        # logger with trace_id/span_id injection
  docker/           # collector, broker, Tempo+Grafana, one-command up
```

The propagation path is the point: `gateway` opens a root span and calls `coordinator` over gRPC; the coordinator drives each service (sync gRPC where it waits, async events where it does not), and the `traceparent` is injected into every outbound message header and extracted on consume, so a consumer span joins the same trace instead of orphaning. Fan-out (one event, many consumers) uses span links. Each service writes its state and its outbox row in one local transaction, and a relay publishes the outbox, so the trace and the data never disagree about what happened.

---

## Best-in-class quality checklist

- [ ] **Headline test:** one booking produces a single connected trace across gRPC, async events, and the external supplier hop, with correct lineage and no orphan spans.
- [ ] Saga compensations fire on a forced mid-saga failure and are visible as spans in the trace.
- [ ] Transactional outbox proven under crash: no lost and no phantom events.
- [ ] Consumers are idempotent: a redelivered message does not double-book or corrupt lineage.
- [ ] The reconciler detects a deliberately induced divergence (supplier confirmed, ledger failed) and links the finding to the booking trace.
- [ ] External supplier timeout/failure is handled and observable, with the compensation traced.
- [ ] RED metrics and per-step SLOs render in Grafana; logs carry `trace_id`/`span_id` and link to spans.
- [ ] Spans align to the OTel RPC and messaging semantic conventions (verified against current semconv).
- [ ] `docker-compose up` brings the whole demo online; README opens with a booking trace that includes a compensation.

---

## Milestones & status

| # | Milestone | Outcome | Status |
|---|-----------|---------|--------|
| M0 | Scaffold | services + Postgres + broker + collector + docker-compose, CI green | ◐ In progress |
| M1 | Happy-path saga | hold/auth/confirm/commit/notify over gRPC + events | ◐ In progress |
| M2 | Outbox | transactional outbox + relay, crash test (no lost/phantom) | ◐ In progress |
| M3 | Trace propagation | one booking = one trace across sync + async + external hop | ☐ Not started |
| M4 | Compensations | failure paths unwind, compensations traced | ◐ In progress |
| M5 | Idempotency | inbox dedup, redelivery-safe consumers | ◐ In progress |
| M6 | Reconciler | compares sources of truth, divergence findings linked to traces | ☐ Not started |
| M7 | Metrics + logs | RED + per-step SLOs in Grafana, trace-correlated logs | ◐ In progress |
| M8 | Harden + ship | supplier failure injection, README trace screenshot, release | ◐ In progress |

Status legend: ☐ Not started, ◐ In progress, ☑ Done, ⊘ Blocked.

---

## Definition of done

1. A booking produces one connected trace across a gRPC call, an async event hop, and the external supplier boundary.
2. A forced mid-saga failure unwinds via compensations, all visible in the trace.
3. The outbox survives a crash with no lost or phantom events, and consumers are redelivery-safe.
4. The reconciler catches an induced divergence between sources of truth and links it to the originating booking.
5. RED metrics and SLOs render in Grafana, logs carry trace IDs, and `docker-compose up` stands up the whole demo.

## Stretch goals

- A choreography variant of the saga alongside the orchestrated one, with a written comparison of the trade-offs and how each looks in a trace.
- Chaos mode: kill a service mid-saga and show the reconciler heal the divergence.
- Tail-based sampling in the Collector (keep error and slow traces, sample the rest) and metric exemplars that jump from an SLO breach to the exact trace.
- Drop an LLM step into the flow (for example an agent that triages a failed booking) and instrument it with `watchtower`, so one trace carries both the event-driven backbone and `gen_ai.*` spans. This is the clean tie-in between the two observability projects: `signalman` traces the distributed system, `watchtower` adds the AI layer on the same OTel foundation.
