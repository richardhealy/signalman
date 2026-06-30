/**
 * Postgres-backed {@link HoldRepository} for the inventory service.
 *
 * Two tables live in the `inventory` schema:
 *
 * - `holds` — one row per booking reservation; the primary source of truth.
 * - `stock` — one row per SKU tracking the current available quantity.
 *
 * The oversell guard uses `SELECT … FOR UPDATE` on the stock row so that a
 * concurrent `commitHold` for the same SKU blocks rather than racing — only one
 * wins the row lock, checks availability, and either commits or rolls back.
 *
 * Both `commitHold` and `commitRelease` accept a {@link PgUnitOfWork} so their
 * SQL writes share the same transaction as the outbox row the caller stages
 * alongside them — the transactional-outbox guarantee.
 *
 * Call {@link PostgresHoldRepository.ensureSchema} once at service startup (or
 * in a migration) to create the tables and seed the starting stock.
 */
import type { Pool } from 'pg';
import type { PgUnitOfWork } from '@signalman/outbox';
import type { UnitOfWork } from '@signalman/outbox';
import type { Hold } from './hold';
import type { HoldRepository } from './hold-repository';

interface HoldRow {
  id: string;
  booking_id: string;
  sku: string;
  qty: number;
  status: string;
  created_at: Date;
  released_at: Date | null;
}

function rowToHold(row: HoldRow): Hold {
  return {
    id: row.id,
    bookingId: row.booking_id,
    sku: row.sku,
    qty: Number(row.qty),
    status: row.status as Hold['status'],
    createdAt: new Date(row.created_at),
    releasedAt: row.released_at ? new Date(row.released_at) : undefined,
  };
}

export class PostgresHoldRepository implements HoldRepository {
  private readonly pool: Pool;
  private readonly schema: string;

  constructor(pool: Pool, schema: string = 'inventory') {
    this.pool = pool;
    this.schema = schema;
  }

  /**
   * Create the `holds` and `stock` tables (and schema) if they do not exist.
   * Seeds initial SKU stock from `initialStock` on first run.
   */
  async ensureSchema(initialStock: Record<string, number> = {}): Promise<void> {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS "${this.schema}";

      CREATE TABLE IF NOT EXISTS "${this.schema}".holds (
        id          UUID        PRIMARY KEY,
        booking_id  TEXT        NOT NULL UNIQUE,
        sku         TEXT        NOT NULL,
        qty         INTEGER     NOT NULL,
        status      TEXT        NOT NULL DEFAULT 'held',
        created_at  TIMESTAMPTZ NOT NULL,
        released_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS "${this.schema}".stock (
        sku       TEXT    PRIMARY KEY,
        available INTEGER NOT NULL DEFAULT 0
      );
    `);

    for (const [sku, qty] of Object.entries(initialStock)) {
      await this.pool.query(
        `INSERT INTO "${this.schema}".stock (sku, available)
         VALUES ($1, $2)
         ON CONFLICT (sku) DO NOTHING`,
        [sku, qty],
      );
    }
  }

  async findByBooking(bookingId: string): Promise<Hold | undefined> {
    const result = await this.pool.query<HoldRow>(
      `SELECT * FROM "${this.schema}".holds WHERE booking_id = $1`,
      [bookingId],
    );
    return result.rows[0] ? rowToHold(result.rows[0]) : undefined;
  }

  async availableFor(sku: string): Promise<number> {
    const result = await this.pool.query<{ available: number }>(
      `SELECT available FROM "${this.schema}".stock WHERE sku = $1`,
      [sku],
    );
    return result.rows[0] ? Number(result.rows[0].available) : 0;
  }

  async commitHold(hold: Hold, tx?: UnitOfWork): Promise<void> {
    const client = (tx as PgUnitOfWork | undefined)?.client ?? (await this.pool.connect());
    const borrowed = !(tx as PgUnitOfWork | undefined)?.client;
    try {
      // Lock the stock row so concurrent holds for the same SKU serialise here.
      const stockResult = await client.query<{ available: number }>(
        `SELECT available FROM "${this.schema}".stock WHERE sku = $1 FOR UPDATE`,
        [hold.sku],
      );
      const available = stockResult.rows[0] ? Number(stockResult.rows[0].available) : 0;
      if (hold.qty > available) {
        throw new Error(
          `cannot hold ${hold.qty} of ${hold.sku}: would oversell (available ${available})`,
        );
      }

      await client.query(
        `INSERT INTO "${this.schema}".holds
           (id, booking_id, sku, qty, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (booking_id) DO NOTHING`,
        [hold.id, hold.bookingId, hold.sku, hold.qty, hold.status, hold.createdAt],
      );

      await client.query(
        `UPDATE "${this.schema}".stock SET available = available - $1 WHERE sku = $2`,
        [hold.qty, hold.sku],
      );
    } finally {
      if (borrowed) (client as { release?: () => void }).release?.();
    }
  }

  async commitRelease(hold: Hold, tx?: UnitOfWork): Promise<void> {
    const client = (tx as PgUnitOfWork | undefined)?.client ?? (await this.pool.connect());
    const borrowed = !(tx as PgUnitOfWork | undefined)?.client;
    try {
      await client.query(
        `UPDATE "${this.schema}".holds
         SET status = $1, released_at = $2
         WHERE booking_id = $3`,
        [hold.status, hold.releasedAt ?? null, hold.bookingId],
      );

      await client.query(
        `UPDATE "${this.schema}".stock SET available = available + $1 WHERE sku = $2`,
        [hold.qty, hold.sku],
      );
    } finally {
      if (borrowed) (client as { release?: () => void }).release?.();
    }
  }
}
