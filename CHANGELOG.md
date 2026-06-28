# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
