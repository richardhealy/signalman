/**
 * The reconciler application service — the spec's payoff made operational.
 *
 * One {@link ReconcilerService.runOnce} call is a reconciliation pass: it pulls
 * every settled booking from the {@link SourceOfTruthGateway}, compares each
 * across its sources of truth with the pure {@link detectDivergences} engine, and
 * records any new divergence as a {@link DivergenceFinding}. Findings are
 * idempotent per `(bookingId, kind)`, so a recurring drift is recorded once, not
 * once per pass.
 *
 * Observability is the point, so each finding is **linked back to the booking
 * trace**. The pass runs under a `reconcile.pass` span; every new finding opens a
 * `reconcile.divergence` span that carries a **span link** to the originating
 * booking's trace context (lifted from the snapshot). That link is the handle the
 * spec calls for — from a divergence finding you jump straight to the trace that
 * explains how the booking got there, even though the reconciler runs out-of-band
 * on its own trace rather than the booking's. It is the same span-link mechanism
 * fan-out consumers use, applied to after-the-fact reconciliation.
 *
 * The service depends only on the gateway and repository seams, so it is unit
 * tested end to end against in-memory fakes; the broker/Postgres-backed
 * implementations swap in behind the same interfaces.
 */
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  trace,
  type Link,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { getTracer } from '@signalman/otel';
import { extractContext } from '@signalman/propagation';
import { randomUUID } from 'node:crypto';
import { type BookingSnapshot } from './booking-snapshot';
import { type DivergenceFinding } from './finding';
import { type DivergenceFindingRepository } from './finding-repository';
import { detectDivergences, type Divergence } from './reconciliation';
import { type SourceOfTruthGateway } from './source-gateway';

/** Instrumentation scope for the reconciler's pass and divergence spans. */
export const RECONCILER_TRACER_NAME = '@signalman/reconciler';

/** Span attribute: the booking a finding is about. */
const ATTR_BOOKING_ID = 'signalman.booking.id';
/** Span attribute: the divergence kind. */
const ATTR_DIVERGENCE_KIND = 'signalman.reconciler.divergence.kind';
/** Span attribute: the divergence severity. */
const ATTR_DIVERGENCE_SEVERITY = 'signalman.reconciler.divergence.severity';
/** Span attributes: the observed cross-source state that triggered the finding. */
const ATTR_OBSERVED_INVENTORY = 'signalman.reconciler.observed.inventory';
const ATTR_OBSERVED_SUPPLIER = 'signalman.reconciler.observed.supplier';
const ATTR_OBSERVED_LEDGER = 'signalman.reconciler.observed.ledger';
/** Span attributes: per-pass counters. */
const ATTR_PASS_BOOKINGS = 'signalman.reconciler.bookings_scanned';
const ATTR_PASS_DIVERGENCES = 'signalman.reconciler.divergences_found';
const ATTR_PASS_FINDINGS_NEW = 'signalman.reconciler.findings_created';

/** The outcome of a reconciliation pass. */
export interface ReconcileReport {
  /** How many settled bookings the pass examined. */
  bookingsScanned: number;
  /** How many divergences were detected across all bookings (new and already-known). */
  divergencesFound: number;
  /** The findings newly recorded this pass (excludes divergences already on file). */
  findingsCreated: DivergenceFinding[];
  /** How many detected divergences were already on file and so not re-recorded. */
  alreadyKnown: number;
}

/** Injectable collaborators and seams for {@link ReconcilerService}. */
export interface ReconcilerServiceOptions {
  gateway: SourceOfTruthGateway;
  findings: DivergenceFindingRepository;
  /** Tracer for the pass and divergence spans; defaults to the `@signalman/reconciler` tracer. */
  tracer?: Tracer;
  /** Finding-id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for `detectedAt`; defaults to `() => new Date()`. */
  clock?: () => Date;
}

/** The OTel `error.type` for a thrown value, by its constructor name. */
function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || 'Error';
  }
  return 'Error';
}

export class ReconcilerService {
  private readonly gateway: SourceOfTruthGateway;
  private readonly findings: DivergenceFindingRepository;
  private readonly tracer: Tracer;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(options: ReconcilerServiceOptions) {
    this.gateway = options.gateway;
    this.findings = options.findings;
    this.tracer = options.tracer ?? getTracer(RECONCILER_TRACER_NAME, '0.1.0');
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Run one reconciliation pass over every settled booking.
   *
   * For each booking the divergence engine runs; each *new* divergence is
   * recorded as a finding and gets its own `reconcile.divergence` span linked to
   * the booking trace. Divergences already on file are counted but not
   * re-recorded, so the pass is safe to run on any cadence. The whole pass runs
   * under a `reconcile.pass` span carrying the counters.
   *
   * @returns a {@link ReconcileReport} summarising the pass.
   */
  async runOnce(): Promise<ReconcileReport> {
    return this.tracer.startActiveSpan(
      'reconcile.pass',
      { kind: SpanKind.INTERNAL },
      async (passSpan) => {
        try {
          const snapshots = await this.gateway.collectSettled();
          const findingsCreated: DivergenceFinding[] = [];
          let divergencesFound = 0;
          let alreadyKnown = 0;

          for (const snapshot of snapshots) {
            const divergences = detectDivergences(snapshot);
            divergencesFound += divergences.length;
            if (divergences.length === 0) {
              continue;
            }
            const link = this.bookingLink(snapshot);
            for (const divergence of divergences) {
              const isKnown = await this.findings.has({
                bookingId: snapshot.bookingId,
                kind: divergence.kind,
              });
              if (isKnown) {
                alreadyKnown += 1;
                continue;
              }
              const finding = this.toFinding(snapshot, divergence, link?.context.traceId);
              this.recordFindingSpan(finding, link);
              await this.findings.save(finding);
              findingsCreated.push(finding);
            }
          }

          passSpan.setAttribute(ATTR_PASS_BOOKINGS, snapshots.length);
          passSpan.setAttribute(ATTR_PASS_DIVERGENCES, divergencesFound);
          passSpan.setAttribute(ATTR_PASS_FINDINGS_NEW, findingsCreated.length);
          passSpan.setStatus({ code: SpanStatusCode.OK });

          return { bookingsScanned: snapshots.length, divergencesFound, findingsCreated, alreadyKnown };
        } catch (error) {
          this.markError(passSpan, error);
          throw error;
        } finally {
          passSpan.end();
        }
      },
    );
  }

  /**
   * Derive a span {@link Link} to the booking's originating trace from the
   * snapshot's captured `traceparent`. Returns `undefined` when no usable trace
   * context is present, so a finding without lineage still records cleanly (just
   * without the back-link).
   */
  private bookingLink(snapshot: BookingSnapshot): Link | undefined {
    if (!snapshot.trace) {
      return undefined;
    }
    const spanContext = trace.getSpanContext(extractContext(snapshot.trace, ROOT_CONTEXT));
    if (!spanContext || !isSpanContextValid(spanContext)) {
      return undefined;
    }
    return { context: spanContext };
  }

  /** Build a persisted finding from a detected divergence and its booking trace id. */
  private toFinding(
    snapshot: BookingSnapshot,
    divergence: Divergence,
    traceId: string | undefined,
  ): DivergenceFinding {
    return {
      id: this.idFactory(),
      bookingId: snapshot.bookingId,
      kind: divergence.kind,
      severity: divergence.severity,
      detail: divergence.detail,
      observed: divergence.observed,
      ...(traceId !== undefined ? { traceId } : {}),
      detectedAt: this.clock(),
    };
  }

  /**
   * Open (and immediately end) the finding's `reconcile.divergence` span: an
   * INTERNAL span nested under the active pass span, **linked** to the booking
   * trace so the finding is navigable back to its origin, and carrying the
   * divergence attributes and detail.
   */
  private recordFindingSpan(finding: DivergenceFinding, link: Link | undefined): void {
    const span = this.tracer.startSpan('reconcile.divergence', {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_BOOKING_ID]: finding.bookingId,
        [ATTR_DIVERGENCE_KIND]: finding.kind,
        [ATTR_DIVERGENCE_SEVERITY]: finding.severity,
        [ATTR_OBSERVED_INVENTORY]: finding.observed.inventory,
        [ATTR_OBSERVED_SUPPLIER]: finding.observed.supplier,
        [ATTR_OBSERVED_LEDGER]: finding.observed.ledger,
      },
      links: link ? [link] : [],
    });
    span.addEvent('reconciler.divergence.detected', {
      'signalman.reconciler.detail': finding.detail,
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  /** Record a thrown value on a span: exception, ERROR status, and `error.type`. */
  private markError(span: Span, error: unknown): void {
    span.recordException(error instanceof Error ? error : { message: String(error) });
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.setAttribute(ATTR_ERROR_TYPE, errorType(error));
  }
}
