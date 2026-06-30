/**
 * Postgres-backed {@link BookingStore} for the gateway service.
 *
 * The `gateway` schema holds a single `bookings` table — one row per booking id.
 * On a retry the row is overwritten (last-wins), matching the in-memory store's
 * semantics: an operator always sees the latest outcome.
 *
 * The gateway does not participate in transactional outbox (it records outcomes,
 * not events), so writes go directly through the pool — no {@link PgUnitOfWork}
 * is needed here.
 *
 * Call {@link PostgresBookingStore.ensureSchema} once at service startup (or in
 * a migration) to create the table.
 */
import type { Pool } from 'pg';
import type { BookingRecord } from './booking';
import type { BookingStore } from './booking-store';

interface BookingRow {
  booking_id: string;
  status: string;
  sku: string;
  qty: number;
  amount: string | number;
  currency: string;
  trace_id: string;
  recorded_at: string;
  hold_id: string | null;
  authorization_id: string | null;
  confirmation_id: string | null;
  capture_id: string | null;
  entry_id: string | null;
  failed_step: string | null;
  reason: string | null;
  compensated: boolean | null;
}

function rowToRecord(row: BookingRow): BookingRecord {
  return {
    bookingId: row.booking_id,
    status: row.status as BookingRecord['status'],
    request: {
      sku: row.sku,
      qty: row.qty,
      amount: Number(row.amount),
      currency: row.currency,
    },
    traceId: row.trace_id,
    recordedAt: row.recorded_at,
    holdId: row.hold_id ?? undefined,
    authorizationId: row.authorization_id ?? undefined,
    confirmationId: row.confirmation_id ?? undefined,
    captureId: row.capture_id ?? undefined,
    entryId: row.entry_id ?? undefined,
    failedStep: row.failed_step ?? undefined,
    reason: row.reason ?? undefined,
    compensated: row.compensated ?? undefined,
  };
}

export class PostgresBookingStore implements BookingStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'gateway') {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Create the `bookings` table (and schema) if they do not exist. Safe to call
   * on every startup — uses `IF NOT EXISTS` throughout.
   */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".bookings (
        booking_id       TEXT        PRIMARY KEY,
        status           TEXT        NOT NULL,
        sku              TEXT        NOT NULL,
        qty              INT         NOT NULL,
        amount           BIGINT      NOT NULL,
        currency         TEXT        NOT NULL,
        trace_id         TEXT        NOT NULL,
        recorded_at      TEXT        NOT NULL,
        hold_id          TEXT,
        authorization_id TEXT,
        confirmation_id  TEXT,
        capture_id       TEXT,
        entry_id         TEXT,
        failed_step      TEXT,
        reason           TEXT,
        compensated      BOOLEAN
      );
    `);
  }

  async get(bookingId: string): Promise<BookingRecord | undefined> {
    const result = await this.pool.query<BookingRow>(
      `SELECT * FROM "${this.schema}".bookings WHERE booking_id = $1`,
      [bookingId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
  }

  async save(record: BookingRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO "${this.schema}".bookings
        (booking_id, status, sku, qty, amount, currency, trace_id, recorded_at,
         hold_id, authorization_id, confirmation_id, capture_id, entry_id,
         failed_step, reason, compensated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (booking_id) DO UPDATE SET
        status           = EXCLUDED.status,
        sku              = EXCLUDED.sku,
        qty              = EXCLUDED.qty,
        amount           = EXCLUDED.amount,
        currency         = EXCLUDED.currency,
        trace_id         = EXCLUDED.trace_id,
        recorded_at      = EXCLUDED.recorded_at,
        hold_id          = EXCLUDED.hold_id,
        authorization_id = EXCLUDED.authorization_id,
        confirmation_id  = EXCLUDED.confirmation_id,
        capture_id       = EXCLUDED.capture_id,
        entry_id         = EXCLUDED.entry_id,
        failed_step      = EXCLUDED.failed_step,
        reason           = EXCLUDED.reason,
        compensated      = EXCLUDED.compensated
      `,
      [
        record.bookingId,
        record.status,
        record.request.sku,
        record.request.qty,
        record.request.amount,
        record.request.currency,
        record.traceId,
        record.recordedAt,
        record.holdId ?? null,
        record.authorizationId ?? null,
        record.confirmationId ?? null,
        record.captureId ?? null,
        record.entryId ?? null,
        record.failedStep ?? null,
        record.reason ?? null,
        record.compensated ?? null,
      ],
    );
  }
}
