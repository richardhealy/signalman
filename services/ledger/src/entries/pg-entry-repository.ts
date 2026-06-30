/**
 * Postgres-backed {@link LedgerRepository} for the ledger service.
 *
 * The `ledger` schema holds a single `entries` table — one row per booking.
 * The row advances through its lifecycle in place (committed → reversed),
 * matching how the in-memory repository models an upsert.
 *
 * `commit` accepts a {@link PgUnitOfWork} so its SQL write shares the same
 * transaction as the outbox row the caller stages alongside it — the
 * transactional-outbox guarantee.
 *
 * Call {@link PostgresLedgerRepository.ensureSchema} once at service startup
 * (or in a migration) to create the table.
 */
import type { Pool } from 'pg';
import type { PgUnitOfWork } from '@signalman/outbox';
import type { UnitOfWork } from '@signalman/outbox';
import type { LedgerEntry } from './entry';
import type { LedgerRepository } from './entry-repository';

interface EntryRow {
  id: string;
  booking_id: string;
  amount: string | number;
  currency: string;
  status: string;
  capture_id: string;
  committed_at: Date;
  reversed_at: Date | null;
}

function rowToEntry(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    bookingId: row.booking_id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status as LedgerEntry['status'],
    captureId: row.capture_id,
    committedAt: new Date(row.committed_at),
    reversedAt: row.reversed_at ? new Date(row.reversed_at) : undefined,
  };
}

export class PostgresLedgerRepository implements LedgerRepository {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'ledger') {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Create the `entries` table (and schema) if they do not exist. Safe to call
   * on every startup — uses `IF NOT EXISTS` throughout.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".entries (
        id           UUID        PRIMARY KEY,
        booking_id   TEXT        NOT NULL UNIQUE,
        amount       BIGINT      NOT NULL,
        currency     TEXT        NOT NULL,
        status       TEXT        NOT NULL DEFAULT 'committed',
        capture_id   TEXT        NOT NULL DEFAULT '',
        committed_at TIMESTAMPTZ NOT NULL,
        reversed_at  TIMESTAMPTZ
      );
    `);
  }

  async findByBooking(bookingId: string): Promise<LedgerEntry | undefined> {
    const result = await this.pool.query<EntryRow>(
      `SELECT * FROM "${this.schema}".entries WHERE booking_id = $1`,
      [bookingId],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
  }

  async commit(entry: LedgerEntry, tx?: UnitOfWork): Promise<void> {
    const sql = `
      INSERT INTO "${this.schema}".entries
        (id, booking_id, amount, currency, status, capture_id, committed_at, reversed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (booking_id) DO UPDATE SET
        status      = EXCLUDED.status,
        reversed_at = EXCLUDED.reversed_at
    `;
    const values = [
      entry.id,
      entry.bookingId,
      entry.amount,
      entry.currency,
      entry.status,
      entry.captureId,
      entry.committedAt,
      entry.reversedAt ?? null,
    ];

    const client = (tx as PgUnitOfWork | undefined)?.client;
    if (client) {
      await client.query(sql, values);
    } else {
      await this.pool.query(sql, values);
    }
  }
}
