# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
