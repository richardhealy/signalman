/**
 * Persistence for the supplier service's source of truth: the
 * {@link Confirmation} record a booking holds.
 *
 * The contract is database-agnostic so the application service and its tests run
 * against {@link InMemoryConfirmationRepository} without a live datastore. A
 * production implementation backs this with the service's own Postgres, and
 * crucially runs {@link ConfirmationRepository.commit} — and the outbox row that
 * accompanies it — inside **one** transaction, so the state change and its event
 * commit together (the transactional-outbox guarantee). That single transaction
 * is the {@link UnitOfWork} the service threads through both writes via
 * `runInTransaction`; the in-memory reference models the same all-or-nothing
 * commit by deferring its upsert into the unit of work.
 */
import { type UnitOfWork } from '@signalman/outbox';
import { type Confirmation } from './confirmation';

/** The persistence seam a confirmation transition writes through. */
export interface ConfirmationRepository {
  /**
   * The booking's current confirmation, if any. One booking is confirmed at most
   * once, so this is the idempotency key the application service dedups on.
   */
  findByBooking(bookingId: string): Promise<Confirmation | undefined>;

  /**
   * Persist a confirmation, whether freshly obtained or transitioned
   * (cancelled). Upserts on `bookingId` — a booking holds exactly one
   * confirmation record, which advances through its lifecycle in place.
   *
   * Pass the surrounding {@link UnitOfWork} so the confirmation commits
   * atomically with the `supplier.*` outbox event the service stages alongside
   * it — the transactional-outbox guarantee that an event is published if and
   * only if its state change did.
   */
  commit(confirmation: Confirmation, tx?: UnitOfWork): Promise<void>;
}

/**
 * An in-memory {@link ConfirmationRepository}, the reference implementation used
 * as a fake in tests until the Postgres-backed store lands. Reads hand back
 * copies and writes store copies, so callers cannot observe or corrupt internal
 * state — the isolation a transactional row update would give.
 */
export class InMemoryConfirmationRepository implements ConfirmationRepository {
  private readonly confirmationsByBooking = new Map<string, Confirmation>();

  async findByBooking(bookingId: string): Promise<Confirmation | undefined> {
    const confirmation = this.confirmationsByBooking.get(bookingId);
    return confirmation ? { ...confirmation } : undefined;
  }

  async commit(confirmation: Confirmation, tx?: UnitOfWork): Promise<void> {
    // Enlisted in a unit of work the upsert defers to commit so it lands with the
    // outbox row; standalone it applies immediately.
    const write = (): void =>
      void this.confirmationsByBooking.set(confirmation.bookingId, { ...confirmation });
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }
}
