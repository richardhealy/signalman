import { type BookingRecord } from './booking';
import { InMemoryBookingStore } from './booking-store';

function record(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    bookingId: 'bk_1',
    status: 'booked',
    request: { sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' },
    traceId: '0af7651916cd43dd8448eb211c80319c',
    recordedAt: '2026-06-29T00:00:00.000Z',
    holdId: 'hold_1',
    ...overrides,
  };
}

describe('InMemoryBookingStore', () => {
  it('returns undefined for a booking it has never seen', async () => {
    const store = new InMemoryBookingStore();

    expect(await store.get('bk_unknown')).toBeUndefined();
  });

  it('saves and reads back a record by booking id', async () => {
    const store = new InMemoryBookingStore();
    const saved = record();

    await store.save(saved);

    expect(await store.get('bk_1')).toEqual(saved);
  });

  it('overwrites last-wins on a re-save for the same booking id', async () => {
    const store = new InMemoryBookingStore();

    await store.save(record({ status: 'failed', failedStep: 'supplier.confirm' }));
    await store.save(record({ status: 'booked', holdId: 'hold_2' }));

    const got = await store.get('bk_1');
    expect(got?.status).toBe('booked');
    expect(got?.holdId).toBe('hold_2');
  });
});
