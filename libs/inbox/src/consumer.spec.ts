import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { injectContext, type BrokerHeaders } from '@signalman/propagation';
import { IdempotentConsumer, type ConsumedMessage } from './consumer';
import { InMemoryInboxStore } from './memory-store';

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

function messageOn(headers: BrokerHeaders): ConsumedMessage {
  return { messageId: 'msg_1', eventType: 'supplier.confirmed', headers };
}

describe('IdempotentConsumer', () => {
  let store: InMemoryInboxStore;
  const now = new Date('2026-06-28T10:00:00.000Z');

  beforeEach(() => {
    store = new InMemoryInboxStore();
  });

  it('runs the handler once and reports the result', async () => {
    const consumer = new IdempotentConsumer({ store, consumer: 'ledger', clock: () => now });
    const handler = jest.fn().mockResolvedValue('committed');

    const result = await consumer.consume(messageOn({}), handler);

    expect(result).toEqual({ status: 'processed', result: 'committed' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await store.seen({ consumer: 'ledger', messageId: 'msg_1' })).toBe(true);
  });

  it('skips the handler on a redelivery (redelivery-safe)', async () => {
    const consumer = new IdempotentConsumer({ store, consumer: 'ledger', clock: () => now });
    const handler = jest.fn().mockResolvedValue(undefined);

    await consumer.consume(messageOn({}), handler);
    const second = await consumer.consume(messageOn({}), handler);

    expect(second).toEqual({ status: 'duplicate' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates dedup per consumer so fan-out consumers each handle the message', async () => {
    const ledger = new IdempotentConsumer({ store, consumer: 'ledger', clock: () => now });
    const notifier = new IdempotentConsumer({ store, consumer: 'notifier', clock: () => now });
    const ledgerHandler = jest.fn().mockResolvedValue(undefined);
    const notifierHandler = jest.fn().mockResolvedValue(undefined);

    await ledger.consume(messageOn({}), ledgerHandler);
    const notifierResult = await notifier.consume(messageOn({}), notifierHandler);

    expect(notifierResult.status).toBe('processed');
    expect(ledgerHandler).toHaveBeenCalledTimes(1);
    expect(notifierHandler).toHaveBeenCalledTimes(1);
  });

  describe('tracing', () => {
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

    /** Headers carrying the publish span's context, as the broker would deliver them. */
    function headersFromPublish(): { headers: BrokerHeaders; publishSpanId: string; traceId: string } {
      const publishSpan = tracer.startSpan('publish supplier.confirmed', { kind: SpanKind.PRODUCER });
      const headers = injectContext(
        trace.setSpan(otelContext.active(), publishSpan),
        {},
      );
      const ctx = publishSpan.spanContext();
      publishSpan.end();
      return { headers, publishSpanId: ctx.spanId, traceId: ctx.traceId };
    }

    it('joins the publish trace: consume span is a child on the same trace', async () => {
      const { headers, publishSpanId, traceId } = headersFromPublish();
      const consumer = new IdempotentConsumer({
        store,
        consumer: 'ledger',
        tracer,
        messagingSystem: 'nats',
        clock: () => now,
      });

      await consumer.consume(messageOn(headers), jest.fn().mockResolvedValue(undefined));

      const consumeSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === 'consume supplier.confirmed');
      expect(consumeSpan).toBeDefined();
      expect(consumeSpan!.kind).toBe(SpanKind.CONSUMER);
      expect(consumeSpan!.spanContext().traceId).toBe(traceId);
      expect(parentSpanId(consumeSpan!)).toBe(publishSpanId);
      expect(consumeSpan!.status.code).toBe(SpanStatusCode.OK);
      expect(consumeSpan!.attributes).toMatchObject({
        'messaging.operation.name': 'process',
        'messaging.destination.name': 'supplier.confirmed',
        'messaging.message.id': 'msg_1',
        'messaging.system': 'nats',
        'signalman.inbox.consumer': 'ledger',
      });
    });

    it('makes the consume span active so the handler nests under it', async () => {
      const consumer = new IdempotentConsumer({ store, consumer: 'ledger', tracer, clock: () => now });

      await consumer.consume(messageOn({}), async () => {
        const child = tracer.startSpan('write ledger entry');
        child.end();
      });

      const spans = exporter.getFinishedSpans();
      const consumeSpan = spans.find((s) => s.name === 'consume supplier.confirmed');
      const childSpan = spans.find((s) => s.name === 'write ledger entry');
      expect(parentSpanId(childSpan!)).toBe(consumeSpan!.spanContext().spanId);
    });

    it('tags a duplicate on the span instead of dropping it silently', async () => {
      const consumer = new IdempotentConsumer({ store, consumer: 'ledger', tracer, clock: () => now });

      await consumer.consume(messageOn({}), jest.fn().mockResolvedValue(undefined));
      await consumer.consume(messageOn({}), jest.fn().mockResolvedValue(undefined));

      const dupSpans = exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'consume supplier.confirmed');
      expect(dupSpans).toHaveLength(2);
      const dup = dupSpans[1];
      expect(dup.attributes['signalman.inbox.duplicate']).toBe(true);
      expect(dup.events.map((e) => e.name)).toContain('messaging.duplicate.dropped');
    });

    it('records the error and rethrows so the caller can NACK', async () => {
      const consumer = new IdempotentConsumer({ store, consumer: 'ledger', tracer, clock: () => now });
      const boom = new TypeError('ledger write failed');

      await expect(
        consumer.consume(messageOn({}), jest.fn().mockRejectedValue(boom)),
      ).rejects.toBe(boom);

      const span = exporter.getFinishedSpans().find((s) => s.name === 'consume supplier.confirmed');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.status.message).toBe('ledger write failed');
      expect(span!.attributes['error.type']).toBe('TypeError');
      expect(span!.events.map((e) => e.name)).toContain('exception');

      // The failure rolled back the marker, so a redelivery reprocesses.
      expect(await store.seen({ consumer: 'ledger', messageId: 'msg_1' })).toBe(false);
    });
  });
});
