/**
 * The payments service's source of truth: a **payment** taken against a booking,
 * backed by an external PSP authorization.
 *
 * Payments are the money leg of the saga (`… -> authorize payment -> … ->
 * capture + commit to ledger -> …`). Authorizing reserves funds with the PSP;
 * capturing takes them; voiding — the compensation — releases the authorization.
 * The reconciler later compares a booking's payment state against the other
 * sources of truth (supplier confirmation, ledger entry), so the record is
 * deliberately explicit about the PSP references that prove what actually
 * happened outside our boundary.
 */

/**
 * Lifecycle of a payment.
 *
 * - `authorized` — funds reserved with the PSP; not yet taken.
 * - `captured`   — funds taken; the PSP holds a capture reference. Terminal for
 *                  the happy path.
 * - `voided`     — the authorization was released before capture (the
 *                  compensation, or a cancelled booking); terminal.
 */
export type PaymentStatus = 'authorized' | 'captured' | 'voided';

/**
 * A payment of `amount` (in the currency's minor units) for a booking.
 *
 * Immutable in shape: a transition (capture, void) produces a new value rather
 * than mutating in place, mirroring how a transactional row update behaves and
 * keeping the in-memory repository honest about what Postgres would do.
 */
export interface Payment {
  /** Stable unique id for the payment; also the `aggregateId` of its outbox events. */
  readonly id: string;
  /** The booking this payment belongs to. One booking has at most one payment. */
  readonly bookingId: string;
  /** Amount taken, in the currency's minor units (e.g. cents). */
  readonly amount: number;
  /** ISO 4217 currency code, e.g. `"USD"`. */
  readonly currency: string;
  readonly status: PaymentStatus;
  /** The PSP's authorization reference — the external truth handle for the funds. */
  readonly authorizationId: string;
  /** The PSP's capture reference; present only once `captured`. */
  readonly captureId?: string;
  /** When the authorization was obtained. */
  readonly createdAt: Date;
  /** When the payment was captured; present only once `captured`. */
  readonly capturedAt?: Date;
  /** When the authorization was voided; present only once `voided`. */
  readonly voidedAt?: Date;
}
