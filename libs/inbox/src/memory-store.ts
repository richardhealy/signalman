/**
 * An in-memory {@link InboxStore}.
 *
 * It is the reference implementation of the store contract — it models the
 * claim-then-rollback transactional mechanics exactly as a SQL store would — and
 * the substrate the consumer tests run against. Services use a Postgres-backed
 * store in production; this one keeps the dedup guarantee fully unit-testable
 * without a live datastore, and doubles as a fake in service tests.
 */
import { type InboxKey, type InboxRecord } from './record';
import { type InboxOutcome, type InboxStore, type ProcessOnceOptions } from './store';

/**
 * Canonical, collision-free string encoding of an {@link InboxKey} for use as a
 * map key. JSON array encoding disambiguates the two fields — `('a', 'b c')` and
 * `('a b', 'c')` encode differently — where a plain delimiter could let them
 * collide. (A SQL store uses a composite primary key on `(consumer, message_id)`
 * instead; this is the in-memory analogue.)
 */
function keyString(key: InboxKey): string {
  return JSON.stringify([key.consumer, key.messageId]);
}

export class InMemoryInboxStore implements InboxStore<void> {
  private readonly records = new Map<string, InboxRecord>();

  async processOnce<T>(
    key: InboxKey,
    work: (tx: void) => Promise<T>,
    { now }: ProcessOnceOptions,
  ): Promise<InboxOutcome<T>> {
    const k = keyString(key);
    if (this.records.has(k)) {
      return { duplicate: true };
    }

    // Claim synchronously, before the first `await`, so two interleaved
    // redeliveries of the same message cannot both pass the check and both run
    // the handler — the same race a unique constraint closes in SQL.
    this.records.set(k, { consumer: key.consumer, messageId: key.messageId, processedAt: now });

    try {
      const result = await work();
      return { duplicate: false, result };
    } catch (error) {
      // The "transaction" rolls back: drop the marker so the redelivery
      // reprocesses the message rather than skipping it as already-done.
      this.records.delete(k);
      throw error;
    }
  }

  async seen(key: InboxKey): Promise<boolean> {
    return this.records.has(keyString(key));
  }

  // --- Inspection helpers (for tests and operator tooling) --------------------

  /** A copy of the marker for `key`, or `undefined` if the message is unseen. */
  get(key: InboxKey): InboxRecord | undefined {
    const record = this.records.get(keyString(key));
    return record ? { ...record } : undefined;
  }

  /** Snapshot copies of every marker recorded by `consumer`. */
  processedBy(consumer: string): InboxRecord[] {
    return [...this.records.values()].filter((r) => r.consumer === consumer).map((r) => ({ ...r }));
  }

  /** Total number of markers held, across all consumers. */
  get size(): number {
    return this.records.size;
  }
}
