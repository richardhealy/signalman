/**
 * The booking saga orchestrator — the coordinating heart of the system.
 *
 * A single {@link BookingSaga.book} call drives the booking forward through five
 * synchronous legs in order:
 *
 *   inventory.hold → payments.authorize → supplier.confirm → payments.capture →
 *   ledger.commit
 *
 * and, the moment a leg refuses (a business rejection) or fails (an outage),
 * unwinds the legs that already succeeded by running their compensations in
 * reverse. Compensations are the inverse commands the leg services expose and
 * are idempotent, so the unwind is safe to retry: release the hold, void the
 * authorization, cancel the partner confirmation.
 *
 * Observability is the point of the project, so the saga makes its shape visible
 * in the trace: every forward step and every compensation runs inside its own
 * span, parented to whatever span is active when `book` is called (in the
 * service that is the gRPC SERVER span the observability interceptor opens around
 * the `Book` handler). A step's span carries the booking id and the step name; a
 * rejection annotates the span with the outcome and reason; an outage marks the
 * span errored; a compensation span is flagged so the unwind is legible at a
 * glance. The cross-service CLIENT spans and `traceparent` propagation that make
 * the legs' own spans join this same trace land with the trace-propagation
 * milestone; here the saga's steps and compensations are already first-class
 * spans.
 *
 * The orchestrator depends only on the four {@link InventoryPort}-style ports, so
 * it is exercised end to end in tests against in-memory fakes; the gRPC client
 * adapters wire the real services in production.
 */
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE, ERROR_TYPE_VALUE_OTHER } from '@opentelemetry/semantic-conventions';
import { getTracer } from '@signalman/otel';
import type { InventoryPort, LedgerPort, PaymentsPort, SupplierPort } from './ports';

/** Instrumentation scope for the saga's step and compensation spans. */
export const SAGA_TRACER_NAME = '@signalman/coordinator';

/** Span attribute: the booking the step belongs to. */
const ATTR_BOOKING_ID = 'signalman.booking.id';
/** Span attribute: the saga step name (e.g. `supplier.confirm`). */
const ATTR_SAGA_STEP = 'signalman.saga.step';
/** Span attribute: marks a span as a compensation rather than a forward step. */
const ATTR_SAGA_COMPENSATION = 'signalman.saga.compensation';
/** Span attribute: a forward step's business outcome when it was not granted. */
const ATTR_SAGA_OUTCOME = 'signalman.saga.outcome';
/** Span attribute: the machine-readable reason a step was rejected. */
const ATTR_SAGA_REASON = 'signalman.saga.reason';

/** What the gateway asks the coordinator to book. */
export interface BookCommand {
  bookingId: string;
  sku: string;
  qty: number;
  /** Amount to take, in the currency's minor units (e.g. cents). */
  amount: number;
  currency: string;
}

/**
 * The outcome of {@link BookingSaga.book}. A discriminated union so callers
 * branch on `booked`: a success carries every leg's truth handle; a failure
 * names the step that stopped the saga, the reason, and whether the completed
 * steps were unwound.
 */
export type BookOutcome =
  | {
      booked: true;
      holdId: string;
      authorizationId: string;
      confirmationId: string;
      captureId: string;
      entryId: string;
    }
  | { booked: false; failedStep: string; reason: string; compensated: boolean };

/** Injectable collaborators for {@link BookingSaga}. */
export interface BookingSagaOptions {
  inventory: InventoryPort;
  payments: PaymentsPort;
  supplier: SupplierPort;
  ledger: LedgerPort;
  /**
   * Tracer the step and compensation spans are opened on; defaults to the global
   * tracer scoped to {@link SAGA_TRACER_NAME}. Override in tests to observe spans.
   */
  tracer?: Tracer;
}

/** Why a step stopped the saga: a business rejection or an outage. */
type StepFailureKind = 'rejected' | 'outage';

/** Carries the failed step's identity up to the single unwind point in `book`. */
class SagaStepError extends Error {
  constructor(
    readonly step: string,
    readonly reason: string,
    readonly kind: StepFailureKind,
    readonly cause?: unknown,
  ) {
    super(`saga step ${step} failed: ${reason}`);
    this.name = 'SagaStepError';
  }
}

/** A recorded compensation: the step's name and the call that undoes it. */
interface Compensation {
  step: string;
  run: () => Promise<unknown>;
}

/** The OTel `error.type` for a thrown value, by its constructor name. */
function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || ERROR_TYPE_VALUE_OTHER;
  }
  return ERROR_TYPE_VALUE_OTHER;
}

export class BookingSaga {
  private readonly inventory: InventoryPort;
  private readonly payments: PaymentsPort;
  private readonly supplier: SupplierPort;
  private readonly ledger: LedgerPort;
  private readonly tracer: Tracer;

  constructor(options: BookingSagaOptions) {
    this.inventory = options.inventory;
    this.payments = options.payments;
    this.supplier = options.supplier;
    this.ledger = options.ledger;
    this.tracer = options.tracer ?? getTracer(SAGA_TRACER_NAME, '0.1.0');
  }

  /**
   * Drive the booking saga to completion or to a fully-unwound failure.
   *
   * Each forward step records its compensation before the next step runs, so a
   * failure unwinds exactly the work that completed. The first step needs no
   * unwind (nothing has happened yet), which is why a `held = false` returns with
   * `compensated: false`. Capture and commit push no compensation in the success
   * path: commit is the final step, so a later step can never strand them — and a
   * commit failure after capture leaves stranded money that the void
   * compensation backs out and the reconciler is the ultimate backstop for.
   */
  async book(command: BookCommand): Promise<BookOutcome> {
    const { bookingId, sku, qty, amount, currency } = command;
    const compensations: Compensation[] = [];

    try {
      const hold = await this.step(
        'inventory.hold',
        bookingId,
        () => this.inventory.hold({ bookingId, sku, qty }),
        (reply) => ({ ok: reply.held, reason: reply.reason || 'hold_rejected' }),
      );
      compensations.push({
        step: 'inventory.release',
        run: () => this.inventory.release({ bookingId }),
      });

      const auth = await this.step(
        'payments.authorize',
        bookingId,
        () => this.payments.authorize({ bookingId, amount, currency }),
        (reply) => ({ ok: reply.authorized, reason: reply.reason || 'authorize_declined' }),
      );
      compensations.push({
        step: 'payments.void',
        run: () => this.payments.voidAuthorization({ bookingId }),
      });

      const confirm = await this.step(
        'supplier.confirm',
        bookingId,
        () => this.supplier.confirm({ bookingId, sku, qty }),
        (reply) => ({ ok: reply.confirmed, reason: reply.reason || 'confirm_rejected' }),
      );
      compensations.push({
        step: 'supplier.cancel',
        run: () => this.supplier.cancel({ bookingId }),
      });

      const capture = await this.step(
        'payments.capture',
        bookingId,
        () => this.payments.capture({ bookingId }),
        (reply) => ({ ok: reply.captured, reason: reply.reason || 'capture_failed' }),
      );

      const commit = await this.step(
        'ledger.commit',
        bookingId,
        () => this.ledger.commit({ bookingId, amount, currency, captureId: capture.captureId }),
        (reply) => ({ ok: reply.committed, reason: reply.reason || 'commit_rejected' }),
      );

      return {
        booked: true,
        holdId: hold.holdId,
        authorizationId: auth.authorizationId,
        confirmationId: confirm.confirmationId,
        captureId: capture.captureId,
        entryId: commit.entryId,
      };
    } catch (error) {
      if (!(error instanceof SagaStepError)) {
        // An unexpected programmer error, not a saga step outcome — surface it.
        throw error;
      }
      const compensated = await this.unwind(bookingId, compensations);
      return { booked: false, failedStep: error.step, reason: error.reason, compensated };
    }
  }

  /**
   * Run one forward leg inside its own span.
   *
   * The call runs with the step's span active so the leg's eventual CLIENT span
   * (once propagation is wired) joins the trace. An outage marks the span errored
   * and is re-raised as a {@link SagaStepError}; a business rejection — the leg
   * answering "no" as data — annotates the span with the outcome and reason and is
   * likewise raised, so both funnel to the single unwind point in {@link book}.
   */
  private async step<T>(
    step: string,
    bookingId: string,
    call: () => Promise<T>,
    classify: (reply: T) => { ok: boolean; reason: string },
  ): Promise<T> {
    const span = this.tracer.startSpan(step, {
      kind: SpanKind.INTERNAL,
      attributes: { [ATTR_BOOKING_ID]: bookingId, [ATTR_SAGA_STEP]: step },
    });
    const active = trace.setSpan(otelContext.active(), span);

    let reply: T;
    try {
      reply = await otelContext.with(active, call);
    } catch (error) {
      this.markError(span, error);
      span.end();
      throw new SagaStepError(step, errorType(error), 'outage', error);
    }

    const verdict = classify(reply);
    if (!verdict.ok) {
      span.setAttribute(ATTR_SAGA_OUTCOME, 'rejected');
      span.setAttribute(ATTR_SAGA_REASON, verdict.reason);
      span.end();
      throw new SagaStepError(step, verdict.reason, 'rejected');
    }

    span.end();
    return reply;
  }

  /**
   * Unwind the completed steps in reverse. Returns whether any compensation ran,
   * which the failure outcome reports as `compensated`.
   */
  private async unwind(bookingId: string, compensations: Compensation[]): Promise<boolean> {
    if (compensations.length === 0) {
      return false;
    }
    for (const compensation of [...compensations].reverse()) {
      await this.compensate(bookingId, compensation);
    }
    return true;
  }

  /**
   * Run one compensation inside its own (compensation-flagged) span. The unwind
   * is best-effort: a compensation that throws is recorded on its span and the
   * remaining compensations still run, because the compensations are idempotent
   * and a partial unwind should not abandon the rest of the cleanup.
   */
  private async compensate(bookingId: string, compensation: Compensation): Promise<void> {
    const span = this.tracer.startSpan(compensation.step, {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_BOOKING_ID]: bookingId,
        [ATTR_SAGA_STEP]: compensation.step,
        [ATTR_SAGA_COMPENSATION]: true,
      },
    });
    const active = trace.setSpan(otelContext.active(), span);
    try {
      await otelContext.with(active, compensation.run);
    } catch (error) {
      this.markError(span, error);
    } finally {
      span.end();
    }
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
