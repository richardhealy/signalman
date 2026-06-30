/**
 * @packageDocumentation
 * OpenTelemetry bootstrap for Signalman services.
 *
 * Provides SDK initialisation ({@link createTelemetry}, {@link startTelemetry}),
 * OTLP configuration ({@link resolveOtlpConfig}), service-resource construction
 * ({@link buildResource}), and convenience tracer/meter accessors
 * ({@link getTracer}, {@link getMeter}).
 */
export {
  DEFAULT_OTLP_ENDPOINT,
  parseOtlpHeaders,
  resolveOtlpConfig,
  type OtlpConfig,
} from './config';
export {
  DEFAULT_ENVIRONMENT,
  SERVICE_NAMESPACE,
  buildResource,
  type ResourceOptions,
} from './resource';
export {
  DEFAULT_METRIC_EXPORT_INTERVAL_MS,
  createTelemetry,
  startTelemetry,
  type Telemetry,
  type TelemetryOptions,
} from './telemetry';
export { getMeter, getTracer } from './tracer';
