/**
 * The inventory service's source of truth: a **hold** placed against a SKU for a
 * booking.
 *
 * Holds are the inventory leg of the saga (`hold inventory -> authorize payment
 * -> …`). Placing a hold reserves quantity for a booking; releasing it — the
 * compensation — gives that quantity back. The reconciler later compares a
 * booking's hold state against the other sources of truth (supplier, ledger), so
 * the hold record is deliberately explicit about *what* was reserved and whether
 * it is still standing.
 */

/**
 * Lifecycle of a hold.
 *
 * - `held`     — quantity is reserved for the booking; the live reservation.
 * - `released` — the reservation has been given back (compensation, or a
 *                customer-cancelled booking); terminal.
 */
export type HoldStatus = 'held' | 'released';

/**
 * A reservation of `qty` units of `sku` for a booking.
 *
 * Immutable in shape: a transition (e.g. release) produces a new value rather
 * than mutating in place, mirroring how a transactional row update behaves and
 * keeping the in-memory repository honest about what Postgres would do.
 */
export interface Hold {
  /** Stable unique id for the hold; also the `aggregateId` of its outbox events. */
  readonly id: string;
  /** The booking this hold belongs to. One booking holds inventory at most once. */
  readonly bookingId: string;
  /** The stock-keeping unit being reserved, e.g. a room-night or seat class. */
  readonly sku: string;
  /** How many units are reserved. */
  readonly qty: number;
  readonly status: HoldStatus;
  /** When the hold was placed. */
  readonly createdAt: Date;
  /** When the hold was released; present only once `released`. */
  readonly releasedAt?: Date;
}
