/**
 * The persistence contract for the transactional outbox.
 *
 * A service implements this over its own Postgres (writing {@link
 * OutboxStore.add} inside the same transaction as its business state), and the
 * {@link OutboxRelay} drives the rest of the lifecycle through it. The
 * interface is deliberately broker- and database-agnostic so the relay and its
 * tests can run against {@link InMemoryOutboxStore} without a live datastore.
 */
import { type OutboxRecord } from './record';
import { type UnitOfWork } from './transaction';

/** Inputs for {@link OutboxStore.claimBatch}. */
export interface ClaimOptions {
  /** Maximum number of records to claim in this pass. */
  batchSize: number;
  /** The relay's notion of "now"; only records with `availableAt <= now` are due. */
  now: Date;
  /**
   * How long the claim is leased for. While leased, the record's `availableAt`
   * is pushed to `now + leaseMs` so a second concurrent relay (or a second pass
   * before this one finishes) will not re-claim it. If the relay crashes before
   * marking the record, the lease expires and the record becomes claimable
   * again — the at-least-once property that pairs with idempotent consumers.
   */
  leaseMs: number;
}

/** Inputs for {@link OutboxStore.markFailed}. */
export interface MarkFailedOptions {
  /** New cumulative attempt count (the prior `attempts` plus one). */
  attempts: number;
  /** Message from the failed publish, retained on the record for diagnostics. */
  error: string;
  /**
   * When the record next becomes claimable for a retry. Omitted when the record
   * is being dead-lettered.
   */
  availableAt?: Date;
  /**
   * Move the record to the terminal `failed` state instead of scheduling a
   * retry — set once it has exhausted its attempt budget.
   */
  dead?: boolean;
}

/**
 * Storage operations the outbox needs. Implementations must make these
 * effectively atomic with respect to one another; a SQL implementation gets
 * this for free with row locks and `SELECT … FOR UPDATE SKIP LOCKED`.
 */
export interface OutboxStore {
  /**
   * Persist a freshly staged record. Pass the {@link UnitOfWork} of the
   * surrounding {@link runInTransaction} so the row commits inside the **same
   * transaction** as the business state change it accompanies — that shared
   * commit is what makes the outbox transactional and defeats the dual-write
   * problem. Called without a unit of work the record is persisted immediately:
   * the relay still delivers it at-least-once, but the dual-write window is back.
   */
  add(record: OutboxRecord, tx?: UnitOfWork): Promise<void>;

  /**
   * Atomically claim up to `batchSize` due `pending` records (oldest first),
   * leasing each so concurrent relays do not double-publish. Returns the
   * claimed records for the caller to publish.
   */
  claimBatch(options: ClaimOptions): Promise<OutboxRecord[]>;

  /** Mark a record `published`, recording when the broker accepted it. Terminal. */
  markPublished(id: string, publishedAt: Date): Promise<void>;

  /**
   * Record a failed publish: bump the attempt count and either reschedule the
   * record (back to `pending`, claimable at `availableAt`) or dead-letter it
   * (to `failed`) when `dead` is set.
   */
  markFailed(id: string, options: MarkFailedOptions): Promise<void>;
}
