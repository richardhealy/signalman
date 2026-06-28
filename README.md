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
propagation library, the OpenTelemetry bootstrap library, the trace-correlated
logging library, the observability interceptor (business spans + RED metrics),
and a gateway health endpoint are in place and verified. The remaining services,
the broker/Postgres/observability stack, and the saga itself are upcoming
milestones.

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
    logging/        # trace-correlated structured JSON logger (NestJS LoggerService)
    interceptor/    # NestJS interceptor: per-handler business spans + RED metrics
    …               # outbox, inbox (upcoming)
```

The monorepo uses NestJS monorepo mode. Libraries are imported via path aliases
(e.g. `@signalman/otel`, `@signalman/propagation`, `@signalman/logging`,
`@signalman/interceptor`).

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

### `@signalman/logging`

Every service logs structured JSON lines that carry the active span's
`trace_id`/`span_id`/`trace_flags`, so a log in Grafana/Loki links straight back
to the span — and therefore the booking — it was written under:

```ts
import { createLogger } from '@signalman/logging';

const logger = createLogger({ service: 'coordinator', context: 'BookingSaga' });
logger.info('hold placed', { booking_id: 'bk_1', qty: 2 });
// {"timestamp":"…","level":"info","service":"coordinator","context":"BookingSaga",
//  "message":"hold placed","trace_id":"…","span_id":"…","trace_flags":"01",
//  "booking_id":"bk_1","qty":2}
```

It implements the NestJS `LoggerService` interface, so `app.useLogger(logger)`
routes framework logs through the same correlated pipeline, and `logger.child({…})`
binds a context and fields for a unit of work.

### `@signalman/interceptor`

Each service imports the observability module once. Every inbound handler — HTTP
on the gateway, gRPC on the downstream services — is then wrapped in a SERVER
span (kept active for the call, so any child span the handler opens joins the
same trace) and metered with the RED method:

```ts
import { ObservabilityModule } from '@signalman/interceptor';

@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'inventory' })],
})
export class AppModule {}
```

It records a `signalman.operation.duration` histogram (rate via count, latency
via distribution) and a `signalman.operation.errors` counter, tagged with a
low-cardinality `operation`/transport/`outcome` dimension set, and maps HTTP and
gRPC contexts onto the OpenTelemetry RPC/HTTP semantic conventions. Errored spans
carry `error.type` and a recorded exception. Pass `global: false` to bind it
selectively with `@UseInterceptors` instead of registering it globally.

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
