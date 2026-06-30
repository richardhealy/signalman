/**
 * End-to-end verification of {@link PostgresBookingStore} against a *live*
 * Postgres instance. Gated behind `POSTGRES_TEST_URL`, so the default
 * `npm test` (and CI, which has no database) skips it and stays green:
 *
 *   docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   POSTGRES_TEST_URL="postgresql://postgres:test@localhost:5432/postgres" npm test -- pg-booking-store.integration
 *
 * Each test run uses a unique schema name derived from the test start time, so
 * cases are isolated from one another and safe to re-run without a clean DB.
 */

const TEST_URL = process.env.POSTGRES_TEST_URL;
const SKIP = !TEST_URL;

import { Pool } from 'pg';
import { PostgresBookingStore } from './pg-booking-store';
import type { BookingRecord } from './booking';

function makeRecord(override: Partial<BookingRecord> = {}): BookingRecord {
  return {
    bookingId: 'b-test-1',
    status: 'booked',
    request: { sku: 'seat-economy', qty: 2, amount: 19900, currency: 'USD' },
    traceId: 'abc123',
    recordedAt: new Date().toISOString(),
    holdId: 'hold-1',
    authorizationId: 'auth-1',
    confirmationId: 'conf-1',
    captureId: 'cap-1',
    entryId: 'entry-1',
    ...override,
  };
}

(SKIP ? describe.skip : describe)('PostgresBookingStore — integration', () => {
  let pool: Pool;
  let schema: string;
  let store: PostgresBookingStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_URL });
    schema = `test_gateway_${Date.now()}`;
    store = new PostgresBookingStore(pool, schema);
    await store.ensureSchema();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('saves a booked record and retrieves it by booking id', async () => {
    const record = makeRecord({ bookingId: 'b-pg-1' });
    await store.save(record);

    const found = await store.get('b-pg-1');
    expect(found).toBeDefined();
    expect(found!.bookingId).toBe('b-pg-1');
    expect(found!.status).toBe('booked');
    expect(found!.request.sku).toBe('seat-economy');
    expect(found!.request.qty).toBe(2);
    expect(found!.request.amount).toBe(19900);
    expect(found!.request.currency).toBe('USD');
    expect(found!.traceId).toBe('abc123');
    expect(found!.holdId).toBe('hold-1');
    expect(found!.authorizationId).toBe('auth-1');
    expect(found!.confirmationId).toBe('conf-1');
    expect(found!.captureId).toBe('cap-1');
    expect(found!.entryId).toBe('entry-1');
  });

  it('saves a failed record with optional failure fields', async () => {
    const record = makeRecord({
      bookingId: 'b-pg-2',
      status: 'failed',
      holdId: undefined,
      authorizationId: undefined,
      confirmationId: undefined,
      captureId: undefined,
      entryId: undefined,
      failedStep: 'supplier.confirm',
      reason: 'partner_rejected',
      compensated: true,
    });
    await store.save(record);

    const found = await store.get('b-pg-2');
    expect(found).toBeDefined();
    expect(found!.status).toBe('failed');
    expect(found!.failedStep).toBe('supplier.confirm');
    expect(found!.reason).toBe('partner_rejected');
    expect(found!.compensated).toBe(true);
    expect(found!.holdId).toBeUndefined();
  });

  it('returns undefined for an unknown booking id', async () => {
    const result = await store.get('b-unknown-99');
    expect(result).toBeUndefined();
  });

  it('overwrites an existing record on re-save (last-wins)', async () => {
    const first = makeRecord({
      bookingId: 'b-pg-3',
      status: 'failed',
      failedStep: 'inventory.hold',
      reason: 'no_availability',
      compensated: false,
      holdId: undefined,
      authorizationId: undefined,
      confirmationId: undefined,
      captureId: undefined,
      entryId: undefined,
    });
    await store.save(first);

    const updated = makeRecord({ bookingId: 'b-pg-3', status: 'booked' });
    await store.save(updated);

    const found = await store.get('b-pg-3');
    expect(found!.status).toBe('booked');
    expect(found!.failedStep).toBeUndefined();
    expect(found!.holdId).toBe('hold-1');
  });
});
