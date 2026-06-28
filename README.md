# signalman

> Observability and reconciliation for a distributed booking platform. Trace one
> booking end to end across synchronous gRPC and asynchronous events, and surface
> the moment the sources of truth diverge.

A booking coordinates several services that each own part of the truth —
inventory holds, payment authorizations, an external supplier confirmation, and a
financial ledger. The failure mode that matters is not a crash, it is silent
**divergence**: the supplier confirmed but the ledger thinks it failed, or a hold
was never released. `signalman` makes one booking one connected trace across every
hop, and runs a reconciler that compares the sources of truth and links any drift
back to the originating trace.

See [`spec.md`](spec.md) for the full design and [`PROGRESS.md`](PROGRESS.md) for
current status.

## Status

Early scaffold (milestone **M0**). The monorepo, tooling, CI, the trace-context
propagation library, the OpenTelemetry bootstrap library, and a gateway health
endpoint are in place and verified. The remaining services, the
broker/Postgres/observability stack, and the saga itself are upcoming milestones.

## Stack

Node / TypeScript · NestJS (microservices) · gRPC · an event broker (NATS
JetStream or Kafka) · Postgres per service · transactional outbox ·
OpenTelemetry JS exporting OTLP to Tempo + Grafana.

## Layout

```
signalman/
  services/
    gateway/        # HTTP entry point; opens a booking's root span (M0: health probe)
    …               # coordinator, inventory, payments, supplier, ledger, notifier, reconciler (upcoming)
  libs/
    otel/           # OpenTelemetry SDK bootstrap: resource, OTLP exporters, lifecycle
    propagation/    # inject/extract W3C traceparent into broker message headers
    …               # outbox, inbox, interceptor, logging (upcoming)
```

The monorepo uses NestJS monorepo mode. Libraries are imported via path aliases
(e.g. `@signalman/otel`, `@signalman/propagation`).

### `@signalman/otel`

A service boots telemetry once, before any application module loads, so the
registered instrumentations can patch what they hook into:

```ts
import { startTelemetry } from '@signalman/otel';

startTelemetry({ serviceName: 'coordinator', serviceVersion: '0.1.0' });
```

Traces and metrics export over OTLP/HTTP to the Collector, configured through the
standard `OTEL_EXPORTER_OTLP_*` environment variables (defaulting to
`http://localhost:4318`). The returned handle flushes on `SIGTERM`/`SIGINT` so no
spans are lost on shutdown.

## Getting started

Requires Node 20+ (see [`.nvmrc`](.nvmrc)).

```bash
npm install        # install dependencies
npm run build      # compile all projects
npm test           # run the full test suite
npm run lint       # eslint
npm run typecheck  # tsc --noEmit across the workspace
```

### Run the gateway

```bash
npm start                       # boots the gateway on PORT (default 3000)
curl http://localhost:3000/health
# {"status":"ok","service":"gateway"}
```

## Development

- **Tests** live next to the code as `*.spec.ts` and run under Jest + ts-jest.
- **Build** uses `nest build <project>`; output lands in `dist/`.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs install,
  lint, typecheck, build, and test on every push and pull request.
