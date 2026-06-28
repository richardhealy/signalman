/**
 * The supplier service's source of truth: a **confirmation** obtained from the
 * external partner for a booking.
 *
 * Confirmations are the partner leg of the saga (`… -> confirm with supplier ->
 * capture + commit to ledger -> …`). Confirming books the reservation with the
 * partner; cancelling — the compensation — releases it. The reconciler later
 * compares a booking's confirmation state against the other sources of truth
 * (inventory hold, ledger entry), so the record is deliberately explicit about
 * the partner reference that proves what actually happened outside our boundary.
 */

/**
 * Lifecycle of a confirmation.
 *
 * - `confirmed` — the partner has booked the reservation; the live confirmation.
 * - `cancelled` — the confirmation has been released (the compensation, or a
 *                 cancelled booking); terminal.
 */
export type ConfirmationStatus = 'confirmed' | 'cancelled';

/**
 * A partner confirmation of `qty` units of `sku` for a booking.
 *
 * Immutable in shape: a transition (cancel) produces a new value rather than
 * mutating in place, mirroring how a transactional row update behaves and
 * keeping the in-memory repository honest about what Postgres would do.
 */
export interface Confirmation {
  /** Stable unique id for the confirmation; also the `aggregateId` of its outbox events. */
  readonly id: string;
  /** The booking this confirmation belongs to. One booking is confirmed at most once. */
  readonly bookingId: string;
  /** The stock-keeping unit being confirmed, e.g. a room-night or seat class. */
  readonly sku: string;
  /** How many units are confirmed. */
  readonly qty: number;
  readonly status: ConfirmationStatus;
  /** The partner's confirmation reference — the external truth handle for the booking. */
  readonly confirmationId: string;
  /** When the confirmation was obtained. */
  readonly createdAt: Date;
  /** When the confirmation was cancelled; present only once `cancelled`. */
  readonly cancelledAt?: Date;
}
