/**
 * The supplier partner boundary — the external source of truth the supplier
 * service wraps.
 *
 * The partner is deliberately outside our transactional reach: it confirms and
 * cancels bookings, and only it knows whether those really happened. That gap is
 * exactly where divergence is born (the spec's central concern), and the spec
 * calls the partner out as *deliberately slow and flaky*, so v1 ships a
 * {@link SimulatedSupplierPartner} with controllable latency and failure
 * injection in place of a real partner. Every call is wrapped in a CLIENT span —
 * the external hop made visible in the booking trace — so a slow or failing
 * partner shows up where you would look for it.
 */
import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { getTracer } from '@signalman/otel';
import { randomUUID } from 'node:crypto';

/** A request to confirm a booking with the partner. */
export interface SupplierConfirmRequest {
  bookingId: string;
  /** The stock-keeping unit being confirmed. */
  sku: string;
  /** How many units to confirm. */
  qty: number;
}

/**
 * The partner's verdict on a confirmation. A discriminated union: an acceptance
 * carries the partner's confirmation reference, a rejection a machine-readable
 * reason. A rejection is a *successful* call with a business "no" — distinct from
 * the partner being unreachable, which throws {@link SupplierUnavailableError}.
 */
export type SupplierConfirmResult =
  | { accepted: true; confirmationId: string }
  | { accepted: false; rejectionReason: string };

/** The external partner boundary the supplier service calls. */
export interface SupplierPartner {
  /** Confirm a booking; resolves with the partner's verdict, or throws if unreachable. */
  confirm(request: SupplierConfirmRequest): Promise<SupplierConfirmResult>;
  /** Cancel (release) a previously obtained confirmation by its reference. */
  cancel(confirmationId: string): Promise<void>;
}

/**
 * A technical failure of the partner boundary — the partner was unreachable or
 * timed out. Distinct from a rejection (a successful call with a business "no"):
 * an unavailable partner propagates so the saga can retry and the trace shows an
 * errored external hop, where the rejection is returned as data.
 */
export class SupplierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierUnavailableError';
  }
}

/** The `peer.service` the simulated partner spans attribute their hop to. */
export const SUPPLIER_PEER_SERVICE = 'supplier-simulator';

const ATTR_SUPPLIER_OPERATION = 'signalman.supplier.operation';
const ATTR_SUPPLIER_OUTCOME = 'signalman.supplier.outcome';
const ATTR_SUPPLIER_CONFIRMATION_ID = 'signalman.supplier.confirmation_id';
const ATTR_PEER_SERVICE = 'peer.service';

/** Construction options for {@link SimulatedSupplierPartner}. */
export interface SimulatedSupplierPartnerOptions {
  /** Simulated round-trip latency per call, in ms. Defaults to `0`. */
  latencyMs?: number;
  /** Fraction of confirmations (0–1) the partner rejects. Defaults to `0`. */
  rejectRate?: number;
  /** Fraction of calls (0–1) that fail outright (unreachable/timeout). Defaults to `0`. */
  failureRate?: number;
  /** RNG seam for reject/failure rolls; defaults to {@link Math.random}. Inject for deterministic tests. */
  random?: () => number;
  /** Sleep seam for simulated latency; defaults to a real `setTimeout`. Inject `() => Promise.resolve()` in tests. */
  delay?: (ms: number) => Promise<void>;
  /** Reference-id generator (confirmation ids); defaults to {@link randomUUID}. */
  idFactory?: () => string;
  /** Tracer for the external-hop spans; defaults to the `@signalman/supplier` tracer. */
  tracer?: Tracer;
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake partner standing in for a real supplier until one is integrated. It
 * models the two things a real boundary forces you to reckon with — it is slow,
 * and it fails — under deterministic control, and emits the same CLIENT spans a
 * real client would, so the rest of the system (and its traces) are exercised
 * exactly as they will be in production.
 */
export class SimulatedSupplierPartner implements SupplierPartner {
  private readonly latencyMs: number;
  private readonly rejectRate: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly tracer: Tracer;

  constructor(options: SimulatedSupplierPartnerOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.rejectRate = options.rejectRate ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? Math.random;
    this.delay = options.delay ?? realDelay;
    this.idFactory = options.idFactory ?? randomUUID;
    this.tracer = options.tracer ?? getTracer('@signalman/supplier');
  }

  async confirm(request: SupplierConfirmRequest): Promise<SupplierConfirmResult> {
    return this.call(
      'confirm',
      {
        'signalman.supplier.booking_id': request.bookingId,
        'signalman.supplier.sku': request.sku,
        'signalman.supplier.qty': request.qty,
      },
      async (span) => {
        if (this.roll(this.failureRate)) {
          throw new SupplierUnavailableError('supplier confirm timed out');
        }
        if (this.roll(this.rejectRate)) {
          span.setAttribute(ATTR_SUPPLIER_OUTCOME, 'rejected');
          return { accepted: false, rejectionReason: 'no_availability' };
        }
        const confirmationId = this.idFactory();
        span.setAttribute(ATTR_SUPPLIER_OUTCOME, 'accepted');
        span.setAttribute(ATTR_SUPPLIER_CONFIRMATION_ID, confirmationId);
        return { accepted: true, confirmationId };
      },
    );
  }

  async cancel(confirmationId: string): Promise<void> {
    await this.call(
      'cancel',
      { [ATTR_SUPPLIER_CONFIRMATION_ID]: confirmationId },
      async () => {
        if (this.roll(this.failureRate)) {
          throw new SupplierUnavailableError('supplier cancel timed out');
        }
      },
    );
  }

  /** True with probability `rate` (clamped to [0, 1]); the failure/reject coin. */
  private roll(rate: number): boolean {
    return rate > 0 && this.random() < rate;
  }

  /**
   * Run a partner operation inside a CLIENT span: apply the simulated latency,
   * invoke the body, and translate its outcome onto the span. A returned value
   * (acceptance or rejection) is an OK span; a thrown
   * {@link SupplierUnavailableError} is recorded as an errored span and rethrown
   * — the external hop is observable either way.
   */
  private call<T>(
    operation: string,
    attributes: Attributes,
    body: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `supplier ${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [ATTR_SUPPLIER_OPERATION]: operation,
          [ATTR_PEER_SERVICE]: SUPPLIER_PEER_SERVICE,
          ...attributes,
        },
      },
      async (span) => {
        try {
          if (this.latencyMs > 0) {
            await this.delay(this.latencyMs);
          }
          const result = await body(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          span.recordException(error instanceof Error ? error : { message });
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          span.setAttribute(ATTR_ERROR_TYPE, error instanceof Error ? error.name : 'Error');
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
