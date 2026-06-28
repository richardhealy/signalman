/**
 * End-to-end verification of the {@link NatsBroker} against a *live* JetStream
 * server. It is gated behind `NATS_TEST_URL`, so the default `npm test` (and CI,
 * which has no broker) skips it and stays green; run it with a server up:
 *
 *   nats-server -js                       # or: docker run --rm -p 4222:4222 nats -js
 *   NATS_TEST_URL=nats://localhost:4222 npm test -- nats-broker.integration
 *
 * Each test provisions its own uniquely-named stream over a unique subject prefix
 * (JetStream forbids two streams with overlapping subjects), so the cases are
 * isolated and the suite is safe to re-run against a persistent server.
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
import {
  type BrokerMessage,
  BrokerPublisher,
  NatsBroker,
  toConsumedMessage,
} from './index';

const NATS_TEST_URL = process.env.NATS_TEST_URL;
const describeMaybe = NATS_TEST_URL ? describe : describe.skip;

// A per-run token keeps stream names and subjects unique across re-runs.
const RUN = `${Date.now().toString(36)}`;
let caseSeq = 0;

/** Brokers opened during the active test, closed by the shared afterEach. */
let openBrokers: NatsBroker[] = [];

async function connectTestBroker(
  options: { maxDeliver?: number; onDeadLetter?: (m: BrokerMessage, e: unknown) => void } = {},
): Promise<{ broker: NatsBroker; subjectPrefix: string }> {
  const token = `${RUN}_${caseSeq++}`;
  const subjectPrefix = `itest_${token}`;
  const broker = await NatsBroker.connect({
    connection: { servers: NATS_TEST_URL },
    stream: { name: `ITEST_${token}`, subjects: [`${subjectPrefix}.>`] },
    ackWaitMs: 1000,
    ...options,
  });
  openBrokers.push(broker);
  return { broker, subjectPrefix };
}

async function closeOpenBrokers(): Promise<void> {
  await Promise.all(openBrokers.map((broker) => broker.close().catch(() => {})));
  openBrokers = [];
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function traceparent(): string {
  return '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
}

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

describeMaybe('NatsBroker (integration)', () => {
  afterEach(closeOpenBrokers);

  it('fans a message out to every matching subscriber, headers and id intact', async () => {
    const { broker, subjectPrefix } = await connectTestBroker();
    const subject = `${subjectPrefix}.fanout`;
    const a: BrokerMessage[] = [];
    const b: BrokerMessage[] = [];

    broker.subscribe(subject, async (message) => {
      a.push(message);
    });
    broker.subscribe(subject, async (message) => {
      b.push(message);
    });
    await broker.whenReady();

    await broker.publish({
      id: 'evt_fanout_1',
      subject,
      payload: { bookingId: 'bk_1', qty: 2 },
      headers: { traceparent: traceparent() },
    });

    await waitFor(() => a.length === 1 && b.length === 1);
    expect(a[0].id).toBe('evt_fanout_1');
    expect(a[0].payload).toEqual({ bookingId: 'bk_1', qty: 2 });
    expect(a[0].headers.traceparent).toBe(traceparent());
    expect(b[0].id).toBe('evt_fanout_1');
  });

  it('load-balances a subject across queue-group members (each message once)', async () => {
    const { broker, subjectPrefix } = await connectTestBroker();
    const subject = `${subjectPrefix}.queue`;
    const seen: string[] = [];
    const handler = async (message: BrokerMessage) => {
      seen.push(message.id);
    };

    broker.subscribe(subject, handler, { queue: 'workers' });
    broker.subscribe(subject, handler, { queue: 'workers' });
    await broker.whenReady();

    const ids = Array.from({ length: 6 }, (_, i) => `evt_q_${i}`);
    for (const id of ids) {
      await broker.publish({ id, subject, payload: { i: id }, headers: {} });
    }

    await waitFor(() => seen.length === 6);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('redelivers a NACKed message until the handler succeeds (at-least-once)', async () => {
    const { broker, subjectPrefix } = await connectTestBroker();
    const subject = `${subjectPrefix}.retry`;
    let attempts = 0;

    broker.subscribe(subject, async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient');
      }
    });
    await broker.whenReady();

    await broker.publish({ id: 'evt_retry_1', subject, payload: {}, headers: {} });

    await waitFor(() => attempts >= 3);
    expect(attempts).toBe(3);
  });

  it('dead-letters a message after maxDeliver failed attempts', async () => {
    const deadLettered: BrokerMessage[] = [];
    const { broker, subjectPrefix } = await connectTestBroker({
      maxDeliver: 3,
      onDeadLetter: (message) => deadLettered.push(message),
    });
    const subject = `${subjectPrefix}.dlq`;
    let attempts = 0;

    broker.subscribe(subject, async () => {
      attempts += 1;
      throw new Error('always fails');
    });
    await broker.whenReady();

    await broker.publish({ id: 'evt_dlq_1', subject, payload: {}, headers: {} });

    await waitFor(() => deadLettered.length === 1);
    expect(attempts).toBe(3);
    expect(deadLettered[0].id).toBe('evt_dlq_1');
  });
});

/**
 * The spec's headline — async half — proven over the *real* transport: a staged
 * outbox event, drained by the relay through JetStream, consumed by the
 * idempotent inbox, all hanging off **one connected trace**. The in-process
 * counterpart lives in `trace-continuity.spec.ts`; this is the same assertion
 * with NATS in the middle.
 */
describeMaybe('NatsBroker trace continuity (integration)', () => {
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
    await closeOpenBrokers();
    contextManager.disable();
    otelContext.disable();
    await provider.shutdown();
  });

  it('keeps one trace from saga step through JetStream publish to consume', async () => {
    const { broker, subjectPrefix } = await connectTestBroker();
    const subject = `${subjectPrefix}.committed`;

    // 1. A saga step stages an event, capturing its trace context.
    const sagaSpan = tracer.startSpan('ledger.commit');
    const staged = otelContext.with(trace.setSpan(otelContext.active(), sagaSpan), () =>
      createOutboxRecord(
        {
          aggregateType: 'booking',
          aggregateId: 'bk_1',
          eventType: subject,
          payload: { bookingId: 'bk_1', amount: 42 },
        },
        { idFactory: () => 'rec_1' },
      ),
    );
    sagaSpan.end();

    const outbox = new InMemoryOutboxStore();
    await outbox.add(staged);

    // 2. A deduping consumer on the real broker.
    const consumer = new IdempotentConsumer({
      store: new InMemoryInboxStore(),
      consumer: 'notifier',
      tracer,
      messagingSystem: 'nats',
    });
    const handled: string[] = [];
    broker.subscribe(subject, async (message) => {
      await consumer.consume(toConsumedMessage(message), async () => {
        handled.push(message.id);
      });
    });
    await broker.whenReady();

    // 3. The relay drains the outbox onto JetStream; the broker delivers.
    const relay = new OutboxRelay({
      store: outbox,
      publisher: new BrokerPublisher(broker),
      tracer,
      messagingSystem: 'nats',
    });
    await relay.relayOnce();

    await waitFor(() => handled.length === 1);
    expect(handled).toEqual(['rec_1']);

    // 4. saga step → publish (PRODUCER) → consume (CONSUMER) share one trace.
    const spans = exporter.getFinishedSpans();
    const publish = spans.find((s) => s.name === `publish ${subject}`);
    const consume = spans.find((s) => s.name === `consume ${subject}`);

    expect(publish).toBeDefined();
    expect(consume).toBeDefined();
    expect(publish!.kind).toBe(SpanKind.PRODUCER);
    expect(consume!.kind).toBe(SpanKind.CONSUMER);

    const traceId = sagaSpan.spanContext().traceId;
    expect(publish!.spanContext().traceId).toBe(traceId);
    expect(consume!.spanContext().traceId).toBe(traceId);
    expect(parentSpanId(publish!)).toBe(sagaSpan.spanContext().spanId);
    expect(parentSpanId(consume!)).toBe(publish!.spanContext().spanId);
  });
});
