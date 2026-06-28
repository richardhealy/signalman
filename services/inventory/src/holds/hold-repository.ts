/**
 * Persistence for the inventory service's two pieces of truth: the {@link Hold}
 * records and the per-SKU availability they draw down.
 *
 * The contract is database-agnostic so the application service and its tests run
 * against {@link InMemoryHoldRepository} without a live datastore. A production
 * implementation backs this with the service's own Postgres, and crucially runs
 * {@link HoldRepository.commitHold}/{@link HoldRepository.commitRelease} — and
 * the outbox row that accompanies them — inside **one** transaction, so the state
 * change and its event commit together (the transactional-outbox guarantee).
 */
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
   * a Postgres implementation enforces with `SELECT … FOR UPDATE`.
   */
  commitHold(hold: Hold): Promise<void>;

  /**
   * Persist a released hold and return its `qty` to the SKU's availability,
   * atomically. The compensation leg.
   */
  commitRelease(hold: Hold): Promise<void>;
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

  async commitHold(hold: Hold): Promise<void> {
    const available = this.stock.get(hold.sku) ?? 0;
    if (hold.qty > available) {
      throw new Error(
        `cannot hold ${hold.qty} of ${hold.sku}: would oversell (available ${available})`,
      );
    }
    this.stock.set(hold.sku, available - hold.qty);
    this.holdsByBooking.set(hold.bookingId, { ...hold });
  }

  async commitRelease(hold: Hold): Promise<void> {
    const available = this.stock.get(hold.sku) ?? 0;
    this.stock.set(hold.sku, available + hold.qty);
    this.holdsByBooking.set(hold.bookingId, { ...hold });
  }
}
