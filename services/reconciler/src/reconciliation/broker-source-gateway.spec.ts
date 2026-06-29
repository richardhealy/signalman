import {
  SpanKind,
  context as otelContext,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { InMemoryBroker, type BrokerMessage } from '@signalman/broker';
import { injectContext, type BrokerHeaders } from '@signalman/propagation';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';

/** Read the parent span id, compatible with OTel SDK 2.x and 1.x. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

function msg(
  id: string,
  subject: string,
  bookingId: string,
  headers: BrokerHeaders = {},
): BrokerMessage {
  return { id, subject, payload: { bookingId }, headers };
}

describe('BrokerSourceOfTruthGateway', () => {
  describe('projection building', () => {
    it('projects inventory.held correctly', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.drain();

      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', inventory: 'held', supplier: 'absent', ledger: 'absent' });
    });

    it('projects inventory.released correctly', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.released', 'bk_1'));
      await broker.drain();

      const [snap] = await gateway.collectSettled();
      expect(snap!.inventory).toBe('released');
    });

    it('projects supplier.confirmed and supplier.cancelled', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'supplier.confirmed', 'bk_1'));
      await broker.drain();
      let [snap] = await gateway.collectSettled();
      expect(snap!.supplier).toBe('confirmed');

      await broker.publish(msg('m2', 'supplier.cancelled', 'bk_1'));
      await broker.drain();
      [snap] = await gateway.collectSettled();
      expect(snap!.supplier).toBe('cancelled');
    });

    it('projects ledger.committed and ledger.reversed', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'ledger.committed', 'bk_1'));
      await broker.drain();
      let [snap] = await gateway.collectSettled();
      expect(snap!.ledger).toBe('committed');

      await broker.publish(msg('m2', 'ledger.reversed', 'bk_1'));
      await broker.drain();
      [snap] = await gateway.collectSettled();
      expect(snap!.ledger).toBe('reversed');
    });

    it('assembles a full cross-source snapshot', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.publish(msg('m2', 'supplier.confirmed', 'bk_1'));
      await broker.publish(msg('m3', 'ledger.committed', 'bk_1'));
      await broker.drain();

      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({
        bookingId: 'bk_1',
        inventory: 'held',
        supplier: 'confirmed',
        ledger: 'committed',
      });
    });

    it('tracks multiple bookings independently', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.publish(msg('m2', 'supplier.confirmed', 'bk_2'));
      await broker.drain();

      const snaps = await gateway.collectSettled();
      expect(snaps).toHaveLength(2);
      const byId = Object.fromEntries(snaps.map((s) => [s.bookingId, s]));
      expect(byId['bk_1']!.inventory).toBe('held');
      expect(byId['bk_2']!.supplier).toBe('confirmed');
    });

    it('silently skips messages with no bookingId in payload', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish({ id: 'm1', subject: 'inventory.held', payload: { sku: 'SKU-1' }, headers: {} });
      await broker.drain();

      expect(await gateway.collectSettled()).toHaveLength(0);
    });
  });

  describe('settle-grace window', () => {
    it('excludes bookings whose last event is within the grace window', async () => {
      const now = new Date('2026-06-29T10:00:00.000Z');
      const clock = { value: now };
      const gateway = new BrokerSourceOfTruthGateway({
        settleGraceMs: 5_000,
        clock: () => clock.value,
      });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.drain();

      // Still within grace window — not returned
      expect(await gateway.collectSettled()).toHaveLength(0);
    });

    it('includes bookings once the grace window has passed', async () => {
      const now = new Date('2026-06-29T10:00:00.000Z');
      const clock = { value: now };
      const gateway = new BrokerSourceOfTruthGateway({
        settleGraceMs: 5_000,
        clock: () => clock.value,
      });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.drain();

      // Advance clock past grace window
      clock.value = new Date(now.getTime() + 6_000);

      const snaps = await gateway.collectSettled();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]!.bookingId).toBe('bk_1');
    });

    it('resets the grace window on each new event (active sagas stay out)', async () => {
      const now = new Date('2026-06-29T10:00:00.000Z');
      const clock = { value: now };
      const gateway = new BrokerSourceOfTruthGateway({
        settleGraceMs: 5_000,
        clock: () => clock.value,
      });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      // First event at t=0
      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.drain();

      // Advance to t=4s and send a second event (resets observedAt)
      clock.value = new Date(now.getTime() + 4_000);
      await broker.publish(msg('m2', 'ledger.committed', 'bk_1'));
      await broker.drain();

      // At t=8s: second event was 4s ago, still within grace
      clock.value = new Date(now.getTime() + 8_000);
      expect(await gateway.collectSettled()).toHaveLength(0);

      // At t=10s: second event was 6s ago, past grace
      clock.value = new Date(now.getTime() + 10_000);
      expect(await gateway.collectSettled()).toHaveLength(1);
    });
  });

  describe('trace context', () => {
    it('captures the first trace context seen for a booking', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1', { traceparent: 'first' }));
      await broker.publish(msg('m2', 'ledger.committed', 'bk_1', { traceparent: 'second' }));
      await broker.drain();

      const [snap] = await gateway.collectSettled();
      expect(snap!.trace).toEqual({ traceparent: 'first' });
    });

    it('carries observedAt on the snapshot', async () => {
      const now = new Date('2026-06-29T10:00:00.000Z');
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock: () => now });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.drain();

      const [snap] = await gateway.collectSettled();
      expect(snap!.observedAt).toEqual(now);
    });
  });

  describe('fan-out span links', () => {
    let contextManager: AsyncLocalStorageContextManager;
    let provider: BasicTracerProvider;
    let exporter: InMemorySpanExporter;

    beforeEach(() => {
      contextManager = new AsyncLocalStorageContextManager();
      contextManager.enable();
      otelContext.setGlobalContextManager(contextManager);
      exporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    });

    afterEach(async () => {
      contextManager.disable();
      otelContext.disable();
      await provider.shutdown();
      exporter.reset();
    });

    it('emits a CONSUMER span for each consumed event', async () => {
      const gateway = new BrokerSourceOfTruthGateway({
        settleGraceMs: 0,
        tracer: provider.getTracer('test'),
      });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.drain();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.kind).toBe(SpanKind.CONSUMER);
      expect(spans[0]!.name).toBe('project inventory.held');
    });

    it('links the CONSUMER span to the producer trace (fan-out — not child)', async () => {
      const tracer = provider.getTracer('test');
      const gateway = new BrokerSourceOfTruthGateway({
        settleGraceMs: 0,
        tracer,
      });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      // Create a producer span and inject its context into the headers
      const producerSpan = tracer.startSpan('producer');
      const producerCtx = trace.setSpan(otelContext.active(), producerSpan);
      const headers = injectContext(producerCtx, {});
      producerSpan.end();

      await broker.publish({ id: 'm1', subject: 'inventory.held', payload: { bookingId: 'bk_1' }, headers });
      await broker.drain();

      const consumerSpan = exporter
        .getFinishedSpans()
        .find((s) => s.kind === SpanKind.CONSUMER);
      expect(consumerSpan).toBeDefined();

      // The consumer span carries a span link to the producer's span
      expect(consumerSpan!.links).toHaveLength(1);
      const link = consumerSpan!.links[0]!;
      expect(link.context.traceId).toBe(producerSpan.spanContext().traceId);
      expect(link.context.spanId).toBe(producerSpan.spanContext().spanId);

      // The consumer span is NOT a child of the producer (fan-out, not pipeline)
      expect(parentSpanId(consumerSpan!)).not.toBe(producerSpan.spanContext().spanId);
    });

    it('emits spans for all three event types', async () => {
      const gateway = new BrokerSourceOfTruthGateway({
        settleGraceMs: 0,
        tracer: provider.getTracer('test'),
      });
      const broker = new InMemoryBroker();
      for (const sub of gateway.subscriptions()) broker.subscribe(sub.subjects, sub.handler);

      await broker.publish(msg('m1', 'inventory.held', 'bk_1'));
      await broker.publish(msg('m2', 'supplier.confirmed', 'bk_1'));
      await broker.publish(msg('m3', 'ledger.committed', 'bk_1'));
      await broker.drain();

      const names = exporter.getFinishedSpans().map((s) => s.name);
      expect(names).toContain('project inventory.held');
      expect(names).toContain('project supplier.confirmed');
      expect(names).toContain('project ledger.committed');
    });
  });
});
