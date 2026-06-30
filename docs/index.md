# Signalman — documentation hub

> Observability and reconciliation for a distributed booking platform.
> Trace one booking end to end across synchronous gRPC and asynchronous events,
> and surface the moment the sources of truth diverge.

---

## Start here

| Where you want to go | Document |
|----------------------|----------|
| Run the demo and trigger a booking | [Integration guide](integration.md) |
| Understand the architecture and how the pieces fit | [Architecture dossier](architecture.md) |
| Look up an endpoint, field, or env var | [API reference](api.md) |
| Common developer tasks and troubleshooting | [How-to guides](how-to.md) |
| Project overview, quick start, library usage | [README](../README.md) |

---

## Document map

### [API reference](api.md)

Complete reference for every integration surface:

- **HTTP API** — `POST /bookings`, `GET /bookings/:id`, `GET /health` (gateway)
- **gRPC services** — `Coordinator.Book`, `Inventory.Hold`/`Release`,
  `Payments.Authorize`/`Capture`/`Void`, `Supplier.Confirm`/`Cancel`,
  `Ledger.Commit`/`Reverse`; every request and reply field annotated
- **Async event catalogue** — nine subjects across four producing services
  (`inventory.*`, `payment.*`, `supplier.*`, `ledger.*`) with payload fields
  and fan-out consumer notes
- **Environment variable reference** — simulation knobs, Postgres, broker, and
  OTel config per service

### [Architecture dossier](architecture.md)

How the pieces fit together and why they were built that way:

- System overview and motivation
- Component map with ASCII diagrams and monorepo layout
- Data and control flow — happy-path saga, compensation unwind, async outbox →
  broker → inbox pipeline, reconciliation pass
- Library layer deep-dives (`@signalman/{otel,propagation,logging,interceptor,outbox,inbox,broker}`)
- Service layer — per-service responsibilities, gRPC surfaces, external
  boundaries, outbox events, and datastore notes
- Observability pipeline — trace propagation across gRPC, broker, and external
  hops; RED metrics and per-step SLO dashboards; trace-correlated logging
- Key design decisions — orchestrated saga, hexagonal ports, transactional outbox,
  idempotency at the legs, fan-out span links, settle-grace window, external
  calls outside the transaction
- Spec-to-code traceability matrix

### [Integration guide](integration.md)

How to stand the system up and integrate against it:

- Prerequisites and one-command `docker-compose up`
- Trigger a booking, read the status, browse the trace in Grafana Tempo
- Force a compensation path via supplier failure injection
- Induce a reconciler divergence and navigate the span link to its root cause
- Call the gateway HTTP API from external code (with W3C trace-context)
- Call every gRPC surface directly with `grpcurl` examples
- Run all eight services locally without Docker
- Library reuse recipes for all seven `@signalman/*` libs
- Per-service environment variable reference

### [How-to guides](how-to.md)

Task-oriented guides for common developer workflows and scenarios:

- **Developer workflows** — run tests (full suite, single project, integration
  tests against live NATS/Postgres), typecheck, lint, build
- **Running services locally** — all eight services without Docker, disable
  failure injection for a deterministic demo, use NATS JetStream locally
- **Observing a booking in Grafana** — find a trace by ID, read the span tree,
  jump from a metric to its trace via exemplars
- **Diagnosing a failed booking** — identify the failed step, check compensation
  spans, read error attributes
- **Understanding a reconciler divergence** — find findings in Tempo, navigate
  from a finding to its booking trace, induce a divergence deliberately
- **Tuning failure injection** — PSP/supplier/notifier rates and latency knobs
- **Common issues** — quick fixes for the most frequent setup problems

---

## Key concepts

**One booking, one trace.** Every step of a booking — synchronous gRPC calls,
asynchronous events through the broker, calls to the simulated external PSP and
partner — hangs off a single W3C trace context. The `traceId` in the booking
response is your handle to the full story.

**Transactional outbox.** Each producing service writes its business state and its
outbox event in one local transaction, so events publish if and only if the state
committed. There is no window where a crash loses an event or produces a phantom.

**Saga with compensations.** The coordinator drives `hold → authorize → confirm →
capture → commit` over gRPC. On any failure the completed steps unwind in reverse
(`cancel → void → release`). Each step and compensation is its own span.

**Idempotent consumers.** The broker delivers at-least-once. Every consumer uses
the inbox dedup (`IdempotentConsumer` + `InboxStore`) to process each message
exactly once — the dedup marker commits in the same transaction as the handler's
side effects.

**Reconciliation.** The reconciler compares the sources of truth periodically. A
divergence finding carries a span link back to the originating booking trace so
you can navigate straight from "these two services disagree" to "here is the
booking event that caused it."
