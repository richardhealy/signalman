import { SpanKind, SpanStatusCode, context as otelContext, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { SimulatedSupplierPartner, SupplierUnavailableError } from './partner';

describe('SimulatedSupplierPartner', () => {
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

  const confirmReq = { bookingId: 'bk_1', sku: 'seat-A', qty: 2 };

  describe('confirm', () => {
    it('accepts and returns the partner confirmation reference', async () => {
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        idFactory: () => 'conf_1',
      });

      const result = await partner.confirm(confirmReq);

      expect(result).toEqual({ accepted: true, confirmationId: 'conf_1' });
    });

    it('emits a CLIENT span for the external hop, attributed to the partner', async () => {
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        idFactory: () => 'conf_1',
      });

      await partner.confirm(confirmReq);

      const span = exporter.getFinishedSpans().find((s) => s.name === 'supplier confirm');
      expect(span).toBeDefined();
      expect(span!.kind).toBe(SpanKind.CLIENT);
      expect(span!.status.code).toBe(SpanStatusCode.OK);
      expect(span!.attributes).toMatchObject({
        'signalman.supplier.operation': 'confirm',
        'peer.service': 'supplier-simulator',
        'signalman.supplier.booking_id': 'bk_1',
        'signalman.supplier.sku': 'seat-A',
        'signalman.supplier.qty': 2,
        'signalman.supplier.outcome': 'accepted',
        'signalman.supplier.confirmation_id': 'conf_1',
      });
    });

    it('rejects when the reject roll hits, returning a reason and a clean span', async () => {
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        rejectRate: 1,
        random: () => 0,
      });

      const result = await partner.confirm(confirmReq);

      expect(result).toEqual({ accepted: false, rejectionReason: 'no_availability' });
      const span = exporter.getFinishedSpans().find((s) => s.name === 'supplier confirm');
      // A rejection is a successful call with a business "no", not a span error.
      expect(span!.status.code).toBe(SpanStatusCode.OK);
      expect(span!.attributes['signalman.supplier.outcome']).toBe('rejected');
    });

    it('throws and records an errored span when the partner is unavailable', async () => {
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        failureRate: 1,
        random: () => 0,
      });

      await expect(partner.confirm(confirmReq)).rejects.toBeInstanceOf(SupplierUnavailableError);

      const span = exporter.getFinishedSpans().find((s) => s.name === 'supplier confirm');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.attributes['error.type']).toBe('SupplierUnavailableError');
      expect(span!.events.map((e) => e.name)).toContain('exception');
    });

    it('applies the configured latency through the delay seam', async () => {
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        latencyMs: 250,
        idFactory: () => 'c',
      });

      await partner.confirm(confirmReq);

      expect(delays).toEqual([250]);
    });

    it('decides reject/failure independently of each other via the rate rolls', async () => {
      // random() = 0.5: above rejectRate 0.2 (no reject) and failureRate 0.1 (no failure).
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        rejectRate: 0.2,
        failureRate: 0.1,
        random: () => 0.5,
        idFactory: () => 'conf_ok',
      });

      const result = await partner.confirm(confirmReq);

      expect(result).toEqual({ accepted: true, confirmationId: 'conf_ok' });
    });
  });

  describe('cancel', () => {
    it('resolves and spans the hop', async () => {
      const partner = new SimulatedSupplierPartner({ tracer, delay: noopDelay });

      await expect(partner.cancel('conf_1')).resolves.toBeUndefined();
      const span = exporter.getFinishedSpans().find((s) => s.name === 'supplier cancel');
      expect(span!.kind).toBe(SpanKind.CLIENT);
      expect(span!.status.code).toBe(SpanStatusCode.OK);
      expect(span!.attributes['signalman.supplier.confirmation_id']).toBe('conf_1');
    });

    it('throws and records an errored span when the partner is unavailable', async () => {
      const partner = new SimulatedSupplierPartner({
        tracer,
        delay: noopDelay,
        failureRate: 1,
        random: () => 0,
      });

      await expect(partner.cancel('conf_1')).rejects.toBeInstanceOf(SupplierUnavailableError);
      const span = exporter.getFinishedSpans().find((s) => s.name === 'supplier cancel');
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });
});
