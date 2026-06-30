/**
 * Postgres-backed {@link InboxStore}.
 *
 * Provides at-most-once processing by recording a `(consumer, message_id)`
 * marker in the same Postgres transaction as the handler's side effects.
 * The unique constraint on `(consumer, message_id)` makes the dedup race-free:
 * even if two deliveries of the same message arrive concurrently, only one can
 * insert the marker; the other's `INSERT … ON CONFLICT DO NOTHING` records
 * zero rows, and the store returns `{ duplicate: true }` without running the
 * handler a second time.
 *
 * Call {@link PostgresInboxStore.ensureSchema} once at service startup (or in
 * a migration) to create the table.
 */
import type { Pool, PoolClient } from 'pg';
import type { InboxKey } from './record';
import type { InboxOutcome, InboxStore, ProcessOnceOptions } from './store';

export class PostgresInboxStore implements InboxStore<PoolClient> {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'public') {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Create the inbox table (and schema) if they do not exist. Safe to call
   * on every startup — uses `IF NOT EXISTS` throughout.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".inbox_markers (
        consumer   TEXT        NOT NULL,
        message_id TEXT        NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (consumer, message_id)
      );
    `);
  }

  async processOnce<T>(
    key: InboxKey,
    work: (tx: PoolClient) => Promise<T>,
    options: ProcessOnceOptions,
  ): Promise<InboxOutcome<T>> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Attempt to claim the dedup marker atomically. A conflict means we have
      // already processed this message; skip the handler.
      const claim = await client.query(
        `INSERT INTO "${this.schema}".inbox_markers (consumer, message_id, processed_at)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [key.consumer, key.messageId, options.now],
      );

      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return { duplicate: true };
      }

      // Run the handler with the in-transaction client so its writes share the
      // same transaction as the marker — both commit together or both roll back.
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return { duplicate: false, result };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async seen(key: InboxKey): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM "${this.schema}".inbox_markers WHERE consumer = $1 AND message_id = $2`,
      [key.consumer, key.messageId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
