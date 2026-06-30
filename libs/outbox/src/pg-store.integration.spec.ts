/**
 * End-to-end verification of {@link PostgresOutboxStore} against a *live*
 * Postgres instance. Gated behind `POSTGRES_TEST_URL`, so the default
 * `npm test` (and CI, which has no database) skips it and stays green:
 *
 *   docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   POSTGRES_TEST_URL="postgresql://postgres:test@localhost:5432/postgres" npm test -- pg-store.integration
 *
 * Each test run uses a unique schema name derived from the test start time, so
 * the cases are isolated from one another and safe to re-run without a clean DB.
 */

const TEST_URL = process.env.POSTGRES_TEST_URL;
const SKIP = !TEST_URL;

import { Pool } from 'pg';
import { createOutboxRecord } from './record';
import { PostgresOutboxStore } from './pg-store';
import { PostgresInboxStore } from '../../inbox/src/pg-store';
import { runInPgTransaction } from './pg-transaction';

(SKIP ? describe.skip : describe)('PostgresOutboxStore — integration', () => {
  let pool: Pool;
  let schema: string;
  let store: PostgresOutboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    schema = `test_${Date.now()}`;
    store = new PostgresOutboxStore(pool, schema);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('adds and claims a record', async () => {
    const record = createOutboxRecord({
      aggregateType: 'booking',
      aggregateId: 'b-1',
      eventType: 'test.event',
      payload: { foo: 'bar' },
    });
    await store.add(record);

    const now = new Date();
    const batch = await store.claimBatch({ batchSize: 10, now, leaseMs: 5000 });
    expect(batch).toHaveLength(1);
    expect(batch[0].id).toBe(record.id);
    expect(batch[0].eventType).toBe('test.event');
  });

  it('marks a claimed record published', async () => {
    const record = createOutboxRecord({
      aggregateType: 'booking',
      aggregateId: 'b-2',
      eventType: 'test.published',
      payload: {},
    });
    await store.add(record);
    const now = new Date();
    const [claimed] = await store.claimBatch({ batchSize: 1, now, leaseMs: 5000 });
    await store.markPublished(claimed.id, new Date());

    const none = await store.claimBatch({ batchSize: 10, now: new Date(), leaseMs: 5000 });
    expect(none.find((r) => r.id === claimed.id)).toBeUndefined();
  });

  it('commits the record atomically with the business state inside runInPgTransaction', async () => {
    const record = createOutboxRecord({
      aggregateType: 'booking',
      aggregateId: 'b-3',
      eventType: 'test.atomic',
      payload: {},
    });

    // Run add inside a transaction — both the record row and any other write
    // the caller makes commit together.
    await runInPgTransaction(pool, async (tx) => {
      await store.add(record, tx);
    });

    const now = new Date();
    const batch = await store.claimBatch({ batchSize: 10, now, leaseMs: 5000 });
    expect(batch.some((r) => r.id === record.id)).toBe(true);
  });

  it('rolls back: no outbox row when the surrounding transaction aborts', async () => {
    const record = createOutboxRecord({
      aggregateType: 'booking',
      aggregateId: 'b-4',
      eventType: 'test.rolled-back',
      payload: {},
    });

    await expect(
      runInPgTransaction(pool, async (tx) => {
        await store.add(record, tx);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    // The record must not appear — no phantom event.
    const now = new Date();
    const batch = await store.claimBatch({ batchSize: 50, now, leaseMs: 5000 });
    expect(batch.some((r) => r.id === record.id)).toBe(false);
  });

  it('SKIP LOCKED: concurrent relay claim does not double-claim', async () => {
    const record = createOutboxRecord({
      aggregateType: 'booking',
      aggregateId: 'b-5',
      eventType: 'test.skip-locked',
      payload: {},
    });
    await store.add(record);
    const now = new Date();

    // Two concurrent claims — only one should get the row.
    const [batch1, batch2] = await Promise.all([
      store.claimBatch({ batchSize: 1, now, leaseMs: 60_000 }),
      store.claimBatch({ batchSize: 1, now, leaseMs: 60_000 }),
    ]);

    const ids1 = batch1.map((r) => r.id);
    const ids2 = batch2.map((r) => r.id);
    // The same record must appear in at most one batch.
    const intersection = ids1.filter((id) => ids2.includes(id));
    expect(intersection).toHaveLength(0);
  });
});

(SKIP ? describe.skip : describe)('PostgresInboxStore — integration', () => {
  let pool: Pool;
  let schema: string;
  let store: PostgresInboxStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    schema = `test_inbox_${Date.now()}`;
    store = new PostgresInboxStore(pool, schema);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('processes a message exactly once', async () => {
    let calls = 0;
    const work = async (): Promise<void> => { calls++; };
    const key = { consumer: 'test-consumer', messageId: 'msg-1' };
    const opts = { now: new Date() };

    const first = await store.processOnce(key, work, opts);
    expect(first.duplicate).toBe(false);
    expect(calls).toBe(1);

    const second = await store.processOnce(key, work, opts);
    expect(second.duplicate).toBe(true);
    expect(calls).toBe(1);
  });

  it('rolls back the marker when the handler throws', async () => {
    const key = { consumer: 'test-consumer', messageId: 'msg-fail' };
    const opts = { now: new Date() };

    await expect(
      store.processOnce(key, async () => { throw new Error('handler error'); }, opts),
    ).rejects.toThrow('handler error');

    // Not yet seen — the marker rolled back with the handler.
    expect(await store.seen(key)).toBe(false);

    // A retry must be able to process it.
    let calls = 0;
    const retry = await store.processOnce(key, async () => { calls++; }, opts);
    expect(retry.duplicate).toBe(false);
    expect(calls).toBe(1);
  });
});
