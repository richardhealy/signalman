/**
 * Persistence for the ledger service's source of truth: the {@link LedgerEntry}
 * a booking holds.
 *
 * The contract is database-agnostic so the application service and its tests run
 * against {@link InMemoryLedgerRepository} without a live datastore. A production
 * implementation backs this with the service's own Postgres, and crucially runs
 * {@link LedgerRepository.commit} — and the outbox row that accompanies it —
 * inside **one** transaction, so the state change and its event commit together
 * (the transactional-outbox guarantee). That single transaction is the {@link
 * UnitOfWork} the service threads through both writes via `runInTransaction`.
 */
import { type UnitOfWork } from '@signalman/outbox';
import { type LedgerEntry } from './entry';

/** The persistence seam a ledger-entry transition writes through. */
export interface LedgerRepository {
  /**
   * The booking's current ledger entry, if any. One booking is posted at most
   * once, so this is the idempotency key the application service dedups on.
   */
  findByBooking(bookingId: string): Promise<LedgerEntry | undefined>;

  /**
   * Persist a ledger entry, whether freshly posted or transitioned (reversed).
   * Upserts on `bookingId` — a booking holds exactly one entry, which advances
   * through its lifecycle in place.
   *
   * Pass the surrounding {@link UnitOfWork} so the entry commits atomically with
   * the outbox event the service stages alongside it — the transactional-outbox
   * guarantee that an event is published if and only if its state change did.
   */
  commit(entry: LedgerEntry, tx?: UnitOfWork): Promise<void>;
}

/**
 * An in-memory {@link LedgerRepository}, the reference implementation used as a
 * fake in tests until the Postgres-backed store lands. Reads hand back copies and
 * writes store copies, so callers cannot observe or corrupt internal state — the
 * isolation a transactional row update would give.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  private readonly entriesByBooking = new Map<string, LedgerEntry>();

  async findByBooking(bookingId: string): Promise<LedgerEntry | undefined> {
    const entry = this.entriesByBooking.get(bookingId);
    return entry ? { ...entry } : undefined;
  }

  async commit(entry: LedgerEntry, tx?: UnitOfWork): Promise<void> {
    // Enlisted in a unit of work the upsert defers to commit so it lands with the
    // outbox row; standalone it applies immediately (the two-arg shape the fake
    // keeps for callers that do not stage an event).
    const write = (): void => void this.entriesByBooking.set(entry.bookingId, { ...entry });
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }
}
