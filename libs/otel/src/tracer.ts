/**
 * Thin accessors over the global OpenTelemetry providers.
 *
 * Once {@link startTelemetry} has run, the Node SDK has registered global
 * tracer and meter providers. These helpers let the rest of a service obtain a
 * tracer or meter without importing `@opentelemetry/api` directly, keeping
 * `@signalman/otel` the single instrumentation surface. Before the SDK starts
 * (or in a service that never starts it) they return no-op instruments, so call
 * sites never have to null-check.
 */
import { metrics, trace, type Meter, type Tracer } from '@opentelemetry/api';

/**
 * Get a named tracer from the global provider. The name should identify the
 * instrumenting library or module (the OTel instrumentation scope), e.g.
 * `@signalman/coordinator`.
 *
 * @param name - instrumentation scope name.
 * @param version - optional scope version.
 */
export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

/**
 * Get a named meter from the global provider, for recording RED metrics and
 * per-step SLOs.
 *
 * @param name - instrumentation scope name.
 * @param version - optional scope version.
 */
export function getMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}
