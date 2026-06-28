/**
 * The telemetry bootstrap: wires a service's resource and OTLP exporters into a
 * single Node SDK with a managed lifecycle.
 *
 * A service calls {@link startTelemetry} once, as early as possible in its
 * entry point (before other modules load, so instrumentations can patch them),
 * and the returned handle owns starting and flushing the SDK. Traces export to
 * the Collector's `/v1/traces` and metrics to `/v1/metrics`; see
 * {@link resolveOtlpConfig} for how those URLs are resolved.
 */
import { diag } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { resolveOtlpConfig } from './config';
import { buildResource, type ResourceOptions } from './resource';

/** How often metrics are pushed to the Collector when not overridden. */
export const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 15_000;

/** Configuration for a service's telemetry, extending its resource identity. */
export interface TelemetryOptions extends ResourceOptions {
  /**
   * Instrumentations to register (e.g. HTTP, gRPC, pg). Passed straight to the
   * Node SDK; defaults to none so a service opts in to what it needs.
   */
  instrumentations?: NodeSDKConfiguration['instrumentations'];
  /** Metric push interval in milliseconds; defaults to {@link DEFAULT_METRIC_EXPORT_INTERVAL_MS}. */
  metricExportIntervalMillis?: number;
}

/** A started (or startable) telemetry pipeline with a flush-on-shutdown hook. */
export interface Telemetry {
  /** The underlying Node SDK, exposed for advanced wiring. */
  readonly sdk: NodeSDK;
  /** Start the SDK. Idempotent — a second call is a no-op. */
  start(): void;
  /**
   * Flush and shut the SDK down, so buffered spans and metrics are exported
   * before the process exits. Idempotent, and a no-op if never started.
   */
  shutdown(): Promise<void>;
}

/**
 * Build a telemetry pipeline for a service without starting it. Useful in tests
 * and when the caller wants to control start timing; most services should reach
 * for {@link startTelemetry} instead.
 *
 * @param options - the service's resource identity and exporter tuning.
 */
export function createTelemetry(options: TelemetryOptions): Telemetry {
  const otlp = resolveOtlpConfig();

  const sdk = new NodeSDK({
    resource: buildResource(options),
    traceExporter: new OTLPTraceExporter({ url: otlp.tracesUrl, headers: otlp.headers }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlp.metricsUrl, headers: otlp.headers }),
        exportIntervalMillis:
          options.metricExportIntervalMillis ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS,
      }),
    ],
    instrumentations: options.instrumentations ?? [],
  });

  let started = false;
  let stopped = false;

  return {
    sdk,
    start(): void {
      if (started) {
        return;
      }
      sdk.start();
      started = true;
    },
    async shutdown(): Promise<void> {
      if (!started || stopped) {
        return;
      }
      stopped = true;
      await sdk.shutdown();
    },
  };
}

/**
 * Register handlers that flush telemetry when the process is asked to stop, so
 * the last spans and metrics are not lost on `SIGTERM`/`SIGINT`. Errors are
 * reported through the OTel diagnostic channel rather than thrown.
 */
function registerGracefulShutdown(telemetry: Telemetry): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void telemetry.shutdown().catch((error) => {
        diag.error('failed to shut telemetry down cleanly', error);
      });
    });
  }
}

/**
 * Create, start, and register graceful shutdown for a service's telemetry in
 * one call. This is the entry point a service's `main` should use, before any
 * application module is imported.
 *
 * @param options - the service's resource identity and exporter tuning.
 * @returns the started telemetry handle.
 */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  const telemetry = createTelemetry(options);
  telemetry.start();
  registerGracefulShutdown(telemetry);
  return telemetry;
}
