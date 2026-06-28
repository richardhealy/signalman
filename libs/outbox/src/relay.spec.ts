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
import { extractContext } from '@signalman/propagation';
import { InMemoryOutboxStore } from './memory-store';
import { createOutboxRecord, type OutboxMessage, type OutboxRecord } from './record';
import { OutboxRelay, defaultBackoff, type Publisher } from './relay';

const message: OutboxMessage = {
  aggregateType: 'booking',
  aggregateId: 'bk_1',
  eventType: 'inventory.held',
  payload: { qty: 1 },
};

/** A publisher that records what it received and never fails. */
function capturingPublisher(): Publisher & { sent: OutboxRecord[] } {
  const sent: OutboxRecord[] = [];
  return { sent, publish: async (record) => void sent.push(record) };
}

/** A publisher that throws a fixed error on every call. */
function failingPublisher(error: unknown): Publisher {
  return { publish: () => Promise.reject(error) };
}

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

describe('OutboxRelay', () => {
  let store: InMemoryOutboxStore;
  const now = new Date('2026-06-28T10:00:00.000Z');

  beforeEach(() => {
    store = new InMemoryOutboxStore();
  });

  it('publishes due records and marks them published', async () => {
    const publisher = capturingPublisher();
    await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
    const relay = new OutboxRelay({ store, publisher, clock: () => now });

    const result = await relay.relayOnce();

    expect(result).toEqual({ claimed: 1, published: 1, retried: 0, deadLettered: 0 });
    expect(publisher.sent.map((r) => r.id)).toEqual(['rec_1']);
    expect(store.get('rec_1')).toMatchObject({ status: 'published', publishedAt: now });
  });

  it('does not re-publish an already published record on the next pass', async () => {
    const publisher = capturingPublisher();
    await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
    const relay = new OutboxRelay({ store, publisher, clock: () => now });

    await relay.relayOnce();
    const second = await relay.relayOnce();

    expect(second.claimed).toBe(0);
    expect(publisher.sent).toHaveLength(1);
  });

  describe('trace propagation', () => {
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

    it('publishes on the staged trace and carries the publish span to the broker', async () => {
      // Stage the event under a saga span, the way a coordinator step would.
      const sagaSpan = tracer.startSpan('hold inventory');
      const staged = otelContext.with(trace.setSpan(otelContext.active(), sagaSpan), () =>
        createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }),
      );
      sagaSpan.end();
      await store.add(staged);

      const publisher = capturingPublisher();
      const relay = new OutboxRelay({ store, publisher, tracer, clock: () => now });

      await relay.relayOnce();

      const publishSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name === 'publish inventory.held');
      expect(publishSpan).toBeDefined();
      expect(publishSpan!.kind).toBe(SpanKind.PRODUCER);
      // The publish span continues the saga's trace as a child of the saga span.
      expect(publishSpan!.spanContext().traceId).toBe(sagaSpan.spanContext().traceId);
      expect(parentSpanId(publishSpan!)).toBe(sagaSpan.spanContext().spanId);
      expect(publishSpan!.attributes).toMatchObject({
        'messaging.operation.name': 'publish',
        'messaging.destination.name': 'inventory.held',
        'messaging.message.id': 'rec_1',
        'signalman.outbox.aggregate_type': 'booking',
      });

      // The broker message carries the publish span's context, so a consumer
      // joins under it — one connected trace end to end.
      const outgoing = trace.getSpanContext(extractContext(publisher.sent[0].headers));
      expect(outgoing?.traceId).toBe(sagaSpan.spanContext().traceId);
      expect(outgoing?.spanId).toBe(publishSpan!.spanContext().spanId);
    });

    it('marks the publish span errored when the broker rejects the event', async () => {
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
      const relay = new OutboxRelay({
        store,
        publisher: failingPublisher(new TypeError('broker unreachable')),
        tracer,
        clock: () => now,
      });

      await relay.relayOnce();

      const span = exporter.getFinishedSpans().find((s) => s.name === 'publish inventory.held');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.status.message).toBe('broker unreachable');
      expect(span!.attributes['error.type']).toBe('TypeError');
      expect(span!.events.map((e) => e.name)).toContain('exception');
    });
  });

  describe('failure handling', () => {
    it('reschedules a failed publish with back-off and bumps the attempt count', async () => {
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
      const relay = new OutboxRelay({
        store,
        publisher: failingPublisher(new Error('down')),
        clock: () => now,
        backoff: () => 5_000,
      });

      const result = await relay.relayOnce();

      expect(result).toEqual({ claimed: 1, published: 0, retried: 1, deadLettered: 0 });
      const record = store.get('rec_1');
      expect(record).toMatchObject({ status: 'pending', attempts: 1, lastError: 'down' });
      expect(record?.availableAt).toEqual(new Date(now.getTime() + 5_000));
    });

    it('dead-letters a record once it exhausts its attempt budget', async () => {
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
      const relay = new OutboxRelay({
        store,
        publisher: failingPublisher(new Error('down')),
        clock: () => now,
        maxAttempts: 1,
      });

      const result = await relay.relayOnce();

      expect(result).toEqual({ claimed: 1, published: 0, retried: 0, deadLettered: 1 });
      expect(store.get('rec_1')).toMatchObject({ status: 'failed', attempts: 1 });
    });

    it('stringifies a non-Error rejection for the recorded error', async () => {
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
      const relay = new OutboxRelay({
        store,
        publisher: failingPublisher('nope'),
        clock: () => now,
        maxAttempts: 1,
      });

      await relay.relayOnce();

      expect(store.get('rec_1')?.lastError).toBe('nope');
    });
  });

  it('defaultBackoff grows exponentially and is capped', () => {
    expect(defaultBackoff(1)).toBe(1_000);
    expect(defaultBackoff(2)).toBe(2_000);
    expect(defaultBackoff(3)).toBe(4_000);
    expect(defaultBackoff(100)).toBe(60_000);
  });

  describe('start / stop scheduler', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('polls on an interval and stops cleanly', async () => {
      const publisher = capturingPublisher();
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => now }));
      const relay = new OutboxRelay({ store, publisher, clock: () => now });
      const spy = jest.spyOn(relay, 'relayOnce');

      relay.start(1_000);
      // Async timer advance flushes each pass's microtasks before the next tick,
      // so the overlap guard does not (incorrectly) skip back-to-back passes.
      await jest.advanceTimersByTimeAsync(3_500);
      relay.stop();
      await jest.advanceTimersByTimeAsync(5_000);

      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('routes a pass error to onError instead of throwing', async () => {
      const onError = jest.fn();
      const boom = new Error('store unreachable');
      const relay = new OutboxRelay({
        store: {
          add: store.add.bind(store),
          claimBatch: () => Promise.reject(boom),
          markPublished: store.markPublished.bind(store),
          markFailed: store.markFailed.bind(store),
        },
        publisher: capturingPublisher(),
        onError,
      });

      relay.start(1_000);
      await jest.advanceTimersByTimeAsync(1_000);
      relay.stop();

      expect(onError).toHaveBeenCalledWith(boom);
    });
  });
});
