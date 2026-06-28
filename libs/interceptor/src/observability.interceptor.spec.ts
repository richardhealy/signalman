import {
  context as otelContext,
  metrics as metricsApi,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError, toArray } from 'rxjs';
import { ObservabilityInterceptor } from './observability.interceptor';
import { RedMetrics } from './red-metrics';

/** A monotonic clock stub that advances by a fixed step on each read. */
function steppingClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

/** Build an HTTP ExecutionContext stub for the interceptor under test. */
function httpContext(): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => ({ name: 'InventoryController' }),
    getHandler: () => ({ name: 'hold' }),
    switchToHttp: () => ({ getRequest: () => ({ method: 'POST', route: { path: '/holds' } }) }),
  } as unknown as ExecutionContext;
}

function handlerEmitting(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function handlerThrowing(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('ObservabilityInterceptor', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let metrics: RedMetrics;
  let recordSpy: jest.SpyInstance;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    // The interceptor relies on the active context to parent child spans; in a
    // real service the NodeSDK registers this manager, so we mirror that here.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    tracer = provider.getTracer('test');
    metrics = new RedMetrics({ meter: metricsApi.getMeter('test') });
    recordSpy = jest.spyOn(metrics, 'record');
  });

  afterEach(async () => {
    contextManager.disable();
    otelContext.disable();
    await provider.shutdown();
  });

  function finishedSpan(): ReadableSpan {
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  it('passes the handler value through unchanged', async () => {
    const interceptor = new ObservabilityInterceptor({ tracer, metrics, now: steppingClock(10) });

    const values = await lastValueFrom(
      interceptor.intercept(httpContext(), handlerEmitting('ok')).pipe(toArray()),
    );

    expect(values).toEqual(['ok']);
  });

  it('opens a named SERVER span and records a success observation', async () => {
    const interceptor = new ObservabilityInterceptor({ tracer, metrics, now: steppingClock(200) });

    await lastValueFrom(interceptor.intercept(httpContext(), handlerEmitting('ok')));

    const span = finishedSpan();
    expect(span.name).toBe('POST /holds');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toMatchObject({ 'http.route': '/holds' });

    // start=0, end=200 -> 0.2s
    expect(recordSpy).toHaveBeenCalledWith(0.2, 'success', {
      operation: 'InventoryController.hold',
      'http.request.method': 'POST',
      'http.route': '/holds',
    });
  });

  it('makes the span active for the handler, so child spans join the trace', async () => {
    const interceptor = new ObservabilityInterceptor({ tracer, metrics, now: steppingClock(1) });

    const childHandler: CallHandler = {
      handle: () => {
        const child = tracer.startSpan('child');
        child.end();
        return of('ok');
      },
    };

    await lastValueFrom(interceptor.intercept(httpContext(), childHandler));

    const server = exporter.getFinishedSpans().find((s) => s.name === 'POST /holds');
    const child = exporter.getFinishedSpans().find((s) => s.name === 'child');
    expect(server).toBeDefined();
    expect(child).toBeDefined();
    // Tolerate the SDK exposing the parent as parentSpanContext (2.x) or parentSpanId.
    const parentId =
      (child as unknown as { parentSpanContext?: { spanId: string }; parentSpanId?: string })
        .parentSpanContext?.spanId ??
      (child as unknown as { parentSpanId?: string }).parentSpanId;
    expect(child!.spanContext().traceId).toBe(server!.spanContext().traceId);
    expect(parentId).toBe(server!.spanContext().spanId);
  });

  it('marks the span errored, records the exception, and counts an error', async () => {
    const interceptor = new ObservabilityInterceptor({ tracer, metrics, now: steppingClock(50) });
    const boom = new TypeError('inventory unavailable');

    await expect(
      lastValueFrom(interceptor.intercept(httpContext(), handlerThrowing(boom))),
    ).rejects.toBe(boom);

    const span = finishedSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('inventory unavailable');
    expect(span.attributes['error.type']).toBe('TypeError');
    expect(span.events.map((e) => e.name)).toContain('exception');

    expect(recordSpy).toHaveBeenCalledWith(0.05, 'error', {
      operation: 'InventoryController.hold',
      'http.request.method': 'POST',
      'http.route': '/holds',
      'error.type': 'TypeError',
    });
  });

  it('classifies a non-Error rejection as the _OTHER error type', async () => {
    const interceptor = new ObservabilityInterceptor({ tracer, metrics, now: steppingClock(1) });

    await expect(
      lastValueFrom(interceptor.intercept(httpContext(), handlerThrowing('plain string'))),
    ).rejects.toBe('plain string');

    const span = finishedSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('_OTHER');
  });
});
