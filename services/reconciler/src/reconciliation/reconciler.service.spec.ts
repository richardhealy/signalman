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
import { InMemoryDivergenceFindingRepository } from './finding-repository';
import { ReconcilerService } from './reconciler.service';
import { InMemorySourceOfTruthGateway, type SourceOfTruthGateway } from './source-gateway';

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

function makeService(
  opts: { gateway?: SourceOfTruthGateway; tracer?: Tracer } = {},
): {
  service: ReconcilerService;
  gateway: InMemorySourceOfTruthGateway;
  findings: InMemoryDivergenceFindingRepository;
} {
  const gateway = (opts.gateway as InMemorySourceOfTruthGateway) ?? new InMemorySourceOfTruthGateway();
  const findings = new InMemoryDivergenceFindingRepository();
  let seq = 0;
  const service = new ReconcilerService({
    gateway,
    findings,
    tracer: opts.tracer,
    idFactory: () => `fnd_${++seq}`,
    clock: () => new Date('2026-06-29T00:00:00Z'),
  });
  return { service, gateway, findings };
}

describe('ReconcilerService', () => {
  describe('runOnce', () => {
    it('detects a supplier-confirmed/ledger-missing divergence and records a finding', async () => {
      const { service, gateway, findings } = makeService();
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_1', 'confirmed');
      // ledger never recorded → absent

      const report = await service.runOnce();

      expect(report).toMatchObject({
        bookingsScanned: 1,
        divergencesFound: 1,
        alreadyKnown: 0,
      });
      expect(report.findingsCreated).toHaveLength(1);
      expect(report.findingsCreated[0]).toMatchObject({
        id: 'fnd_1',
        bookingId: 'bk_1',
        kind: 'supplier_confirmed_ledger_missing',
        severity: 'critical',
        observed: { inventory: 'held', supplier: 'confirmed', ledger: 'absent' },
        detectedAt: new Date('2026-06-29T00:00:00Z'),
      });
      await expect(findings.findByBooking('bk_1')).resolves.toHaveLength(1);
    });

    it('records nothing for a consistent booking', async () => {
      const { service, gateway, findings } = makeService();
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_1', 'confirmed');
      gateway.recordLedger('bk_1', 'committed');

      const report = await service.runOnce();

      expect(report).toMatchObject({ bookingsScanned: 1, divergencesFound: 0, alreadyKnown: 0 });
      expect(report.findingsCreated).toHaveLength(0);
      await expect(findings.findByBooking('bk_1')).resolves.toHaveLength(0);
    });

    it('is idempotent across passes: a standing divergence is recorded once', async () => {
      const { service, gateway, findings } = makeService();
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_1', 'cancelled');
      gateway.recordLedger('bk_1', 'reversed'); // orphaned hold

      const first = await service.runOnce();
      const second = await service.runOnce();

      expect(first.findingsCreated).toHaveLength(1);
      expect(second).toMatchObject({
        bookingsScanned: 1,
        divergencesFound: 1, // still detected…
        alreadyKnown: 1, // …but recognised as already on file
      });
      expect(second.findingsCreated).toHaveLength(0); // …and not re-recorded
      await expect(findings.findByBooking('bk_1')).resolves.toHaveLength(1);
    });

    it('reconciles several bookings in one pass', async () => {
      const { service, gateway } = makeService();
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_1', 'confirmed'); // supplier_confirmed_ledger_missing
      gateway.recordSupplier('bk_2', 'cancelled');
      gateway.recordLedger('bk_2', 'committed'); // ledger_committed_supplier_unconfirmed
      gateway.recordInventory('bk_3', 'held');
      gateway.recordSupplier('bk_3', 'confirmed');
      gateway.recordLedger('bk_3', 'committed'); // consistent

      const report = await service.runOnce();

      expect(report.bookingsScanned).toBe(3);
      expect(report.findingsCreated.map((f) => f.kind).sort()).toEqual([
        'ledger_committed_supplier_unconfirmed',
        'supplier_confirmed_ledger_missing',
      ]);
    });
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

    /** Headers carrying a booking event's publish-span context, as a source would have captured them. */
    function bookingTrace(): { headers: BrokerHeaders; traceId: string } {
      const publishSpan = tracer.startSpan('publish ledger.committed', { kind: SpanKind.PRODUCER });
      const headers = injectContext(trace.setSpan(otelContext.active(), publishSpan), {});
      const traceId = publishSpan.spanContext().traceId;
      publishSpan.end();
      return { headers, traceId };
    }

    it('runs the pass under a reconcile.pass span carrying the counters', async () => {
      const { service, gateway } = makeService({ tracer });
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_1', 'confirmed');

      await service.runOnce();

      const passSpan = exporter.getFinishedSpans().find((s) => s.name === 'reconcile.pass');
      expect(passSpan).toBeDefined();
      expect(passSpan!.kind).toBe(SpanKind.INTERNAL);
      expect(passSpan!.status.code).toBe(SpanStatusCode.OK);
      expect(passSpan!.attributes).toMatchObject({
        'signalman.reconciler.bookings_scanned': 1,
        'signalman.reconciler.divergences_found': 1,
        'signalman.reconciler.findings_created': 1,
      });
    });

    it('links each finding span back to the originating booking trace and stamps the trace id', async () => {
      const { headers, traceId } = bookingTrace();
      const { service, gateway } = makeService({ tracer });
      gateway.recordInventory('bk_1', 'held', { trace: headers });
      gateway.recordSupplier('bk_1', 'confirmed');

      const report = await service.runOnce();

      const spans = exporter.getFinishedSpans();
      const passSpan = spans.find((s) => s.name === 'reconcile.pass')!;
      const divergenceSpan = spans.find((s) => s.name === 'reconcile.divergence');

      expect(divergenceSpan).toBeDefined();
      expect(divergenceSpan!.kind).toBe(SpanKind.INTERNAL);
      // The finding span sits on the reconciler's OWN trace, nested under the pass…
      expect(divergenceSpan!.spanContext().traceId).toBe(passSpan.spanContext().traceId);
      expect(parentSpanId(divergenceSpan!)).toBe(passSpan.spanContext().spanId);
      // …and carries a span link to the booking's trace — the back-reference the spec calls for.
      expect(divergenceSpan!.links).toHaveLength(1);
      expect(divergenceSpan!.links[0]!.context.traceId).toBe(traceId);
      expect(divergenceSpan!.attributes).toMatchObject({
        'signalman.booking.id': 'bk_1',
        'signalman.reconciler.divergence.kind': 'supplier_confirmed_ledger_missing',
        'signalman.reconciler.divergence.severity': 'critical',
        'signalman.reconciler.observed.inventory': 'held',
        'signalman.reconciler.observed.supplier': 'confirmed',
        'signalman.reconciler.observed.ledger': 'absent',
      });

      // The finding record carries the same trace id, so it links back even off-trace.
      expect(report.findingsCreated[0]!.traceId).toBe(traceId);
    });

    it('records a finding with no trace id and no link when the snapshot has no trace context', async () => {
      const { service, gateway } = makeService({ tracer });
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_1', 'confirmed');

      const report = await service.runOnce();

      const divergenceSpan = exporter.getFinishedSpans().find((s) => s.name === 'reconcile.divergence');
      expect(divergenceSpan!.links).toHaveLength(0);
      expect(report.findingsCreated[0]!.traceId).toBeUndefined();
    });

    it('marks the pass span errored and rethrows when the gateway fails', async () => {
      const failing: SourceOfTruthGateway = {
        collectSettled: () => Promise.reject(new Error('gateway down')),
      };
      const { service } = makeService({ gateway: failing, tracer });

      await expect(service.runOnce()).rejects.toThrow('gateway down');

      const passSpan = exporter.getFinishedSpans().find((s) => s.name === 'reconcile.pass');
      expect(passSpan!.status.code).toBe(SpanStatusCode.ERROR);
      expect(passSpan!.attributes['error.type']).toBe('Error');
    });
  });
});
