import { SpanKind, SpanStatusCode, context as otelContext, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { PspUnavailableError, SimulatedPsp } from './psp';

describe('SimulatedPsp', () => {
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

  describe('authorize', () => {
    it('approves and returns the PSP authorization reference', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, idFactory: () => 'auth_1' });

      const result = await psp.authorize({ bookingId: 'bk_1', amount: 5000, currency: 'USD' });

      expect(result).toEqual({ approved: true, authorizationId: 'auth_1' });
    });

    it('emits a CLIENT span for the external hop, attributed to the PSP', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, idFactory: () => 'auth_1' });

      await psp.authorize({ bookingId: 'bk_1', amount: 5000, currency: 'USD' });

      const span = exporter.getFinishedSpans().find((s) => s.name === 'psp authorize');
      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.CLIENT);
      expect(span!.status.code).toBe(SpanStatusCode.OK);
      expect(span!.attributes).toMatchObject({
        'signalman.psp.operation': 'authorize',
        'peer.service': 'psp-simulator',
        'signalman.psp.booking_id': 'bk_1',
        'signalman.psp.amount': 5000,
        'signalman.psp.currency': 'USD',
        'signalman.psp.outcome': 'approved',
        'signalman.psp.authorization_id': 'auth_1',
      });
    });

    it('declines when the decline roll hits, returning a reason and a clean span', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, declineRate: 1, random: () => 0 });

      const result = await psp.authorize({ bookingId: 'bk_1', amount: 5000, currency: 'USD' });

      expect(result).toEqual({ approved: false, declineReason: 'card_declined' });
      const span = exporter.getFinishedSpans().find((s) => s.name === 'psp authorize');
      // A decline is a successful call with a business "no", not a span error.
      expect(span!.status.code).toBe(SpanStatusCode.OK);
      expect(span!.attributes['signalman.psp.outcome']).toBe('declined');
    });

    it('throws and records an errored span when the PSP is unavailable', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, failureRate: 1, random: () => 0 });

      await expect(
        psp.authorize({ bookingId: 'bk_1', amount: 5000, currency: 'USD' }),
      ).rejects.toBeInstanceOf(PspUnavailableError);

      const span = exporter.getFinishedSpans().find((s) => s.name === 'psp authorize');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes['error.type']).toBe('PspUnavailableError');
      expect(span!.events.map((e) => e.name)).toContain('exception');
    });

    it('applies the configured latency through the delay seam', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, latencyMs: 200, idFactory: () => 'a' });

      await psp.authorize({ bookingId: 'bk_1', amount: 100, currency: 'USD' });

      expect(delays).toEqual([200]);
    });

    it('decides decline/failure independently of each other via the rate rolls', async () => {
      // random() = 0.5: above declineRate 0.2 (no decline) and failureRate 0.1 (no failure).
      const psp = new SimulatedPsp({
        tracer,
        delay: noopDelay,
        declineRate: 0.2,
        failureRate: 0.1,
        random: () => 0.5,
        idFactory: () => 'auth_ok',
      });

      const result = await psp.authorize({ bookingId: 'bk_1', amount: 100, currency: 'USD' });

      expect(result).toEqual({ approved: true, authorizationId: 'auth_ok' });
    });
  });

  describe('capture', () => {
    it('returns a capture reference and spans the hop', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, idFactory: () => 'cap_1' });

      const result = await psp.capture('auth_1');

      expect(result).toEqual({ captureId: 'cap_1' });
      const span = exporter.getFinishedSpans().find((s) => s.name === 'psp capture');
      expect(span!.kind).toBe(SpanKind.CLIENT);
      expect(span!.attributes).toMatchObject({
        'signalman.psp.operation': 'capture',
        'signalman.psp.authorization_id': 'auth_1',
        'signalman.psp.capture_id': 'cap_1',
      });
    });

    it('throws and records an errored span when the PSP is unavailable', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, failureRate: 1, random: () => 0 });

      await expect(psp.capture('auth_1')).rejects.toBeInstanceOf(PspUnavailableError);
      const span = exporter.getFinishedSpans().find((s) => s.name === 'psp capture');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('voidAuthorization', () => {
    it('resolves and spans the hop', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay });

      await expect(psp.voidAuthorization('auth_1')).resolves.toBeUndefined();
      const span = exporter.getFinishedSpans().find((s) => s.name === 'psp void');
      expect(span!.kind).toBe(SpanKind.CLIENT);
      expect(span!.status.code).toBe(SpanStatusCode.OK);
      expect(span!.attributes['signalman.psp.authorization_id']).toBe('auth_1');
    });

    it('throws when the PSP is unavailable', async () => {
      const psp = new SimulatedPsp({ tracer, delay: noopDelay, failureRate: 1, random: () => 0 });

      await expect(psp.voidAuthorization('auth_1')).rejects.toBeInstanceOf(PspUnavailableError);
    });
  });
});
