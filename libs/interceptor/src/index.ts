/**
 * @packageDocumentation
 * NestJS observability interceptor for Signalman services.
 *
 * {@link ObservabilityModule} registers a global {@link ObservabilityInterceptor}
 * that wraps every handler in an OpenTelemetry SERVER or CONSUMER span, records
 * RED metrics (requests, errors, duration), and propagates the upstream trace
 * context extracted from gRPC metadata or broker headers.
 */
export {
  DEFAULT_METRIC_PREFIX,
  RedMetrics,
  type Outcome,
  type RedMetricsOptions,
} from './red-metrics';
export { resolveOperation, resolveParentContext, type ResolvedOperation } from './operation';
export {
  ObservabilityInterceptor,
  type ObservabilityInterceptorOptions,
} from './observability.interceptor';
export {
  ObservabilityModule,
  type ObservabilityModuleOptions,
} from './observability.module';
