/**
 * Persistence for the payments service's source of truth: the {@link Payment}
 * record a booking holds.
 *
 * The contract is database-agnostic so the application service and its tests run
 * against {@link InMemoryPaymentRepository} without a live datastore. A
 * production implementation backs this with the service's own Postgres, and
 * crucially runs {@link PaymentRepository.commit} — and the outbox row that
 * accompanies it — inside **one** transaction, so the state change and its event
 * commit together (the transactional-outbox guarantee). That single transaction
 * is the {@link UnitOfWork} the service threads through both writes via
 * `runInTransaction`; the in-memory reference models the same all-or-nothing
 * commit by deferring its upsert into the unit of work.
 */
import { type UnitOfWork } from '@signalman/outbox';
import { type Payment } from './payment';

/** The persistence seam a payment transition writes through. */
export interface PaymentRepository {
  /**
   * The booking's current payment, if any. One booking has at most one payment,
   * so this is the idempotency key the application service dedups on.
   */
  findByBooking(bookingId: string): Promise<Payment | undefined>;

  /**
   * Persist a payment, whether freshly authorized or transitioned (captured,
   * voided). Upserts on `bookingId` — a booking holds exactly one payment
   * record, which advances through its lifecycle in place.
   *
   * Pass the surrounding {@link UnitOfWork} so the payment commits atomically
   * with the `payment.*` outbox event the service stages alongside it — the
   * transactional-outbox guarantee that an event is published if and only if its
   * state change did.
   */
  commit(payment: Payment, tx?: UnitOfWork): Promise<void>;
}

/**
 * An in-memory {@link PaymentRepository}, the reference implementation used as a
 * fake in tests until the Postgres-backed store lands. Reads hand back copies and
 * writes store copies, so callers cannot observe or corrupt internal state — the
 * isolation a transactional row update would give.
 */
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly paymentsByBooking = new Map<string, Payment>();

  async findByBooking(bookingId: string): Promise<Payment | undefined> {
    const payment = this.paymentsByBooking.get(bookingId);
    return payment ? { ...payment } : undefined;
  }

  async commit(payment: Payment, tx?: UnitOfWork): Promise<void> {
    // Enlisted in a unit of work the upsert defers to commit so it lands with the
    // outbox row; standalone it applies immediately.
    const write = (): void => void this.paymentsByBooking.set(payment.bookingId, { ...payment });
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }
}
