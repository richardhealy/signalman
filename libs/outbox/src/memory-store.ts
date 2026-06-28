/**
 * An in-memory {@link OutboxStore}.
 *
 * It is the reference implementation of the store contract — it models leasing,
 * back-off rescheduling, and dead-lettering exactly as a SQL store would — and
 * the substrate the relay tests run against. Services use a Postgres-backed
 * store in production; this one keeps the durable mechanics fully unit-testable
 * without a live datastore, and doubles as a fake in service tests.
 *
 * Every transition stores a fresh record value rather than mutating in place,
 * and reads hand back copies, so callers cannot accidentally observe or corrupt
 * internal state — the same isolation a transactional row update would give.
 */
import { type OutboxRecord } from './record';
import { type ClaimOptions, type MarkFailedOptions, type OutboxStore } from './store';
import { type UnitOfWork } from './transaction';

export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();

  async add(record: OutboxRecord, tx?: UnitOfWork): Promise<void> {
    // The insert itself is a single map write. Enlisted in a unit of work it is
    // deferred to commit so it lands atomically with the business-state change;
    // without one it applies immediately (the relay still delivers it, but the
    // dual-write window the caller chose not to close is back).
    const write = (): void => void this.records.set(record.id, { ...record });
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }

  async claimBatch({ batchSize, now, leaseMs }: ClaimOptions): Promise<OutboxRecord[]> {
    if (batchSize <= 0) {
      return [];
    }
    const due = [...this.records.values()]
      .filter((r) => r.status === 'pending' && r.availableAt.getTime() <= now.getTime())
      // Oldest first by stage time, with id as a stable tie-break so the claim
      // order is deterministic even when records share a `createdAt`.
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .slice(0, batchSize);

    const leaseUntil = new Date(now.getTime() + leaseMs);
    return due.map((record) => {
      const leased: OutboxRecord = { ...record, availableAt: leaseUntil };
      this.records.set(record.id, leased);
      return { ...leased };
    });
  }

  async markPublished(id: string, publishedAt: Date): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    this.records.set(id, { ...record, status: 'published', publishedAt });
  }

  async markFailed(id: string, options: MarkFailedOptions): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    this.records.set(id, {
      ...record,
      attempts: options.attempts,
      lastError: options.error,
      status: options.dead ? 'failed' : 'pending',
      // On a retry, advance availability to the back-off time; on dead-letter,
      // leave it where the lease put it (the record is terminal anyway).
      availableAt: options.dead ? record.availableAt : (options.availableAt ?? record.availableAt),
    });
  }

  // --- Inspection helpers (for tests and operator tooling) --------------------

  /** A snapshot copy of every record currently held. */
  all(): OutboxRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** A copy of one record by id, or `undefined` if unknown. */
  get(id: string): OutboxRecord | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  /** Count records in a given lifecycle state. */
  countByStatus(status: OutboxRecord['status']): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === status) {
        count += 1;
      }
    }
    return count;
  }

  /** Total number of records held, in any state. */
  get size(): number {
    return this.records.size;
  }
}
