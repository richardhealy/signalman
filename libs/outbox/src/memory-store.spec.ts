import { createOutboxRecord, type OutboxMessage, type OutboxRecord } from './record';
import { InMemoryOutboxStore } from './memory-store';

const baseMessage: OutboxMessage = {
  aggregateType: 'booking',
  aggregateId: 'bk_1',
  eventType: 'inventory.held',
  payload: {},
};

/** Stage a record with a fixed id and creation time, for deterministic ordering. */
function staged(id: string, createdAt: string): OutboxRecord {
  return createOutboxRecord(baseMessage, { idFactory: () => id, clock: () => new Date(createdAt) });
}

describe('InMemoryOutboxStore', () => {
  let store: InMemoryOutboxStore;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
  });

  it('persists a record and returns defensive copies', async () => {
    await store.add(staged('rec_1', '2026-06-28T10:00:00.000Z'));

    const fetched = store.get('rec_1');
    expect(fetched).toMatchObject({ id: 'rec_1', status: 'pending' });

    // Mutating a returned copy must not affect stored state.
    (fetched as unknown as { status: string }).status = 'published';
    expect(store.get('rec_1')?.status).toBe('pending');
    expect(store.get('missing')).toBeUndefined();
  });

  describe('claimBatch', () => {
    const now = new Date('2026-06-28T10:00:10.000Z');

    it('returns due pending records oldest-first, capped at the batch size', async () => {
      await store.add(staged('rec_b', '2026-06-28T10:00:02.000Z'));
      await store.add(staged('rec_a', '2026-06-28T10:00:01.000Z'));
      await store.add(staged('rec_c', '2026-06-28T10:00:03.000Z'));

      const claimed = await store.claimBatch({ batchSize: 2, now, leaseMs: 1_000 });

      expect(claimed.map((r) => r.id)).toEqual(['rec_a', 'rec_b']);
    });

    it('skips records whose availableAt is still in the future', async () => {
      const future = staged('rec_future', '2026-06-28T10:00:01.000Z');
      await store.add({ ...future, availableAt: new Date('2026-06-28T10:05:00.000Z') });

      const claimed = await store.claimBatch({ batchSize: 10, now, leaseMs: 1_000 });

      expect(claimed).toHaveLength(0);
    });

    it('leases claimed records so a concurrent pass cannot re-claim them', async () => {
      await store.add(staged('rec_1', '2026-06-28T10:00:01.000Z'));

      const first = await store.claimBatch({ batchSize: 10, now, leaseMs: 30_000 });
      const second = await store.claimBatch({ batchSize: 10, now, leaseMs: 30_000 });

      expect(first.map((r) => r.id)).toEqual(['rec_1']);
      expect(second).toHaveLength(0);
    });

    it('makes a record claimable again once its lease expires (crash recovery)', async () => {
      await store.add(staged('rec_1', '2026-06-28T10:00:01.000Z'));

      await store.claimBatch({ batchSize: 10, now, leaseMs: 30_000 });
      const afterLease = new Date(now.getTime() + 30_001);
      const reclaimed = await store.claimBatch({ batchSize: 10, now: afterLease, leaseMs: 30_000 });

      expect(reclaimed.map((r) => r.id)).toEqual(['rec_1']);
    });
  });

  it('markPublished makes the record terminal and unclaimable', async () => {
    await store.add(staged('rec_1', '2026-06-28T10:00:01.000Z'));
    const publishedAt = new Date('2026-06-28T10:00:11.000Z');

    await store.markPublished('rec_1', publishedAt);

    expect(store.get('rec_1')).toMatchObject({ status: 'published', publishedAt });
    const claimed = await store.claimBatch({
      batchSize: 10,
      now: new Date('2026-06-28T11:00:00.000Z'),
      leaseMs: 1_000,
    });
    expect(claimed).toHaveLength(0);
    expect(store.countByStatus('published')).toBe(1);
  });

  describe('markFailed', () => {
    it('reschedules a retry: bumps attempts, records the error, and defers availability', async () => {
      await store.add(staged('rec_1', '2026-06-28T10:00:01.000Z'));
      const retryAt = new Date('2026-06-28T10:01:00.000Z');

      await store.markFailed('rec_1', { attempts: 1, error: 'broker down', availableAt: retryAt });

      const record = store.get('rec_1');
      expect(record).toMatchObject({ status: 'pending', attempts: 1, lastError: 'broker down' });
      expect(record?.availableAt).toEqual(retryAt);

      // Not yet due, then due once the retry time arrives.
      const before = await store.claimBatch({
        batchSize: 10,
        now: new Date('2026-06-28T10:00:30.000Z'),
        leaseMs: 1_000,
      });
      expect(before).toHaveLength(0);
      const after = await store.claimBatch({ batchSize: 10, now: retryAt, leaseMs: 1_000 });
      expect(after.map((r) => r.id)).toEqual(['rec_1']);
    });

    it('dead-letters a record: terminal failed, never claimed again', async () => {
      await store.add(staged('rec_1', '2026-06-28T10:00:01.000Z'));

      await store.markFailed('rec_1', { attempts: 8, error: 'still down', dead: true });

      expect(store.get('rec_1')).toMatchObject({ status: 'failed', attempts: 8 });
      const claimed = await store.claimBatch({
        batchSize: 10,
        now: new Date('2026-06-28T12:00:00.000Z'),
        leaseMs: 1_000,
      });
      expect(claimed).toHaveLength(0);
      expect(store.countByStatus('failed')).toBe(1);
    });
  });

  it('reports size and status counts', async () => {
    await store.add(staged('rec_1', '2026-06-28T10:00:01.000Z'));
    await store.add(staged('rec_2', '2026-06-28T10:00:02.000Z'));
    await store.markPublished('rec_2', new Date('2026-06-28T10:00:05.000Z'));

    expect(store.size).toBe(2);
    expect(store.countByStatus('pending')).toBe(1);
    expect(store.countByStatus('published')).toBe(1);
  });
});
