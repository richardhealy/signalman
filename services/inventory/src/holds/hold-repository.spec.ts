import { InMemoryHoldRepository } from './hold-repository';
import { type Hold } from './hold';

function heldHold(overrides: Partial<Hold> = {}): Hold {
  return {
    id: 'hold_1',
    bookingId: 'bk_1',
    sku: 'seat-A',
    qty: 2,
    status: 'held',
    createdAt: new Date('2026-06-28T00:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryHoldRepository', () => {
  describe('availableFor', () => {
    it('returns the seeded stock for a known SKU', async () => {
      const repo = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });
      await expect(repo.availableFor('seat-A')).resolves.toBe(10);
    });

    it('treats an unseeded SKU as having no stock', async () => {
      const repo = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });
      await expect(repo.availableFor('seat-Z')).resolves.toBe(0);
    });
  });

  describe('commitHold', () => {
    it('persists the hold and decrements the SKU availability by its qty', async () => {
      const repo = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });

      await repo.commitHold(heldHold({ qty: 3 }));

      await expect(repo.availableFor('seat-A')).resolves.toBe(7);
      await expect(repo.findByBooking('bk_1')).resolves.toMatchObject({
        id: 'hold_1',
        qty: 3,
        status: 'held',
      });
    });

    it('rejects a hold that would oversell the SKU', async () => {
      const repo = new InMemoryHoldRepository({ stock: { 'seat-A': 1 } });

      await expect(repo.commitHold(heldHold({ qty: 2 }))).rejects.toThrow(/oversell|stock/i);
      // The failed commit leaves both stock and holds untouched.
      await expect(repo.availableFor('seat-A')).resolves.toBe(1);
      await expect(repo.findByBooking('bk_1')).resolves.toBeUndefined();
    });
  });

  describe('commitRelease', () => {
    it('marks the hold released and restores its qty to availability', async () => {
      const repo = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });
      await repo.commitHold(heldHold({ qty: 4 }));

      const released: Hold = {
        ...heldHold({ qty: 4 }),
        status: 'released',
        releasedAt: new Date('2026-06-28T01:00:00Z'),
      };
      await repo.commitRelease(released);

      await expect(repo.availableFor('seat-A')).resolves.toBe(10);
      await expect(repo.findByBooking('bk_1')).resolves.toMatchObject({ status: 'released' });
    });
  });

  describe('isolation', () => {
    it('hands back copies so callers cannot mutate stored holds in place', async () => {
      const repo = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });
      await repo.commitHold(heldHold());

      const first = await repo.findByBooking('bk_1');
      (first as { qty: number }).qty = 999;

      await expect(repo.findByBooking('bk_1')).resolves.toMatchObject({ qty: 2 });
    });
  });
});
