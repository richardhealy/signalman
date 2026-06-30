/**
 * Postgres-backed {@link ConfirmationRepository} for the supplier service.
 *
 * The `supplier` schema holds a single `confirmations` table — one row per
 * booking. The row advances through its lifecycle in place (confirmed →
 * cancelled), matching how the in-memory repository models an upsert.
 *
 * `commit` accepts a {@link PgUnitOfWork} so its SQL write shares the same
 * transaction as the outbox row the caller stages alongside it — the
 * transactional-outbox guarantee.
 *
 * Call {@link PostgresConfirmationRepository.ensureSchema} once at service
 * startup (or in a migration) to create the table.
 */
import type { Pool } from 'pg';
import type { PgUnitOfWork } from '@signalman/outbox';
import type { UnitOfWork } from '@signalman/outbox';
import type { Confirmation } from './confirmation';
import type { ConfirmationRepository } from './confirmation-repository';

interface ConfirmationRow {
  id: string;
  booking_id: string;
  sku: string;
  qty: string | number;
  status: string;
  confirmation_id: string;
  created_at: Date;
  cancelled_at: Date | null;
}

function rowToConfirmation(row: ConfirmationRow): Confirmation {
  return {
    id: row.id,
    bookingId: row.booking_id,
    sku: row.sku,
    qty: Number(row.qty),
    status: row.status as Confirmation['status'],
    confirmationId: row.confirmation_id,
    createdAt: new Date(row.created_at),
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : undefined,
  };
}

export class PostgresConfirmationRepository implements ConfirmationRepository {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'supplier') {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Create the `confirmations` table (and schema) if they do not exist. Safe to
   * call on every startup — uses `IF NOT EXISTS` throughout.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".confirmations (
        id              UUID        PRIMARY KEY,
        booking_id      TEXT        NOT NULL UNIQUE,
        sku             TEXT        NOT NULL,
        qty             INTEGER     NOT NULL,
        status          TEXT        NOT NULL DEFAULT 'confirmed',
        confirmation_id TEXT        NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL,
        cancelled_at    TIMESTAMPTZ
      );
    `);
  }

  async findByBooking(bookingId: string): Promise<Confirmation | undefined> {
    const result = await this.pool.query<ConfirmationRow>(
      `SELECT * FROM "${this.schema}".confirmations WHERE booking_id = $1`,
      [bookingId],
    );
    return result.rows[0] ? rowToConfirmation(result.rows[0]) : undefined;
  }

  async commit(confirmation: Confirmation, tx?: UnitOfWork): Promise<void> {
    const sql = `
      INSERT INTO "${this.schema}".confirmations
        (id, booking_id, sku, qty, status, confirmation_id, created_at, cancelled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (booking_id) DO UPDATE SET
        status       = EXCLUDED.status,
        cancelled_at = EXCLUDED.cancelled_at
    `;
    const values = [
      confirmation.id,
      confirmation.bookingId,
      confirmation.sku,
      confirmation.qty,
      confirmation.status,
      confirmation.confirmationId,
      confirmation.createdAt,
      confirmation.cancelledAt ?? null,
    ];

    const client = (tx as PgUnitOfWork | undefined)?.client;
    if (client) {
      await client.query(sql, values);
    } else {
      await this.pool.query(sql, values);
    }
  }
}
