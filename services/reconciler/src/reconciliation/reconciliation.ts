/**
 * The reconciliation engine — the pure comparison at the heart of the reconciler.
 *
 * Given one booking's {@link BookingSnapshot}, it returns the divergences the
 * sources of truth exhibit. It is a deterministic function of its input — no
 * clock, no I/O, no spans — so the invariant logic can be exhaustively unit
 * tested in isolation; the {@link ReconcilerService} layers persistence, ids, and
 * trace-linked spans on top.
 *
 * The invariants encode what a *settled* booking must look like for the three
 * sources to agree. A consistent booking is one of exactly two shapes:
 *
 * - **completed** — `supplier = confirmed`, `ledger = committed` (the hold may
 *   stand or have been released; either is consistent for a booked reservation); or
 * - **unwound** — neither the supplier confirmed nor the ledger committed, and no
 *   hold stands (everything either compensated or never recorded).
 *
 * Anything else is drift. Note the engine assumes the snapshot is *settled*: an
 * in-flight booking (held but not yet confirmed, say) would read as an orphaned
 * hold here, so the gateway must only feed the reconciler bookings past a
 * settle-grace window. Keeping liveness in the gateway lets this stay a pure
 * function — see {@link ./booking-snapshot}.
 */
import {
  type BookingSnapshot,
  type LedgerState,
  type ObservedStates,
  type SupplierState,
} from './booking-snapshot';
import { type DivergenceKind, type DivergenceSeverity } from './finding';

/**
 * A divergence as the engine reports it: the verdict and its evidence, but not
 * yet a persisted {@link DivergenceFinding} (no id, trace id, or timestamp — the
 * service adds those).
 */
export interface Divergence {
  readonly kind: DivergenceKind;
  readonly severity: DivergenceSeverity;
  readonly detail: string;
  readonly observed: ObservedStates;
}

/** Phrase a ledger state for an explanation. */
function ledgerPhrase(state: LedgerState): string {
  switch (state) {
    case 'committed':
      return 'committed';
    case 'reversed':
      return 'reversed';
    case 'absent':
      return 'has no record';
  }
}

/** Phrase a supplier state for an explanation. */
function supplierPhrase(state: SupplierState): string {
  switch (state) {
    case 'confirmed':
      return 'confirmed';
    case 'cancelled':
      return 'cancelled';
    case 'absent':
      return 'has no record';
  }
}

/**
 * Compare one settled booking across its sources of truth and report every
 * divergence it exhibits.
 *
 * Returns an empty array for a consistent booking (completed or unwound). The
 * three rules are mutually exclusive for a given snapshot in practice, but each
 * is evaluated independently so a genuinely multi-way disagreement surfaces every
 * facet rather than only the first.
 *
 * @param snapshot - one booking's cross-source state.
 * @returns the divergences found, newest-relevant first; empty when consistent.
 */
export function detectDivergences(snapshot: BookingSnapshot): Divergence[] {
  const { inventory, supplier, ledger } = snapshot;
  const observed: ObservedStates = { inventory, supplier, ledger };
  const divergences: Divergence[] = [];

  // The headline divergence: the partner is holding a confirmed booking that the
  // financial record never committed (failed, reversed, or absent).
  if (supplier === 'confirmed' && ledger !== 'committed') {
    divergences.push({
      kind: 'supplier_confirmed_ledger_missing',
      severity: 'critical',
      detail: `supplier confirmed the booking but the ledger ${ledgerPhrase(ledger)} — the partner is holding a booking with no committed financial record`,
      observed,
    });
  }

  // The mirror image: money is posted for a booking the partner is not holding.
  if (ledger === 'committed' && supplier !== 'confirmed') {
    divergences.push({
      kind: 'ledger_committed_supplier_unconfirmed',
      severity: 'critical',
      detail: `the ledger committed the booking but the supplier ${supplierPhrase(supplier)} — money is posted for a booking the partner is not holding`,
      observed,
    });
  }

  // A stranded hold: inventory is still held for a booking that never completed.
  if (inventory === 'held' && supplier !== 'confirmed' && ledger !== 'committed') {
    divergences.push({
      kind: 'orphaned_hold',
      severity: 'warning',
      detail: `inventory is still held but the booking did not complete (supplier ${supplierPhrase(supplier)}, ledger ${ledgerPhrase(ledger)}) — the hold was never released`,
      observed,
    });
  }

  return divergences;
}
