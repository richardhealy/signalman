/**
 * Persistence for the inventory service's two pieces of truth: the {@link Hold}
 * records and the per-SKU availability they draw down.
 *
 * The contract is database-agnostic so the application service and its tests run
 * against {@link InMemoryHoldRepository} without a live datastore. A production
 * implementation backs this with the service's own Postgres, and crucially runs
 * {@link HoldRepository.commitHold}/{@link HoldRepository.commitRelease} — and
 * the outbox row that accompanies them — inside **one** transaction, so the state
 * change and its event commit together (the transactional-outbox guarantee). That
 * single transaction is the {@link UnitOfWork} the service threads through both
 * writes via `runInTransaction`; the in-memory reference models the same
 * all-or-nothing commit by deferring its mutation into the unit of work.
 */
import { type UnitOfWork } from '@signalman/outbox';
import { type Hold } from './hold';

/** The two writes a hold transition makes, expressed as one atomic operation. */
export interface HoldRepository {
  /**
   * The booking's current hold, if any. One booking holds inventory at most
   * once, so this is the idempotency key the application service dedups on.
   */
  findByBooking(bookingId: string): Promise<Hold | undefined>;

  /** Units of `sku` currently available to reserve (0 for an unknown SKU). */
  availableFor(sku: string): Promise<number>;

  /**
   * Persist a freshly placed hold and draw its `qty` down from the SKU's
   * availability, atomically. Rejects rather than overselling if availability
   * has dropped below `qty` since the caller checked — the last line of defence
   * a Postgres implementation enforces with `SELECT … FOR UPDATE`. That check is
   * eager (it can still reject), so a would-oversell write rolls the whole unit
   * of work back before anything commits.
   *
   * Pass the surrounding {@link UnitOfWork} so the hold commits atomically with
   * the `inventory.held` outbox event the service stages alongside it — the
   * transactional-outbox guarantee that an event is published if and only if its
   * state change did.
   */
  commitHold(hold: Hold, tx?: UnitOfWork): Promise<void>;

  /**
   * Persist a released hold and return its `qty` to the SKU's availability,
   * atomically. The compensation leg.
   *
   * Pass the surrounding {@link UnitOfWork} so the release commits atomically
   * with the `inventory.released` outbox event staged alongside it.
   */
  commitRelease(hold: Hold, tx?: UnitOfWork): Promise<void>;
}

/** Construction options for {@link InMemoryHoldRepository}. */
export interface InMemoryHoldRepositoryOptions {
  /** Initial availability per SKU, e.g. `{ 'seat-A': 10 }`. */
  stock?: Record<string, number>;
}

/**
 * An in-memory {@link HoldRepository}, the reference implementation used as a
 * fake in tests until the Postgres-backed store lands. Every transition stores a
 * fresh record and reads hand back copies, so callers cannot observe or corrupt
 * internal state — the isolation a transactional row update would give.
 */
export class InMemoryHoldRepository implements HoldRepository {
  private readonly stock: Map<string, number>;
  private readonly holdsByBooking = new Map<string, Hold>();

  constructor(options: InMemoryHoldRepositoryOptions = {}) {
    this.stock = new Map(Object.entries(options.stock ?? {}));
  }

  async findByBooking(bookingId: string): Promise<Hold | undefined> {
    const hold = this.holdsByBooking.get(bookingId);
    return hold ? { ...hold } : undefined;
  }

  async availableFor(sku: string): Promise<number> {
    return this.stock.get(sku) ?? 0;
  }

  async commitHold(hold: Hold, tx?: UnitOfWork): Promise<void> {
    // The oversell guard runs eagerly: a rejection here throws before anything is
    // enlisted, so it rolls the whole unit of work back (no hold, no event).
    const available = this.stock.get(hold.sku) ?? 0;
    if (hold.qty > available) {
      throw new Error(
        `cannot hold ${hold.qty} of ${hold.sku}: would oversell (available ${available})`,
      );
    }
    // The mutation is infallible past the guard, so it defers to commit (landing
    // with the outbox row) when enlisted, or applies immediately when not.
    const write = (): void => {
      this.stock.set(hold.sku, available - hold.qty);
      this.holdsByBooking.set(hold.bookingId, { ...hold });
    };
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }

  async commitRelease(hold: Hold, tx?: UnitOfWork): Promise<void> {
    const available = this.stock.get(hold.sku) ?? 0;
    const write = (): void => {
      this.stock.set(hold.sku, available + hold.qty);
      this.holdsByBooking.set(hold.bookingId, { ...hold });
    };
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }
}
