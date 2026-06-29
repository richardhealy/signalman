# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — 2026-06-29
- `services/reconciler`: **broker-backed `SourceOfTruthGateway`** (M6) — the
  reconciler now reads real domain events from the broker rather than an empty
  in-memory store. `BrokerSourceOfTruthGateway` subscribes to `inventory.*`,
  `supplier.*`, and `ledger.*` on the configured broker (`BROKER=nats` for the
  docker-compose stack, the in-memory reference otherwise) and projects each
  event into the per-booking cross-source snapshot the reconciler compares:
  `inventory.held/released` sets the inventory state, `supplier.confirmed/cancelled`
  sets the supplier state, and `ledger.committed/reversed` sets the ledger state.
  A **settle-grace window** (`RECONCILER_SETTLE_GRACE_MS`, default 30 s) withholds
  bookings whose last observed event arrived within the window, so partial saga
  state is never mistaken for a divergence — the timer resets on every new event
  for a booking, so a booking is only eligible once it has been quiet for the full
  grace period. The gateway's subscriptions (`inventory.*`, `supplier.*`,
  `ledger.*`) are managed by a `BrokerSubscriptionHost` registered in
  `ReconcilerModule` — established on `onApplicationBootstrap`, torn down and the
  transport closed on `onApplicationShutdown`. The trace headers carried by each
  broker message are passed through as the booking's trace context, so a finding
  the reconciler raises can be linked to the original booking trace. Covered by
  15 unit tests: all six event types, grace-window filter (withheld, settled,
  timer-reset), multi-booking isolation, and trace-header pass-through.

### Added — 2026-06-29
- **One-command docker-compose stack** (M0) — `docker-compose up` brings the full
  demo online: NATS JetStream (broker), OTel Collector (OTLP/HTTP + gRPC receiver,
  Prometheus exporter for RED metrics, OTLP→Tempo export for traces), Grafana Tempo
  (trace backend), Grafana (pre-provisioned Tempo + Prometheus datasources and a
  Signalman booking dashboard at `localhost:3001`), and all eight application services
  wired together. A single `Dockerfile` builds any service from the monorepo via a
  `SERVICE_NAME` env var; docker-compose uses the same image for every service,
  setting the variable per container. Services receive `BROKER=nats`/`NATS_URL` so
  all outbox relays and broker consumers use the shared JetStream broker, and
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` so every span and metric
  flows through the collector to Tempo and Prometheus. The gateway HTTP surface is
  exposed at `localhost:3000`; `curl -X POST http://localhost:3000/bookings` triggers
  a full saga and produces a connected trace visible in the Grafana Explore view.

### Added — 2026-06-29
- **Notifier broker subscription** — the consuming side of the broker is now wired
  in a service, the mirror of the producing legs' outbox relay. `@signalman/broker`
  adds `BrokerSubscriptionHost`, the consume-side sibling of `OutboxRelayHost`: it
  owns a set of subscriptions over a `MessageBroker`, **establishing them on
  `onApplicationBootstrap`** and on `onApplicationShutdown` **dropping them and
  closing the transport**. Those method names match NestJS's lifecycle interfaces
  structurally, so the library stays framework-agnostic while a service registers
  the host as a provider and Nest drives it; the host owns subscription *lifecycle*,
  not consume *semantics*, so each handler is an ordinary broker handler (a throw
  NACKs the message). The **notifier registers it**, behind a `MESSAGE_BROKER` token
  (broker chosen via `createBrokerFromEnv`) and with shutdown hooks enabled,
  subscribing its `BookingNotificationConsumer` to `ledger.committed`; a small
  `subscription.ts` seam bridges a delivered `BrokerMessage` to the consumer's
  `DeliveredEvent` and lets a provider outage propagate so the broker redelivers. So
  a booking's terminal `ledger.committed` event now actually drives the customer
  notification in a running service — closing the saga's `… -> notify` tail end to
  end over the broker (in-process under the in-memory default, cross-service under
  `BROKER=nats`) rather than only in unit tests. Covered by `BrokerSubscriptionHost`
  lifecycle tests (subscribe/unsubscribe/close, idempotent start, NACK redelivery),
  the bridge/handler unit tests (mapping + NACK propagation), and a module-level
  wiring test that drives a real `ledger.committed` event — and a redelivery of it —
  through the registered host onto a shared broker, asserting the customer is told
  exactly once; the notifier is verified to boot subscribed. The reconciler's
  consuming side (a broker-backed `SourceOfTruthGateway`) is the remaining
  subscription, landing with the reconciler's source gateway.
- **Per-service outbox relay wiring** — the producing services now actually drain
  their outbox onto a broker, closing the gap where every leg *staged* events but
  nothing published them. Two new pieces in `@signalman/broker` make it uniform:
  `createBrokerFromEnv` selects the transport from the environment — the in-memory
  reference by default (so the unit suite and a single-process demo need no
  infrastructure), the NATS JetStream adapter when `BROKER=nats` (servers from
  `NATS_URL`/`NATS_SERVERS`) — returning the broker, its `kind` (also the
  `messaging.system` span attribute), and a `close` for teardown; an unrecognised
  value fails fast. `OutboxRelayHost` owns the relay lifecycle: it composes an
  `OutboxRelay` over the service's `OutboxStore` and a `BrokerPublisher` on that
  broker, starts polling on application bootstrap, and on shutdown stops, flushes
  once, and closes the transport. Its `onApplicationBootstrap`/
  `onApplicationShutdown` methods match NestJS's lifecycle interfaces structurally,
  so the library stays framework-agnostic while a service registers the host as a
  provider and Nest drives it. All four producing legs — `inventory`, `payments`,
  `supplier`, `ledger` — register the host behind a `MESSAGE_BROKER` token and
  enable shutdown hooks, so their staged `inventory.*`/`payment.*`/`supplier.*`/
  `ledger.*` events now flow to the broker on the trace they were born under. The
  relay mechanics (and trace continuity through the publish) carry their own
  coverage in `@signalman/broker`; this increment adds unit tests for the env
  selection and the host lifecycle, plus a module-level test that drives a real
  `inventory.held` event from the wired `InventoryService` through the registered
  host onto a shared broker. The consuming-side subscriptions (notifier,
  reconciler) and the Postgres-backed outbox store land next, behind the same
  tokens.

### Changed — 2026-06-29
- **Transactional staging across every producing leg** — the dual-write window is
  now closed in all four event-producing services, not just the ledger. The
  inventory (`hold`/`release`), payments (`authorize`/`capture`/`void`), and
  supplier (`confirm`/`cancel`) legs each wrap their business-state write and the
  outbox `add` it accompanies in `runInTransaction`, threading one `UnitOfWork`
  through both so they **commit together or not at all** — closing M2's
  "transactional staging" item, which the ledger leg opened. Each leg repository's
  write method (`HoldRepository.commitHold`/`commitRelease`,
  `PaymentRepository.commit`, `ConfirmationRepository.commit`) now takes the
  optional unit of work and defers its in-memory mutation into it, so the state
  change lands atomically with the event in the reference rather than "in Postgres
  later." Two subtleties are preserved: inventory's oversell guard stays **eager**
  (a would-oversell write throws before anything is enlisted, rolling the whole
  unit of work back), and the external calls that **cannot** roll back — the
  payments PSP and the supplier partner — run **before** the transaction, so a
  rollback never strands a charged PSP or a confirmed partner without its recorded
  state (a retry replays them idempotently). Each leg's service test pins the
  guarantee directly: when the outbox `add` throws, the state change rolls back
  with it — no state without its event, no event without its state.

### Added — 2026-06-29
- `@signalman/outbox`: **transactional staging** — the "transactional" in
  transactional outbox. `runInTransaction` threads a `UnitOfWork` through a
  service's business-state write and the outbox `add` it accompanies so the two
  **commit together or not at all**, closing the dual-write window in the
  in-memory reference rather than deferring it to "Postgres later":
  `InMemoryOutboxStore.add(record, tx?)` and the `OutboxStore` contract now take
  the unit of work, and the **ledger** leg is the first adopter (its
  `commit`/`reverse` paths wrap the entry write and its event in one
  transaction). Proven under crash (`durability.spec.ts`, M2 / definition-of-done
  #3): a staging transaction that rolls back leaves **no outbox row** so no
  phantom event publishes; a committed row is still published when the relay
  **crashes mid-publish** (the lease expires and a restarted relay re-claims it)
  so **no event is lost**; and a crash **between the broker accepting an event
  and the relay recording it** re-delivers rather than drops — the at-least-once
  duplicate the idempotent inbox absorbs.
- `services/gateway`: the public **HTTP entry point** — where a booking, and its
  trace, begins. The gateway was a bare health probe; it now serves the booking
  surface the spec calls for. `POST /bookings` validates the request, mints a
  booking id when the caller omits one, and drives the saga by calling
  `Coordinator.Book` over gRPC, then records and returns the outcome; a business
  failure is a `201` with `status: "failed"` (the attempt is a real, recorded
  thing), a malformed body a `400`, and a coordinator outage a `502` (the gateway
  is up, its downstream is not). `GET /bookings/:id` is the thin **status
  endpoint** that reads the recorded outcome back, carrying the booking's
  `traceId` so an operator can jump straight to its trace. Telemetry now starts at
  boot and `ObservabilityModule` wraps every request, so the `POST /bookings`
  SERVER span is the **root** of the booking trace — its true origin. The
  coordinator client opens a CLIENT child span and injects the W3C `traceparent`
  into the gRPC metadata (the same `callWithTrace`/`injectTraceMetadata` seam the
  coordinator uses for its legs), so the coordinator's SERVER span **continues**
  from the gateway: the gateway → coordinator hop of "one booking is one connected
  trace" (M3), the hop above the coordinator → leg hops already wired. Hexagonal
  like the coordinator — the booking service depends on a `CoordinatorPort` and a
  `BookingStore`, so it is unit-tested against fakes and an in-memory store
  (Postgres-backed later behind the same token). Verified end to end: unit tests
  for the validation, the request→command→record mapping, and the CLIENT-span
  trace continuity (parent lineage + injected `traceparent` asserted against an
  in-memory exporter); a supertest pass over the live HTTP routes (`201`/`400`/
  `404`/`502`); and a booted process answering `GET /health`, `POST /bookings`,
  and `GET /bookings/:id`. The Postgres-backed booking store lands with the
  datastore milestone.
- `libs/broker`: the **NATS JetStream adapter** (`NatsBroker`) — the first *real*
  transport behind the `MessageBroker` boundary, the production sibling of the
  in-memory reference, and the start of M0's "broker transport" work. It maps the
  reference semantics onto JetStream primitives so a service swaps it in behind
  the same DI token: a publish lands in a durable **stream** (the event survives a
  broker restart, the durability the outbox assumes on the other side); subject
  matching is JetStream's own NATS wildcards; **fan-out** is an *ephemeral* push
  consumer per subscriber (each gets its own copy) while a **queue group** is a
  shared *durable* consumer its members load-balance; and delivery is
  **at-least-once** — the handler resolving `ack()`s, throwing `nak()`s for
  redelivery up to `maxDeliver`, after which the message is `term()`-inated and
  surfaced to `onDeadLetter`, the same attempt budget and dead-letter seam the
  reference models. A pure header codec (`encodeNatsHeaders`/`decodeNatsHeaders`)
  round-trips the trace-carrying `BrokerHeaders` and the message id across the
  wire (stripping NATS- and adapter-internal headers from the consumer's view),
  so the booking trace continues through the broker. `NatsBroker.create` adapts an
  existing connection; `NatsBroker.connect` owns one and provisions the stream
  idempotently; `whenReady()` closes the subscribe start-up race; `close()` drains
  and tears down. Verified **end to end against a live JetStream server** by a
  gated integration test (`nats-broker.integration.spec.ts` — runs only with
  `NATS_TEST_URL` set, skipped by the default `npm test` and in CI so the suite
  stays green without a broker): fan-out, queue-group load-balancing, NACK
  redelivery, dead-letter after `maxDeliver`, and **the spec's headline async
  half** — a staged outbox event drained by the relay through JetStream and
  consumed by the idempotent inbox keeps the saga step → PRODUCER publish →
  CONSUMER consume spans on **one connected trace**, now with NATS in the middle
  rather than the in-memory broker. The pure header codec and durable-name
  derivation carry unit coverage in the default suite.
- `libs/broker`: the broker boundary that **closes the async-event hop** — the
  transport between the transactional outbox and the idempotent inbox, and the
  async half of the headline "one booking = one trace" (M3). `MessageBroker` is
  the transport-agnostic surface (`publish` a message on its subject, `subscribe`
  a handler to subject patterns), so the rest of the system depends on "a broker"
  rather than on NATS or Kafka. `InMemoryBroker` is the reference implementation,
  modelling the semantics a real broker gives the system: **subject matching**
  with NATS wildcards (`subjectMatches` — `*` for one token, `>` for the tail),
  **fan-out** so every matching subscription gets its own copy (with **queue
  groups** to load-balance a subject across members instead), and
  **at-least-once delivery** — a handler that throws (NACK) is redelivered up to
  `maxDeliver` attempts, then dead-lettered. Delivery is async and decoupled from
  publish; `drain()` awaits quiescence for deterministic tests and graceful
  shutdown. Two thin adapters wire it to the libraries either side:
  `BrokerPublisher` implements the outbox relay's `Publisher` over a broker
  (`toBrokerMessage` maps a record's `eventType` to the subject and preserves the
  trace-carrying headers), and `toConsumedMessage` turns a delivered
  `BrokerMessage` into the inbox's `ConsumedMessage` — so a service composes
  outbox → relay → broker → inbox in one subscription, turning at-least-once
  delivery plus inbox dedup into effectively-once processing. A cross-library
  integration test (`trace-continuity.spec.ts`) wires the whole hop end to end
  and asserts the saga-step span, the relay's **PRODUCER** publish span, and the
  inbox's **CONSUMER** consume span share **one connected trace** with correct
  lineage (publish parented to the step, consume parented to publish), and that
  the hop is redelivery-safe (a duplicate is processed once; a NACK is
  redelivered and reprocessed). The NATS-backed transport swaps in behind the
  same `MessageBroker` boundary with the docker stack.
- Trace propagation across the synchronous gRPC hops (M3, the headline's
  synchronous half): a booking now stays **one connected trace** as the
  coordinator drives the legs over gRPC. The coordinator's leg clients open a
  **CLIENT span** per RPC and inject the W3C `traceparent` into the request
  metadata (`callWithTrace` / `injectTraceMetadata` in
  `services/coordinator/src/grpc/leg-clients.ts`, following the OTel RPC
  semantic conventions), and `@signalman/interceptor` lifts that context on the
  SERVER side (`resolveParentContext`) so each leg's handler span **continues**
  the caller's trace instead of starting an orphan. HTTP at the gateway and any
  non-RPC handler carry no upstream parent, so their spans remain trace roots.
  Verified round-trip end to end in unit tests — client inject → server extract
  → same `traceId` with the CLIENT span as the remote parent — plus CLIENT-span
  shape, error marking, and the SERVER-side continuation. The async-event hop
  (outbox PRODUCER → broker → inbox CONSUMER) folds onto the same trace with the
  broker milestone.

### Added — 2026-06-29
- `services/reconciler`: the periodic comparison of the sources of truth (M6) —
  the spec's payoff, catching silent **divergence** between the systems that each
  own part of a booking's truth. Like the notifier it has no synchronous surface;
  a `ReconciliationScheduler` runs `ReconcilerService.runOnce` on an interval
  (`RECONCILER_INTERVAL_MS`, default 30s) and survives a failed pass so the
  backstop keeps running when something else is going wrong. Each pass pulls every
  *settled* booking from a `SourceOfTruthGateway` as a cross-source snapshot and
  runs the pure `detectDivergences` engine over it — three invariants:
  `supplier_confirmed_ledger_missing` (the partner confirmed a booking with no
  committed financial record — the headline case), `ledger_committed_supplier_unconfirmed`
  (money posted for a booking the partner is not holding), and `orphaned_hold`
  (inventory still held for a booking that did not complete). Each new
  disagreement becomes a `DivergenceFinding`, **idempotent per `(bookingId, kind)`**
  so a recurring drift is recorded once, not once per pass. Every finding is
  **linked back to the booking trace**: the pass runs under a `reconcile.pass`
  span, and each new finding opens a `reconcile.divergence` span carrying a **span
  link** to the originating booking's trace context (and stamps the finding's
  `traceId`), so a divergence is navigable straight to the trace that explains it
  even though the reconciler runs out-of-band on its own trace. Keeping liveness
  in the gateway lets the comparison stay a pure function of the snapshot. It boots
  as a standalone Nest application context and is unit-tested end to end —
  detection across all invariants, cross-pass idempotency, trace-linked finding
  spans, and pass-error handling. The broker/Postgres-backed gateway (subscribing
  to `inventory.*`/`supplier.*`/`ledger.*`) and findings store land with later
  milestones, behind the same DI tokens.
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
