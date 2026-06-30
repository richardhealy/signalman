/**
 * Postgres-backed {@link OutboxStore}.
 *
 * Implements the full outbox lifecycle — staging, claiming, publishing, and
 * dead-lettering — against a `{schema}.outbox_events` table. Every claim uses
 * `SELECT … FOR UPDATE SKIP LOCKED` so concurrent relay instances never
 * double-publish the same record: one wins the lock, the others skip that row
 * and claim their own batch. Leasing advances `available_at` so a relay that
 * crashes mid-publish surrenders the record once the lease expires, and the
 * next relay pass re-claims it (the at-least-once property that pairs with
 * idempotent consumers).
 *
 * Call {@link PostgresOutboxStore.ensureSchema} once at service startup (or in
 * a migration) to create the table and index.
 */
import type { Pool } from 'pg';
import type { BrokerHeaders } from '@signalman/propagation';
import type { OutboxRecord, OutboxStatus } from './record';
import type { ClaimOptions, MarkFailedOptions, OutboxStore } from './store';
import type { UnitOfWork } from './transaction';
import type { PgUnitOfWork } from './pg-transaction';

/** A row as `pg` returns it (snake_case, values untyped). */
interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  headers: unknown;
  status: string;
  attempts: number;
  created_at: Date;
  available_at: Date;
  published_at: Date | null;
  last_error: string | null;
}

function rowToRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    headers: (row.headers ?? {}) as BrokerHeaders,
    status: row.status as OutboxStatus,
    attempts: row.attempts,
    createdAt: new Date(row.created_at),
    availableAt: new Date(row.available_at),
    publishedAt: row.published_at ? new Date(row.published_at) : undefined,
    lastError: row.last_error ?? undefined,
  };
}

export class PostgresOutboxStore implements OutboxStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'public') {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Create the outbox table (and schema) if they do not exist. Safe to call
   * on every startup — uses `IF NOT EXISTS` throughout.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".outbox_events (
        id             UUID        PRIMARY KEY,
        aggregate_type TEXT        NOT NULL,
        aggregate_id   TEXT        NOT NULL,
        event_type     TEXT        NOT NULL,
        payload        JSONB       NOT NULL,
        headers        JSONB       NOT NULL DEFAULT '{}',
        status         TEXT        NOT NULL DEFAULT 'pending',
        attempts       INTEGER     NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL,
        available_at   TIMESTAMPTZ NOT NULL,
        published_at   TIMESTAMPTZ,
        last_error     TEXT
      );

      CREATE INDEX IF NOT EXISTS "${this.schema}_outbox_pending_idx"
        ON "${this.schema}".outbox_events (available_at)
        WHERE status = 'pending';
    `);
  }

  async add(record: OutboxRecord, tx?: UnitOfWork): Promise<void> {
    const sql = `
      INSERT INTO "${this.schema}".outbox_events
        (id, aggregate_type, aggregate_id, event_type, payload, headers,
         status, attempts, created_at, available_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
    `;
    const values = [
      record.id,
      record.aggregateType,
      record.aggregateId,
      record.eventType,
      JSON.stringify(record.payload),
      JSON.stringify(record.headers),
      record.status,
      record.attempts,
      record.createdAt,
      record.availableAt,
    ];

    const client = (tx as PgUnitOfWork | undefined)?.client;
    if (client) {
      await client.query(sql, values);
    } else {
      await this.pool.query(sql, values);
    }
  }

  async claimBatch({ batchSize, now, leaseMs }: ClaimOptions): Promise<OutboxRecord[]> {
    if (batchSize <= 0) return [];
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await this.pool.query<OutboxRow>(
      `UPDATE "${this.schema}".outbox_events
       SET    available_at = $1
       WHERE  id IN (
         SELECT id
         FROM   "${this.schema}".outbox_events
         WHERE  status = 'pending'
           AND  available_at <= $2
         ORDER  BY created_at, id
         LIMIT  $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [leaseUntil, now, batchSize],
    );
    return result.rows.map(rowToRecord);
  }

  async markPublished(id: string, publishedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE "${this.schema}".outbox_events
       SET status = 'published', published_at = $1
       WHERE id = $2`,
      [publishedAt, id],
    );
  }

  async markFailed(id: string, options: MarkFailedOptions): Promise<void> {
    if (options.dead) {
      await this.pool.query(
        `UPDATE "${this.schema}".outbox_events
         SET status = 'failed', attempts = $1, last_error = $2
         WHERE id = $3`,
        [options.attempts, options.error, id],
      );
    } else {
      await this.pool.query(
        `UPDATE "${this.schema}".outbox_events
         SET status = 'pending', attempts = $1, last_error = $2, available_at = $3
         WHERE id = $4`,
        [options.attempts, options.error, options.availableAt ?? now(), id],
      );
    }
  }
}

function now(): Date {
  return new Date();
}
