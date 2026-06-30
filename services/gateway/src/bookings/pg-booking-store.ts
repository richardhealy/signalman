/**
 * Postgres-backed {@link BookingStore} for the gateway service.
 *
 * One table lives in the `gateway` schema:
 *
 * - `bookings` — one row per booking id, storing the outcome of the latest
 *   saga attempt as a JSONB blob. An upsert on `booking_id` is last-wins:
 *   a retried `Book` records its latest outcome over the previous one.
 *
 * Call {@link PostgresBookingStore.ensureSchema} once at service startup
 * to create the table (safe to re-call — uses `IF NOT EXISTS`).
 */
import type { Pool } from 'pg';
import type { BookingRecord } from './booking';
import type { BookingStore } from './booking-store';

export class PostgresBookingStore implements BookingStore {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'gateway') {
    this.pool = pool;
    this.schema = schema;
  }

  /** Create the `bookings` table (and schema) if they do not exist. */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".bookings (
        booking_id  TEXT        PRIMARY KEY,
        record      JSONB       NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async save(record: BookingRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO "${this.schema}".bookings (booking_id, record, recorded_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (booking_id) DO UPDATE SET
         record      = EXCLUDED.record,
         recorded_at = EXCLUDED.recorded_at`,
      [record.bookingId, JSON.stringify(record)],
    );
  }

  async get(bookingId: string): Promise<BookingRecord | undefined> {
    const result = await this.pool.query<{ record: BookingRecord }>(
      `SELECT record FROM "${this.schema}".bookings WHERE booking_id = $1`,
      [bookingId],
    );
    return result.rows[0]?.record;
  }
}
