import { SpanKind, SpanStatusCode, context as otelContext, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  NotificationChannelUnavailableError,
  SimulatedNotificationChannel,
  type NotificationRequest,
} from './channel';

describe('SimulatedNotificationChannel', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let exporter: InMemorySpanExporter;
  /** A delay seam that records its argument and resolves immediately (no real timers). */
  let delays: number[];
  const noopDelay = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };

  beforeEach(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    tracer = provider.getTracer('test');
    delays = [];
  });

  afterEach(async () => {
    contextManager.disable();
    otelContext.disable();
    await provider.shutdown();
  });

  const sendReq: NotificationRequest = {
    bookingId: 'bk_1',
    recipient: 'booking-bk_1@example.com',
    channel: 'email',
    kind: 'booking_confirmed',
  };

  it('sends and returns the provider message reference', async () => {
    const channel = new SimulatedNotificationChannel({
      tracer,
      delay: noopDelay,
      idFactory: () => 'msg_provider_1',
    });

    const receipt = await channel.send(sendReq);

    expect(receipt).toEqual({ providerMessageId: 'msg_provider_1' });
  });

  it('emits a CLIENT span for the provider hop, attributed to the provider', async () => {
    const channel = new SimulatedNotificationChannel({
      tracer,
      delay: noopDelay,
      idFactory: () => 'msg_provider_1',
    });

    await channel.send(sendReq);

    const span = exporter.getFinishedSpans().find((s) => s.name === 'notifier send');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.attributes).toMatchObject({
      'signalman.notifier.operation': 'send',
      'peer.service': 'notification-provider',
      'signalman.notifier.booking_id': 'bk_1',
      'signalman.notifier.recipient': 'booking-bk_1@example.com',
      'signalman.notifier.channel': 'email',
      'signalman.notifier.kind': 'booking_confirmed',
      'signalman.notifier.outcome': 'sent',
      'signalman.notifier.reference': 'msg_provider_1',
    });
  });

  it('throws and records an errored span when the provider is unreachable', async () => {
    const channel = new SimulatedNotificationChannel({
      tracer,
      delay: noopDelay,
      failureRate: 1,
      random: () => 0,
    });

    await expect(channel.send(sendReq)).rejects.toBeInstanceOf(NotificationChannelUnavailableError);

    const span = exporter.getFinishedSpans().find((s) => s.name === 'notifier send');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes['error.type']).toBe('NotificationChannelUnavailableError');
    expect(span!.events.map((e) => e.name)).toContain('exception');
  });

  it('applies the configured latency through the delay seam', async () => {
    const channel = new SimulatedNotificationChannel({
      tracer,
      delay: noopDelay,
      latencyMs: 50,
      idFactory: () => 'm',
    });

    await channel.send(sendReq);

    expect(delays).toEqual([50]);
  });

  it('does not fail when the roll lands above the failure rate', async () => {
    // random() = 0.5 sits above failureRate 0.1, so the send goes through.
    const channel = new SimulatedNotificationChannel({
      tracer,
      delay: noopDelay,
      failureRate: 0.1,
      random: () => 0.5,
      idFactory: () => 'msg_ok',
    });

    await expect(channel.send(sendReq)).resolves.toEqual({ providerMessageId: 'msg_ok' });
  });
});
