/**
 * The ledger service's source of truth: a **ledger entry** — the financial record
 * of what actually happened for a booking.
 *
 * Ledger entries are the final leg of the saga (`… -> confirm with supplier ->
 * capture + commit to ledger -> notify`). Committing posts the booking's money to
 * the financial record; reversing — the compensation — backs it out. Unlike
 * inventory, payments, and supplier, the ledger has **no external boundary**: it
 * is our own authoritative record, so a commit is a posting that succeeds rather
 * than a request to a system that might be slow or flaky. The reconciler later
 * compares a booking's ledger state (committed and for how much) against the
 * other sources of truth (inventory hold, supplier confirmation), so the entry is
 * deliberately explicit about the amount posted and the capture it records.
 */

/**
 * Lifecycle of a ledger entry.
 *
 * - `committed` — the booking's money is posted to the financial record; the live
 *                 entry. Terminal for the happy path.
 * - `reversed`  — the posting has been backed out (the compensation, or a
 *                 cancelled booking); terminal.
 */
export type LedgerEntryStatus = 'committed' | 'reversed';

/**
 * A posting of `amount` (in the currency's minor units) for a booking.
 *
 * Immutable in shape: a transition (reverse) produces a new value rather than
 * mutating in place, mirroring how a transactional row update behaves and keeping
 * the in-memory repository honest about what Postgres would do.
 */
export interface LedgerEntry {
  /** Stable unique id for the entry; also the `aggregateId` of its outbox events. */
  readonly id: string;
  /** The booking this entry belongs to. One booking has at most one ledger entry. */
  readonly bookingId: string;
  /** Amount posted, in the currency's minor units (e.g. cents). */
  readonly amount: number;
  /** ISO 4217 currency code, e.g. `"USD"`. */
  readonly currency: string;
  readonly status: LedgerEntryStatus;
  /**
   * The payment capture reference this entry records — the handle that ties the
   * financial record back to the money payments actually took. Empty when the
   * caller committed without one.
   */
  readonly captureId: string;
  /** When the entry was committed. */
  readonly committedAt: Date;
  /** When the entry was reversed; present only once `reversed`. */
  readonly reversedAt?: Date;
}
