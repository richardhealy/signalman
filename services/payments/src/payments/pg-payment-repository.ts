/**
 * Postgres-backed {@link PaymentRepository} for the payments service.
 *
 * One table lives in the `payments` schema:
 *
 * - `payments` — one row per booking's payment lifecycle (authorized → captured
 *   or voided). An upsert on `booking_id` advances the row through its lifecycle
 *   in place, mirroring what the in-memory reference does with a Map entry.
 *
 * `commit` accepts a {@link PgUnitOfWork} so its SQL write shares the same
 * transaction as the outbox row the caller stages alongside it — the
 * transactional-outbox guarantee.
 *
 * Call {@link PostgresPaymentRepository.ensureSchema} once at service startup
 * to create the table (safe to re-call — uses `IF NOT EXISTS`).
 */
import type { Pool } from 'pg';
import type { PgUnitOfWork } from '@signalman/outbox';
import type { UnitOfWork } from '@signalman/outbox';
import type { Payment } from './payment';
import type { PaymentRepository } from './payment-repository';

interface PaymentRow {
  id: string;
  booking_id: string;
  amount: string;
  currency: string;
  status: string;
  authorization_id: string;
  capture_id: string | null;
  created_at: Date;
  captured_at: Date | null;
  voided_at: Date | null;
}

function rowToPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    bookingId: row.booking_id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status as Payment['status'],
    authorizationId: row.authorization_id,
    captureId: row.capture_id ?? undefined,
    createdAt: new Date(row.created_at),
    capturedAt: row.captured_at ? new Date(row.captured_at) : undefined,
    voidedAt: row.voided_at ? new Date(row.voided_at) : undefined,
  };
}

export class PostgresPaymentRepository implements PaymentRepository {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'payments') {
    this.pool = pool;
    this.schema = schema;
  }

  /** Create the `payments` table (and schema) if they do not exist. */
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".payments (
        id               UUID        PRIMARY KEY,
        booking_id       TEXT        NOT NULL UNIQUE,
        amount           BIGINT      NOT NULL,
        currency         TEXT        NOT NULL,
        status           TEXT        NOT NULL DEFAULT 'authorized',
        authorization_id TEXT        NOT NULL,
        capture_id       TEXT,
        created_at       TIMESTAMPTZ NOT NULL,
        captured_at      TIMESTAMPTZ,
        voided_at        TIMESTAMPTZ
      );
    `);
  }

  async findByBooking(bookingId: string): Promise<Payment | undefined> {
    const result = await this.pool.query<PaymentRow>(
      `SELECT * FROM "${this.schema}".payments WHERE booking_id = $1`,
      [bookingId],
    );
    return result.rows[0] ? rowToPayment(result.rows[0]) : undefined;
  }

  async commit(payment: Payment, tx?: UnitOfWork): Promise<void> {
    const sql = `
      INSERT INTO "${this.schema}".payments
        (id, booking_id, amount, currency, status, authorization_id, capture_id,
         created_at, captured_at, voided_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (booking_id) DO UPDATE SET
        status           = EXCLUDED.status,
        capture_id       = EXCLUDED.capture_id,
        captured_at      = EXCLUDED.captured_at,
        voided_at        = EXCLUDED.voided_at
    `;
    const values = [
      payment.id,
      payment.bookingId,
      payment.amount,
      payment.currency,
      payment.status,
      payment.authorizationId,
      payment.captureId ?? null,
      payment.createdAt,
      payment.capturedAt ?? null,
      payment.voidedAt ?? null,
    ];

    const client = (tx as PgUnitOfWork | undefined)?.client;
    if (client) {
      await client.query(sql, values);
    } else {
      await this.pool.query(sql, values);
    }
  }
}
