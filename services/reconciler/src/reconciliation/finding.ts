/**
 * The reconciler's source of truth: a **divergence finding** — a recorded
 * disagreement between the sources of truth for one booking.
 *
 * Where the other services own a slice of the booking's truth, the reconciler
 * owns the record of where those slices *stopped agreeing*. A finding names the
 * kind of drift, how serious it is, the exact cross-source state that triggered
 * it, and — crucially — the originating booking trace, so an operator can jump
 * from the finding straight to the trace that explains it. Findings are
 * idempotent per `(bookingId, kind)`: re-running the reconciler over a booking
 * that is still diverged the same way does not pile up duplicate findings.
 */
import { type ObservedStates } from './booking-snapshot';

/**
 * The kinds of divergence the reconciler detects between the sources of truth.
 *
 * - `supplier_confirmed_ledger_missing` — the partner confirmed the booking but
 *   no committed financial record exists for it. The spec's headline case: a
 *   booking the supplier is on the hook for that our ledger thinks never happened.
 * - `ledger_committed_supplier_unconfirmed` — the mirror image: money is posted
 *   for a booking the supplier is not holding (cancelled, or never confirmed).
 * - `orphaned_hold` — inventory is still held for a booking that did not
 *   complete; the hold was never released.
 */
export type DivergenceKind =
  | 'supplier_confirmed_ledger_missing'
  | 'ledger_committed_supplier_unconfirmed'
  | 'orphaned_hold';

/**
 * How urgently a divergence needs attention.
 *
 * - `critical` — the financial sources of truth disagree (money vs. partner
 *   commitment); someone is owed a reconciliation that costs real money.
 * - `warning`  — stranded operational state (an unreleased hold) that ties up
 *   inventory but does not by itself imply a financial loss.
 */
export type DivergenceSeverity = 'critical' | 'warning';

/**
 * A recorded divergence for a booking.
 *
 * Immutable in shape, mirroring a transactional row insert and keeping the
 * in-memory repository honest about what Postgres would do. The pairing
 * `(bookingId, kind)` is the identity the reconciler dedups on.
 */
export interface DivergenceFinding {
  /** Stable unique id for the finding record. */
  readonly id: string;
  /** The booking the divergence is about. */
  readonly bookingId: string;
  /** Which invariant the booking broke. */
  readonly kind: DivergenceKind;
  /** How urgently it needs attention. */
  readonly severity: DivergenceSeverity;
  /** Human-readable explanation of the disagreement. */
  readonly detail: string;
  /** The cross-source state that triggered the finding — the evidence. */
  readonly observed: ObservedStates;
  /**
   * The originating booking trace id, lifted from the snapshot's trace context.
   * Absent when no source recorded a trace context. This is the handle that
   * links the finding back to the trace that explains it.
   */
  readonly traceId?: string;
  /** When the reconciler detected the divergence. */
  readonly detectedAt: Date;
}
