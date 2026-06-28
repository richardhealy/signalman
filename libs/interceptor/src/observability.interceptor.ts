/**
 * The interceptor that turns every inbound handler into a business span and a
 * RED metric observation.
 *
 * It wraps the handler in a SERVER span made active for the duration of the
 * call — so any child span the handler opens (a gRPC client call, a DB query,
 * an outbox write) joins the same trace — and records the operation's outcome
 * and latency on the {@link RedMetrics} bundle. This is the per-service half of
 * the spec's "one booking is one connected trace": the propagation library
 * carries context *between* services, this carries it *within* one.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import {
  SpanStatusCode,
  context as otelContext,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE, ERROR_TYPE_VALUE_OTHER } from '@opentelemetry/semantic-conventions';
import { Observable } from 'rxjs';
import { resolveOperation, type ResolvedOperation } from './operation';
import { RedMetrics } from './red-metrics';

/** Construction inputs for the {@link ObservabilityInterceptor}. */
export interface ObservabilityInterceptorOptions {
  /** Tracer to open spans on; usually scoped to the service name. */
  tracer: Tracer;
  /** RED metrics bundle the operation's outcome and latency are recorded on. */
  metrics: RedMetrics;
  /**
   * Monotonic clock returning milliseconds, injectable for tests. Defaults to
   * `performance.now()`, which is unaffected by wall-clock adjustments.
   */
  now?: () => number;
}

/** The OTel `error.type` for an error value, by its constructor name. */
function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || ERROR_TYPE_VALUE_OTHER;
  }
  return ERROR_TYPE_VALUE_OTHER;
}

@Injectable()
export class ObservabilityInterceptor implements NestInterceptor {
  private readonly tracer: Tracer;
  private readonly metrics: RedMetrics;
  private readonly now: () => number;

  constructor(options: ObservabilityInterceptorOptions) {
    this.tracer = options.tracer;
    this.metrics = options.metrics;
    this.now = options.now ?? (() => performance.now());
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operation = resolveOperation(context);
    const span = this.tracer.startSpan(operation.name, {
      kind: operation.kind,
      attributes: operation.attributes,
    });
    const startedAt = this.now();
    const activeContext = trace.setSpan(otelContext.active(), span);

    // Subscribe *inside* the span's context so the handler — and anything it
    // awaits — runs with this span active. We defer into a fresh Observable
    // because Nest subscribes lazily; binding the context at `intercept` time
    // would leave it inactive by the time the handler actually executes.
    return new Observable<unknown>((subscriber) => {
      const subscription = otelContext.with(activeContext, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => {
            this.finish(span, operation, startedAt, error);
            subscriber.error(error);
          },
          complete: () => {
            this.finish(span, operation, startedAt, undefined);
            subscriber.complete();
          },
        }),
      );
      return () => subscription.unsubscribe();
    });
  }

  /** Close the span, set its status, and record the RED observation. */
  private finish(
    span: Span,
    operation: ResolvedOperation,
    startedAt: number,
    error: unknown,
  ): void {
    const durationSeconds = Math.max(0, (this.now() - startedAt) / 1000);

    if (error === undefined) {
      // A SERVER span is left UNSET on success per the OTel span-status spec;
      // only failures are explicitly marked.
      this.metrics.record(durationSeconds, 'success', operation.metricAttributes);
    } else {
      const type = errorType(error);
      span.recordException(error instanceof Error ? error : { message: String(error) });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.setAttribute(ATTR_ERROR_TYPE, type);
      this.metrics.record(durationSeconds, 'error', {
        ...operation.metricAttributes,
        [ATTR_ERROR_TYPE]: type,
      });
    }

    span.end();
  }
}
