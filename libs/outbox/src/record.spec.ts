import { context as otelContext, trace, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { extractContext } from '@signalman/propagation';
import { createOutboxRecord, type OutboxMessage } from './record';

const message: OutboxMessage = {
  aggregateType: 'booking',
  aggregateId: 'bk_123',
  eventType: 'inventory.held',
  payload: { qty: 2 },
};

describe('createOutboxRecord', () => {
  it('stamps a pending record with id, clock times, and the staged message', () => {
    const at = new Date('2026-06-28T10:00:00.000Z');
    const record = createOutboxRecord(message, {
      idFactory: () => 'rec_1',
      clock: () => at,
    });

    expect(record).toMatchObject({
      id: 'rec_1',
      aggregateType: 'booking',
      aggregateId: 'bk_123',
      eventType: 'inventory.held',
      payload: { qty: 2 },
      status: 'pending',
      attempts: 0,
    });
    expect(record.createdAt).toBe(at);
    // Immediately claimable: availableAt equals createdAt on staging.
    expect(record.availableAt).toBe(at);
    expect(record.publishedAt).toBeUndefined();
    expect(record.lastError).toBeUndefined();
  });

  it('preserves caller-supplied headers', () => {
    const record = createOutboxRecord(
      { ...message, headers: { 'x-tenant': 'acme' } },
      { context: otelContext.active() },
    );

    expect(record.headers['x-tenant']).toBe('acme');
  });

  it('writes no traceparent when no span is active', () => {
    const record = createOutboxRecord(message);

    expect(record.headers.traceparent).toBeUndefined();
  });

  describe('with an active trace context', () => {
    let contextManager: AsyncLocalStorageContextManager;
    let provider: BasicTracerProvider;
    let tracer: Tracer;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      contextManager = new AsyncLocalStorageContextManager();
      contextManager.enable();
      otelContext.setGlobalContextManager(contextManager);
      exporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      tracer = provider.getTracer('test');
    });

    afterEach(async () => {
      contextManager.disable();
      otelContext.disable();
      await provider.shutdown();
    });

    it('captures the active span context into the record headers', () => {
      const sagaSpan = tracer.startSpan('hold inventory');
      const activeContext = trace.setSpan(otelContext.active(), sagaSpan);

      const record = otelContext.with(activeContext, () => createOutboxRecord(message));
      sagaSpan.end();

      // The record carries a traceparent that resolves back to the saga span,
      // so the relay can publish the event on the same trace later.
      expect(typeof record.headers.traceparent).toBe('string');
      const extracted = trace.getSpanContext(extractContext(record.headers));
      expect(extracted?.traceId).toBe(sagaSpan.spanContext().traceId);
      expect(extracted?.spanId).toBe(sagaSpan.spanContext().spanId);
    });
  });
});
