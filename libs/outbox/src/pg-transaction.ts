/**
 * Postgres-backed unit of work for the transactional outbox.
 *
 * Wraps a `pg.PoolClient` mid-transaction so that a service's business-state
 * write and the outbox row it accompanies share one database transaction —
 * exactly what the in-memory {@link UnitOfWork} models, but now with a real
 * database. Both writes see the same connection in flight; either both land on
 * `COMMIT` or neither does on `ROLLBACK`.
 *
 * Usage:
 * ```ts
 * await runInPgTransaction(pool, async (tx) => {
 *   await holdRepo.commitHold(hold, tx);   // runs SQL against tx.client
 *   await outboxStore.add(record, tx);     // runs SQL against tx.client
 * });
 * ```
 */
import type { Pool, PoolClient } from 'pg';
import type { UnitOfWork } from './transaction';

/**
 * A Postgres-backed unit of work: a pool client mid-transaction. Extends
 * {@link UnitOfWork} so it satisfies the same contract that
 * {@link OutboxStore.add} and domain repositories accept — callers that handle
 * either variant just see a `UnitOfWork`; callers that need the client cast to
 * this type.
 */
export interface PgUnitOfWork extends UnitOfWork {
  /** The pool client running in an open transaction. Run SQL against this. */
  readonly client: PoolClient;
}

/**
 * Run `work` inside a single Postgres transaction: `BEGIN` on entry, `COMMIT`
 * on success, `ROLLBACK` on any throw. The pool client is exposed as
 * `PgUnitOfWork.client` throughout `work` so stores write their SQL inside the
 * same transaction — that shared commit is the transactional-outbox guarantee.
 */
export async function runInPgTransaction<T>(
  pool: Pool,
  work: (tx: PgUnitOfWork) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Postgres stores write SQL directly against `client` during `work`.
    // The `defer` method is a no-op: there are no deferred in-memory mutations
    // here — the database transaction handles atomicity at the COMMIT boundary.
    const tx: PgUnitOfWork = { client, defer: () => {} };
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
