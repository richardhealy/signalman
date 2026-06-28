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
import { InMemoryInboxStore } from '@signalman/inbox';
import { injectContext, type BrokerHeaders } from '@signalman/propagation';
import {
  NotificationChannelUnavailableError,
  SimulatedNotificationChannel,
  type NotificationChannel,
  type NotificationReceipt,
  type NotificationRequest,
} from './channel';
import {
  BookingNotificationConsumer,
  NOTIFIER_CONSUMER,
  type DeliveredEvent,
  type LedgerCommittedPayload,
} from './booking-event-consumer';
import { InMemoryNotificationRepository } from './notification-repository';
import { NotifierService } from './notifier.service';

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

/** A scripted {@link NotificationChannel} that records calls and returns canned receipts. */
class FakeChannel implements NotificationChannel {
  receipt: NotificationReceipt = { providerMessageId: 'msg_provider_1' };
  sendError?: Error;
  readonly sendCalls: NotificationRequest[] = [];

  async send(request: NotificationRequest): Promise<NotificationReceipt> {
    this.sendCalls.push(request);
    if (this.sendError) {
      throw this.sendError;
    }
    return this.receipt;
  }
}

const now = new Date('2026-06-29T10:00:00.000Z');

const payload: LedgerCommittedPayload = {
  bookingId: 'bk_1',
  amount: 4200,
  currency: 'USD',
  entryId: 'entry_1',
};

function eventOn(headers: BrokerHeaders, overrides: Partial<DeliveredEvent<LedgerCommittedPayload>> = {}): DeliveredEvent<LedgerCommittedPayload> {
  return {
    messageId: 'msg_1',
    eventType: 'ledger.committed',
    headers,
    payload,
    ...overrides,
  };
}

function makeConsumer(channel: NotificationChannel, opts: { store?: InMemoryInboxStore; tracer?: Tracer } = {}) {
  const store = opts.store ?? new InMemoryInboxStore();
  const notifications = new InMemoryNotificationRepository();
  let seq = 0;
  const notifier = new NotifierService({
    notifications,
    channel,
    idFactory: () => `notif_${++seq}`,
    clock: () => now,
  });
  const consumer = new BookingNotificationConsumer({
    notifier,
    store,
    tracer: opts.tracer,
    messagingSystem: 'nats',
    clock: () => now,
  });
  return { consumer, store, notifications, notifier };
}

describe('BookingNotificationConsumer', () => {
  it('processes a ledger.committed event once and reports the notify result', async () => {
    const channel = new FakeChannel();
    const { consumer, store } = makeConsumer(channel);

    const result = await consumer.consume(eventOn({}));

    expect(result).toEqual({
      status: 'processed',
      result: { notificationId: 'notif_1', reference: 'msg_provider_1', recipient: 'booking-bk_1@example.com' },
    });
    expect(channel.sendCalls).toHaveLength(1);
    expect(await store.seen({ consumer: NOTIFIER_CONSUMER, messageId: 'msg_1' })).toBe(true);
  });

  it('skips a redelivery of the same message (redelivery-safe)', async () => {
    const channel = new FakeChannel();
    const { consumer } = makeConsumer(channel);

    await consumer.consume(eventOn({}));
    const second = await consumer.consume(eventOn({}));

    expect(second).toEqual({ status: 'duplicate' });
    expect(channel.sendCalls).toHaveLength(1); // provider hit once across both deliveries
  });

  it('dedups a second message about the same booking via the per-booking guard', async () => {
    // A distinct message id passes the inbox, but the service still notifies the
    // booking at most once — the two layers together stop a duplicate email.
    const channel = new FakeChannel();
    const { consumer } = makeConsumer(channel);

    const first = await consumer.consume(eventOn({}, { messageId: 'msg_1' }));
    const second = await consumer.consume(eventOn({}, { messageId: 'msg_2' }));

    expect(first.status).toBe('processed');
    expect(second.status).toBe('processed'); // new message id → the inbox lets it through
    expect(second.result).toEqual(first.result); // …but the same standing notification comes back
    expect(channel.sendCalls).toHaveLength(1); // provider still hit only once
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
      const publishSpan = tracer.startSpan('publish ledger.committed', { kind: SpanKind.PRODUCER });
      const headers = injectContext(trace.setSpan(otelContext.active(), publishSpan), {});
      const ctx = publishSpan.spanContext();
      publishSpan.end();
      return { headers, publishSpanId: ctx.spanId, traceId: ctx.traceId };
    }

    it('joins the publish trace and nests the provider hop under the consume span', async () => {
      const { headers, publishSpanId, traceId } = headersFromPublish();
      const channel = new SimulatedNotificationChannel({
        tracer,
        delay: () => Promise.resolve(),
        idFactory: () => 'msg_provider_1',
      });
      const { consumer } = makeConsumer(channel, { tracer });

      await consumer.consume(eventOn(headers));

      const spans = exporter.getFinishedSpans();
      const consumeSpan = spans.find((s) => s.name === 'consume ledger.committed');
      const sendSpan = spans.find((s) => s.name === 'notifier send');

      expect(consumeSpan).toBeDefined();
      expect(consumeSpan!.kind).toBe(SpanKind.CONSUMER);
      expect(consumeSpan!.spanContext().traceId).toBe(traceId);
      expect(parentSpanId(consumeSpan!)).toBe(publishSpanId);
      expect(consumeSpan!.attributes).toMatchObject({
        'messaging.operation.name': 'process',
        'messaging.destination.name': 'ledger.committed',
        'messaging.message.id': 'msg_1',
        'messaging.system': 'nats',
        'signalman.inbox.consumer': 'notifier',
      });

      // The provider CLIENT span is on the same booking trace, parented to consume.
      expect(sendSpan).toBeDefined();
      expect(sendSpan!.spanContext().traceId).toBe(traceId);
      expect(parentSpanId(sendSpan!)).toBe(consumeSpan!.spanContext().spanId);
    });

    it('records the error and rethrows on a provider outage so the caller can NACK', async () => {
      const channel = new FakeChannel();
      channel.sendError = new NotificationChannelUnavailableError('notification provider unreachable');
      const { consumer, store } = makeConsumer(channel, { tracer });

      await expect(consumer.consume(eventOn({}))).rejects.toBeInstanceOf(
        NotificationChannelUnavailableError,
      );

      const span = exporter.getFinishedSpans().find((s) => s.name === 'consume ledger.committed');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes['error.type']).toBe('NotificationChannelUnavailableError');

      // The marker rolled back, so a redelivery reprocesses rather than skipping.
      expect(await store.seen({ consumer: NOTIFIER_CONSUMER, messageId: 'msg_1' })).toBe(false);
    });
  });
});
