# Progress

A living checklist tracking `signalman` against [`spec.md`](spec.md). Status
legend: ☐ not started, ◐ in progress, ☑ done.

## Implementation

Milestones are derived from the spec's milestone table. Each is broken into the
concrete slices needed to call it done.

### M0 — Scaffold ☑

- ☑ NestJS + TypeScript monorepo tooling (`nest-cli.json`, `tsconfig`, strict mode)
- ☑ Jest test runner wired to the monorepo path aliases
- ☑ ESLint (flat config) + Prettier
- ☑ CI workflow: install → lint → typecheck → build → test
- ☑ `libs/propagation` — W3C trace-context inject/extract for broker headers
- ☑ `services/gateway` — the public **HTTP entry point**, the start of a booking
  and of its trace. Beyond the health probe it now serves the booking surface:
  `POST /bookings` validates the request, mints a booking id when absent, and
  drives the saga by calling `Coordinator.Book` over gRPC, recording the outcome;
  `GET /bookings/:id` is the thin status endpoint that reads the recorded outcome
  back (carrying the booking's `traceId` so an operator can jump to its trace).
  Telemetry starts at boot and `ObservabilityModule` wraps every request, so the
  `POST /bookings` SERVER span is the **root** of the booking trace; the
  coordinator client opens a CLIENT child span and injects the W3C `traceparent`
  into the gRPC metadata, so the coordinator continues from the gateway (the
  gateway → coordinator hop of M3). Hexagonal like the coordinator: the booking
  service depends on a `CoordinatorPort` and a `BookingStore`, unit-tested against
  fakes and an in-memory store (Postgres-backed later behind the same token), with
  the live HTTP surface verified end to end via supertest and a booted process
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
    notification source-of-truth record but stages no outbox event. **Now wired to
    the broker**: the module registers a `BrokerSubscriptionHost`
    (§`@signalman/broker`) that subscribes the consumer to `ledger.committed` off
    the configured broker on application bootstrap, so the terminal event drives the
    notification in a running service. Unit-tested end to end (process-once,
    redelivery, two-layer dedup, trace continuation with the provider hop nested
    under the consume span, NACK-on-outage), plus a module-level wiring test driving
    a real `ledger.committed` event through the registered host onto a shared broker
    (notified once across a redelivery), and verified to boot subscribed
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
- ☑ Remaining libs scaffolded: `outbox` ☑, `inbox` ☑, `broker` ☑
  - ☑ `libs/outbox` — transactional outbox: durable record + trace capture (`createOutboxRecord`), `OutboxStore` contract, `InMemoryOutboxStore` reference (leasing, back-off, dead-letter), and a `OutboxRelay` that publishes each row under a PRODUCER span parented to the staged trace (at-least-once, capped exponential back-off, dead-lettering)
  - ☑ `libs/inbox` — idempotent consumer: `InboxStore.processOnce` dedup contract (marker committed atomically with the handler's side effects), `InMemoryInboxStore` reference (synchronous claim, rollback-on-failure), and an `IdempotentConsumer` that opens a CONSUMER span continuing the message's trace, skips redeliveries (tagged on the span), and rethrows handler errors for NACK — the dedup core that pairs with the outbox for effectively-once
  - ☑ `libs/broker` — the broker boundary that closes the async-event hop: a
    transport-agnostic `MessageBroker` (publish + subject-pattern subscribe, NATS
    wildcards via `subjectMatches`), an `InMemoryBroker` reference (fan-out,
    queue-group load-balancing, at-least-once redelivery on NACK with
    dead-lettering, async delivery awaitable via `drain`), the `BrokerPublisher`
    adapter implementing the outbox relay's `Publisher` over the broker
    (`toBrokerMessage`), and the `toConsumedMessage` bridge onto the inbox
    `IdempotentConsumer`. A cross-library integration test wires
    outbox → relay → broker → inbox and asserts the three hops form one connected
    trace; the NATS-backed adapter swaps in behind the same boundary with the
    docker stack
- ☑ Broker **transport** — the **NATS JetStream adapter** (`NatsBroker`) is built
  behind `libs/broker`'s `MessageBroker` boundary, the production sibling of the
  in-memory reference. It maps the reference semantics onto JetStream: a durable
  stream, native subject-wildcard matching, fan-out via an ephemeral push
  consumer per subscriber, queue-group load-balancing via a shared durable
  consumer, and at-least-once delivery with `nak()` redelivery up to `maxDeliver`
  then `term()` + dead-letter. A header codec round-trips the trace-carrying
  `BrokerHeaders` (and the message id) across the wire. Verified end to end
  against a **live JetStream server** by a gated integration test
  (`nats-broker.integration.spec.ts`, run with `NATS_TEST_URL` set; skipped by
  default so CI stays green) — fan-out, queue groups, redelivery, dead-letter,
  **and the headline async trace continuity** (saga step → JetStream publish →
  consume on one connected trace)
- ☑ Per-service relay/subscription wiring (choosing the broker via env) — **all
  services are now wired end to end**. `@signalman/broker` adds `createBrokerFromEnv`
  (env-driven transport selection: in-memory reference by default, `NatsBroker` when
  `BROKER=nats`, returning the broker, its `kind`, and a `close`) and two
  framework-agnostic lifecycle hosts whose `onApplicationBootstrap`/
  `onApplicationShutdown` match NestJS's hooks structurally: `OutboxRelayHost` on
  the producing side and `BrokerSubscriptionHost` on the consuming side. All four
  producing legs (`inventory`, `payments`, `supplier`, `ledger`) register the relay
  host, the **notifier** registers the subscription host subscribing to
  `ledger.committed`, and the **reconciler** now registers its own subscription host
  subscribing its `BrokerSourceOfTruthGateway` handler to
  `inventory.*`/`supplier.*`/`ledger.*` — so every source-of-truth event from the
  producing services flows into the reconciler's cross-service snapshot in a running
  stack
- ☑ OTel Collector — OTLP/HTTP+gRPC receiver, batch processor, OTLP→Tempo exporter, Prometheus exporter for RED metrics
- ☑ One-command `docker-compose` stack — all eight services + NATS JetStream + **Postgres** + OTel Collector + Grafana Tempo + Grafana; single `Dockerfile` builds every service from the monorepo; `docker-compose up` starts the full demo; gateway exposed at `localhost:3000`, Grafana at `localhost:3001`
- ☑ **Postgres datastore layer** — `libs/outbox` gains `PostgresOutboxStore` (full
  outbox lifecycle against `{schema}.outbox_events` with `SELECT … FOR UPDATE SKIP
  LOCKED` claiming so concurrent relay instances never double-publish) and
  `PgUnitOfWork`/`runInPgTransaction` (a pool client mid-transaction so the
  business-state write and the outbox row share one database transaction — the
  real-database equivalent of the in-memory `UnitOfWork`). `libs/inbox` gains
  `PostgresInboxStore` (`INSERT … ON CONFLICT DO NOTHING` dedup inside the
  handler's own transaction so marker and side effects are atomic). Both are
  gated integration-tested against a live Postgres (`POSTGRES_TEST_URL`,
  skipped by default). `services/inventory` wires `PostgresHoldRepository`
  + `PostgresOutboxStore` behind the existing `HOLD_REPOSITORY`/`OUTBOX_STORE`
  tokens when `POSTGRES_URL` is set, using `runInPgTransaction` as the injected
  `transact` function so hold + outbox row share one real transaction — the
  pattern all other services follow. The docker-compose stack adds a `postgres`
  service (single instance, per-service schemas in `signalman` database) and
  propagates `POSTGRES_URL` to every application container.

### M1 — Happy-path saga ☑

- ☑ gRPC contracts for the synchronous commands — `coordinator.proto` (`Book`),
  `inventory.proto` (`Hold`/`Release`), `payments.proto`
  (`Authorize`/`Capture`/`Void`), `supplier.proto` (`Confirm`/`Cancel`), and
  `ledger.proto` (`Commit`/`Reverse`) defined and served; the notifier is a pure
  event consumer with no gRPC surface
- ☑ `gateway` is the booking's entry point — `POST /bookings` opens the root span
  and calls `Coordinator.Book` over gRPC, returns the recorded outcome, and
  `GET /bookings/:id` reads a booking's fate back; this is how a booking is
  started from outside the system; the gateway now records outcomes through the
  Postgres-backed `PostgresBookingStore` when `POSTGRES_URL` is set
- ☑ Coordinator drives `hold → authorize → confirm → capture → commit` over gRPC
  (verified end to end against the four live leg services); the async `notify`
  step runs in the `notifier` service, which **subscribes to `ledger.committed`
  off the configured broker** (`BrokerSubscriptionHost`) and notifies the customer
  — so the saga's tail is wired end to end over the broker, in-process under the
  in-memory default and cross-service under `BROKER=nats`
- ☑ Per-service state — inventory owns holds and per-SKU availability; payments
  owns authorizations and captures, wrapping a simulated PSP; supplier owns
  partner confirmations, wrapping a simulated external partner; ledger owns the
  financial record (commit/reverse, no external boundary). All five services —
  inventory, payments, supplier, ledger, and gateway — now ship Postgres-backed
  stores that activate when `POSTGRES_URL` is set; the gateway's
  `PostgresBookingStore` (`gateway.bookings`) completes the set, with last-wins
  upsert semantics and the same gated integration test pattern as the saga legs.

### M2 — Outbox ☑

- ☑ Transactional outbox table + relay per service — reusable `libs/outbox`
  (record staging, store contract, trace-aware relay) is built and unit-tested;
  all four producing legs stage their events through an `OutboxStore` alongside
  their state changes. Each leg registers an `OutboxRelayHost` (broker chosen via
  `createBrokerFromEnv`) that drains its outbox onto the broker on application
  bootstrap; the notifier registers a `BrokerSubscriptionHost` consuming
  `ledger.committed`. The Postgres-backed `PostgresOutboxStore` is wired in all
  four producing services when `POSTGRES_URL` is set, completing the
  infrastructure-backed outbox lifecycle end to end
- ☑ Transactional staging (the "transactional" in transactional outbox) —
  `runInTransaction` threads a `UnitOfWork` through a service's business-state
  write and the outbox `add` it accompanies so the two **commit together or not
  at all**, closing the dual-write window in the in-memory reference (not just
  "in Postgres later"). `InMemoryOutboxStore.add(record, tx?)` and every leg
  repository's write now take that unit of work, and **all four legs adopt the
  shape**: ledger (`commit`/`reverse`), inventory (`hold`/`release` — its
  oversell guard stays eager so a would-oversell write rolls the unit of work
  back before anything commits), payments (`authorize`/`capture`/`void`, with the
  PSP call kept outside the transaction as the one side effect that cannot roll
  back), and supplier (`confirm`/`cancel`, with the partner call kept outside
  likewise). Each leg's service test pins the atomicity directly: when the outbox
  `add` throws, the state change rolls back with it — no state without its event.
  The Postgres-backed stores swap in behind the same tokens and get the same
  guarantee from a real database transaction
- ☑ Crash test: no lost and no phantom events — `libs/outbox/durability.spec.ts`
  pins the guarantee against precise crash points: a staging transaction that
  rolls back leaves **no outbox row** (no phantom event ever publishes); a
  committed row is still published when the relay **crashes mid-publish** (its
  lease expires and a restarted relay re-claims it — no lost event); and a crash
  **between the broker accepting the event and the relay recording it**
  re-delivers rather than drops it (at-least-once, the duplicate the idempotent
  inbox absorbs — proven in `@signalman/broker`)

### M3 — Trace propagation ☑

- ☑ One booking = one connected trace across gRPC, async events, external hop —
  **both the synchronous gRPC half and the async-event hop are now wired**. The
  trace now starts at its true origin: the gateway's `POST /bookings` SERVER span
  is the **root**, and the gateway's coordinator client opens a CLIENT span and
  injects the W3C `traceparent` into the gRPC metadata, so the coordinator's
  SERVER span continues from the gateway (the gateway → coordinator hop). From
  there the coordinator's leg clients open a CLIENT span per RPC and inject the
  same `traceparent` (`callWithTrace` / `injectTraceMetadata` in
  `services/coordinator/src/grpc`, mirrored in `services/gateway/src/bookings`),
  and `@signalman/interceptor` extracts that context on the SERVER side
  (`resolveParentContext`) so each leg handler span **continues** the booking
  trace. On the async side, `@signalman/broker` closes the loop: the outbox
  relay publishes each row through `BrokerPublisher` onto the `MessageBroker`
  under a PRODUCER span continuing the staged trace, a subscriber bridges each
  delivery to the inbox `IdempotentConsumer` (`toConsumedMessage`), and its
  CONSUMER span continues that trace. An end-to-end integration test
  (`libs/broker/src/trace-continuity.spec.ts`) asserts the saga step → publish
  (PRODUCER) → consume (CONSUMER) spans share one `traceId` with the right
  lineage (publish parented to the step, consume parented to publish) — the
  async half of the headline. This is now also proven over the **real NATS
  JetStream transport** (`nats-broker.integration.spec.ts`), not just the
  in-memory reference: with `NatsBroker` in the middle the same three spans still
  form one connected trace. The external supplier/PSP CLIENT hops are already
  span-shaped within their legs
- ☑ Span links for fan-out (one event, many consumers) — `IdempotentConsumer`
  gains a `fanOut: boolean` option; when `true` the CONSUMER span opens a new
  root trace and carries a span link back to the PRODUCER span instead of being
  a child of it, so each consumer's trace is independent but navigable to the
  source event. `BookingNotificationConsumer` is now `fanOut: true` (the
  notifier and reconciler both subscribe to `ledger.*`); tested in
  `trace-continuity.spec.ts` (two fans receive the same event, each gets a
  distinct traceId and a link to the producer's spanId)
- ☑ Spans align to OTel RPC + messaging semantic conventions — gRPC hops carry
  `rpc.system`/`rpc.service`/`rpc.method` (CLIENT and SERVER, verified in
  `libs/interceptor/src/operation.spec.ts`); the broker's publish and consume
  spans carry `messaging.operation.name`, `messaging.destination.name`,
  `messaging.message.id`, and `messaging.system` (verified in
  `libs/broker/src/trace-continuity.spec.ts`). This closes the spec's
  quality checklist item: "Spans align to the OTel RPC and messaging semantic
  conventions (verified against current semconv)."

### M4 — Compensations ☑

- ☑ Failure paths unwind in reverse — the coordinator saga runs the completed
  steps' compensations in reverse (`supplier.cancel → payments.void →
  inventory.release`) on any rejection or outage, best-effort over the idempotent
  leg compensations; unit-tested for every failure position (all five injection
  points) and verified end to end against live leg services over gRPC. The
  compensation gRPC calls carry the booking trace (M3). A forced failure is
  demonstrable via the docker-compose stack with the supplier's configurable
  failure rate (`SUPPLIER_FAILURE_RATE`)
- ☑ Compensations visible as spans — each compensation runs in its own
  compensation-flagged span (`signalman.saga.compensation=true`) under the `Book`
  SERVER span, and with M3's gRPC propagation the legs' own SERVER spans fold
  into the same cross-service trace

### M5 — Idempotency ☑

- ☑ Inbox dedup; redelivery-safe consumers — reusable `libs/inbox`
  (`processOnce` dedup contract, in-memory reference store, trace-aware
  `IdempotentConsumer`) is built and unit-tested. The `notifier` wires an
  `IdempotentConsumer` (namespace `notifier`) around its `ledger.committed`
  handler, redelivery-safe and trace-continuing. The dedup is exercised over
  the **actual broker boundary** — the `libs/broker` integration test drives a
  duplicate delivery (→ processed once, second tagged a duplicate) and a NACK
  (handler throws → broker redelivers → reprocessed) through the consumer,
  proving effectively-once over at-least-once delivery. A module-level wiring
  test drives a redelivered event through the registered `BrokerSubscriptionHost`
  and asserts the customer is told exactly once. The Postgres-backed
  `PostgresInboxStore` (`INSERT … ON CONFLICT DO NOTHING` — race-free dedup
  committed in the same transaction as the handler's side effects) is built and
  wired, completing the full Postgres-backed datastore layer for all services

### M6 — Reconciler ☑

- ☑ Periodic comparison of sources of truth (supplier vs ledger vs inventory) —
  the `reconciler` service runs `ReconcilerService.runOnce` on a scheduler, and
  the pure `detectDivergences` engine compares each settled booking's
  inventory/supplier/ledger states against the consistency invariants. The
  comparison, the scheduler, the findings store, and the trace linkage are built
  and unit-tested end to end. The **broker-backed `SourceOfTruthGateway`**
  (`BrokerSourceOfTruthGateway`) is now built and wired: it subscribes to
  `inventory.*`, `supplier.*`, and `ledger.*` via a `BrokerSubscriptionHost`,
  projects each event into a per-booking cross-source snapshot, and applies a
  settle-grace window (`RECONCILER_SETTLE_GRACE_MS`, default 5 s) so in-flight
  bookings are never reconciled before their saga completes. The in-memory
  findings store remains for now; the Postgres-backed store lands with the
  datastore milestone behind the same `FINDING_REPOSITORY` token
- ☑ Divergence findings linked to the originating booking trace — each new
  `DivergenceFinding` opens a `reconcile.divergence` span carrying a span link to
  the booking's trace context (lifted from the snapshot) and stamps the finding's
  `traceId`, so a finding is navigable straight back to the trace that explains
  it, even though the reconciler runs out-of-band on its own trace

### M7 — Metrics + logs ☑

- ☑ RED metrics and per-step SLOs in Grafana — RED instrumentation in `libs/interceptor`
  (rate, error ratio, p50/p99 by operation) and the Grafana dashboard wired end to end: a
  "Booking saga — RED" summary row, a "Per-service RED" row, a "Booking saga — per-step SLOs"
  row with **14 stat panels** (one p99-latency SLO + one error-rate SLO per saga step: gateway,
  coordinator, inventory hold, payments authorize, supplier confirm, payments capture, ledger
  commit; each panel shows green / yellow / red against its step-specific threshold), and a trace
  explorer panel. Prometheus metrics are wired through the OTel Collector's Prometheus exporter;
  Tempo is wired as the trace datasource with exemplar trace-ID linking so a metric point jumps
  straight to the originating trace.
- ☑ Trace-correlated structured logging (`trace_id`/`span_id`) — `libs/logging`

### M8 — Harden + ship ☑

- ☑ External-boundary latency/failure injection — the payments `SimulatedPsp`
  injects controllable latency and decline/failure on the PSP hop
  (`PSP_LATENCY_MS`, `PSP_DECLINE_RATE`, `PSP_FAILURE_RATE`), and the supplier
  `SimulatedSupplierPartner` applies the same pattern to the partner boundary
  (deliberately slower and flakier defaults: `SUPPLIER_LATENCY_MS`,
  `SUPPLIER_REJECT_RATE`, `SUPPLIER_FAILURE_RATE`); each external call is an
  errored CLIENT span when it fails, observable in the trace and surfaced by the
  per-step SLO panels in Grafana; a forced supplier failure exercises the saga's
  compensation path end to end
- ☑ README trace anatomy — `README.md` now contains a "Trace anatomy" section
  with annotated span-tree diagrams for the happy path (gateway root span through
  every leg to the notifier's async fan-out), the compensation path (supplier
  failure → `payments.void → inventory.release` with `signalman.saga.compensation`
  flags), and the reconciler divergence finding (span link back to the originating
  booking trace); each `[S]`/`[C]`/`[P]`/`[CON]` span is labelled with its service
  and attributes so the anatomy is readable without a running Grafana instance
- ☑ Release — v1.0.0: spec fully implemented, all 420+ test assertions green,
  one-command docker-compose stack ships the full demo

## Documentation

Reached once the spec is fully implemented and the suite is green. One
deliverable per run.

- ☑ a. Doc comments across the public surface (TSDoc on modules, public functions, types)
- ☑ b. API reference (HTTP/gRPC reference + generated TypeDoc where useful)
- ☐ c. Architecture dossier — `docs/architecture.md`
- ☐ d. Integration guide(s) — `docs/integration.md`
- ☐ e. Usage/how-to guides, `docs/` index, final `README.md` pass
