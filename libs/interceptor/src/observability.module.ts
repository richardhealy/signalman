/**
 * NestJS wiring for the {@link ObservabilityInterceptor}.
 *
 * A service imports `ObservabilityModule.forRoot({ scope: 'inventory' })` once;
 * by default the interceptor is registered globally (via `APP_INTERCEPTOR`) so
 * every controller and gRPC handler is traced and metered without per-handler
 * decoration. The tracer and meter are obtained from `@signalman/otel`, keeping
 * that library the single instrumentation surface.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { getMeter, getTracer } from '@signalman/otel';
import { ObservabilityInterceptor } from './observability.interceptor';
import { RedMetrics } from './red-metrics';

/** Options for {@link ObservabilityModule.forRoot}. */
export interface ObservabilityModuleOptions {
  /**
   * Instrumentation scope name — typically the service name (`inventory`,
   * `coordinator`). Used for both the tracer and meter scope.
   */
  scope: string;
  /** Optional scope version, propagated to the tracer and meter. */
  scopeVersion?: string;
  /** Metric name prefix; defaults to the RED default in {@link RedMetrics}. */
  metricPrefix?: string;
  /**
   * Register the interceptor as a global `APP_INTERCEPTOR`. Defaults to `true`;
   * set `false` to bind it selectively with `@UseInterceptors` instead.
   */
  global?: boolean;
}

@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    const interceptor: Provider = {
      provide: ObservabilityInterceptor,
      useFactory: () =>
        new ObservabilityInterceptor({
          tracer: getTracer(options.scope, options.scopeVersion),
          metrics: new RedMetrics({
            meter: getMeter(options.scope, options.scopeVersion),
            prefix: options.metricPrefix,
          }),
        }),
    };

    const providers: Provider[] = [interceptor];
    if (options.global ?? true) {
      providers.push({ provide: APP_INTERCEPTOR, useExisting: ObservabilityInterceptor });
    }

    return {
      module: ObservabilityModule,
      providers,
      exports: [ObservabilityInterceptor],
    };
  }
}
