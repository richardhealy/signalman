/**
 * The async-event hop, end to end: a staged outbox event, drained by the relay
 * through the broker, consumed by the idempotent inbox — and the assertion the
 * spec's headline turns on, that all three hops hang off **one connected trace**
 * with no orphan spans. This is the async half of "one booking = one trace"
 * (M3), the counterpart to the synchronous gRPC half wired in the coordinator.
 */
import {
  SpanKind,
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
import { IdempotentConsumer, InMemoryInboxStore } from '@signalman/inbox';
import { InMemoryOutboxStore, OutboxRelay, createOutboxRecord } from '@signalman/outbox';
import { type BrokerMessage } from './message';
import { InMemoryBroker } from './memory-broker';
import { BrokerPublisher } from './outbox-publisher';
import { toConsumedMessage } from './bridge';

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

const ledgerCommitted: BrokerMessage = {
  id: 'rec_1',
  subject: 'ledger.committed',
  payload: { bookingId: 'bk_1', amount: 42 },
  headers: {},
};

describe('async-event hop trace continuity', () => {
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

  it('keeps one trace from saga step through publish to consume', async () => {
    // 1. A saga step (the coordinator's ledger.commit leg) stages an event.
    const sagaSpan = tracer.startSpan('ledger.commit');
    const staged = otelContext.with(trace.setSpan(otelContext.active(), sagaSpan), () =>
      createOutboxRecord(
        {
          aggregateType: 'booking',
          aggregateId: 'bk_1',
          eventType: 'ledger.committed',
          payload: { bookingId: 'bk_1', amount: 42 },
        },
        { idFactory: () => 'rec_1' },
      ),
    );
    sagaSpan.end();

    const outbox = new InMemoryOutboxStore();
    await outbox.add(staged);

    // 2. The broker, the relay publishing into it, and a deduping consumer.
    const broker = new InMemoryBroker();
    const consumer = new IdempotentConsumer({
      store: new InMemoryInboxStore(),
      consumer: 'notifier',
      tracer,
      messagingSystem: 'memory',
    });
    const handled: string[] = [];
    broker.subscribe('ledger.committed', async (message) => {
      await consumer.consume(toConsumedMessage(message), async () => {
        handled.push(message.id);
      });
    });

    const relay = new OutboxRelay({
      store: outbox,
      publisher: new BrokerPublisher(broker),
      tracer,
      messagingSystem: 'memory',
    });

    // 3. Drain the outbox (publish) and let the broker deliver to the consumer.
    await relay.relayOnce();
    await broker.drain();

    expect(handled).toEqual(['rec_1']);

    // 4. The three hops form one connected trace with the right lineage.
    const spans = exporter.getFinishedSpans();
    const publish = spans.find((s) => s.name === 'publish ledger.committed');
    const consume = spans.find((s) => s.name === 'consume ledger.committed');

    expect(publish).toBeDefined();
    expect(consume).toBeDefined();
    expect(publish!.kind).toBe(SpanKind.PRODUCER);
    expect(consume!.kind).toBe(SpanKind.CONSUMER);

    const traceId = sagaSpan.spanContext().traceId;
    expect(publish!.spanContext().traceId).toBe(traceId);
    expect(consume!.spanContext().traceId).toBe(traceId);
    // publish continues the saga step; consume continues the publish.
    expect(parentSpanId(publish!)).toBe(sagaSpan.spanContext().spanId);
    expect(parentSpanId(consume!)).toBe(publish!.spanContext().spanId);
  });

  it('processes a duplicate delivery once — effectively-once over the broker', async () => {
    const broker = new InMemoryBroker();
    const consumer = new IdempotentConsumer({
      store: new InMemoryInboxStore(),
      consumer: 'notifier',
      messagingSystem: 'memory',
    });
    const handled: string[] = [];
    const statuses: string[] = [];
    broker.subscribe('ledger.committed', async (message) => {
      const { status } = await consumer.consume(toConsumedMessage(message), async () => {
        handled.push(message.id);
      });
      statuses.push(status);
    });

    // The outbox is at-least-once: the same id can arrive twice.
    await broker.publish(ledgerCommitted);
    await broker.publish(ledgerCommitted);
    await broker.drain();

    expect(handled).toEqual(['rec_1']);
    expect(statuses).toEqual(['processed', 'duplicate']);
  });

  it('redelivers and reprocesses after a transient handler failure (NACK)', async () => {
    const broker = new InMemoryBroker();
    const consumer = new IdempotentConsumer({
      store: new InMemoryInboxStore(),
      consumer: 'notifier',
      messagingSystem: 'memory',
    });
    let attempts = 0;
    const handled: string[] = [];
    broker.subscribe('ledger.committed', async (message) => {
      await consumer.consume(toConsumedMessage(message), async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error('provider down');
        }
        handled.push(message.id);
      });
    });

    await broker.publish(ledgerCommitted);
    await broker.drain();

    // First delivery NACKs (handler throws → consumer rethrows), broker
    // redelivers, second delivery succeeds and the inbox records it once.
    expect(attempts).toBe(2);
    expect(handled).toEqual(['rec_1']);
  });
});
