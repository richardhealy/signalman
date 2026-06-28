import { InMemoryOutboxStore } from '@signalman/outbox';
import { InMemoryHoldRepository } from './hold-repository';
import { InventoryService } from './inventory.service';

function makeService(stock: Record<string, number> = { 'seat-A': 10 }) {
  const holds = new InMemoryHoldRepository({ stock });
  const outbox = new InMemoryOutboxStore();
  let seq = 0;
  const service = new InventoryService({
    holds,
    outbox,
    idFactory: () => `hold_${++seq}`,
    clock: () => new Date('2026-06-28T00:00:00Z'),
  });
  return { service, holds, outbox };
}

describe('InventoryService', () => {
  describe('hold', () => {
    it('reserves stock, persists the hold, and stages an inventory.held event', async () => {
      const { service, holds, outbox } = makeService({ 'seat-A': 10 });

      const outcome = await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 3 });

      expect(outcome).toEqual({ held: true, holdId: 'hold_1', available: 7 });
      await expect(holds.availableFor('seat-A')).resolves.toBe(7);

      const staged = outbox.all();
      expect(staged).toHaveLength(1);
      expect(staged[0]).toMatchObject({
        eventType: 'inventory.held',
        aggregateType: 'hold',
        aggregateId: 'hold_1',
        payload: { bookingId: 'bk_1', sku: 'seat-A', qty: 3 },
      });
    });

    it('is idempotent per booking: a repeat hold returns the existing hold without double-reserving', async () => {
      const { service, holds, outbox } = makeService({ 'seat-A': 10 });

      const first = await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 3 });
      const second = await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 3 });

      expect(second).toEqual(first);
      await expect(holds.availableFor('seat-A')).resolves.toBe(7); // drawn down once, not twice
      expect(outbox.all()).toHaveLength(1); // one event, not two
    });

    it('rejects when stock is insufficient, changing nothing and staging no event', async () => {
      const { service, holds, outbox } = makeService({ 'seat-A': 1 });

      const outcome = await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 2 });

      expect(outcome).toEqual({ held: false, reason: 'insufficient_stock', available: 1 });
      await expect(holds.availableFor('seat-A')).resolves.toBe(1);
      await expect(holds.findByBooking('bk_1')).resolves.toBeUndefined();
      expect(outbox.all()).toHaveLength(0);
    });

    it('stamps the hold with the injected id and clock', async () => {
      const { service, holds } = makeService();

      await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 1 });

      await expect(holds.findByBooking('bk_1')).resolves.toMatchObject({
        id: 'hold_1',
        status: 'held',
        createdAt: new Date('2026-06-28T00:00:00Z'),
      });
    });
  });

  describe('release', () => {
    it('releases a standing hold, restores stock, and stages an inventory.released event', async () => {
      const { service, holds, outbox } = makeService({ 'seat-A': 10 });
      await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 4 });

      const outcome = await service.release({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ released: true, holdId: 'hold_1' });
      await expect(holds.availableFor('seat-A')).resolves.toBe(10);
      await expect(holds.findByBooking('bk_1')).resolves.toMatchObject({ status: 'released' });

      const releaseEvents = outbox.all().filter((r) => r.eventType === 'inventory.released');
      expect(releaseEvents).toHaveLength(1);
      expect(releaseEvents[0]).toMatchObject({
        aggregateId: 'hold_1',
        payload: { bookingId: 'bk_1', sku: 'seat-A', qty: 4 },
      });
    });

    it('is idempotent: releasing an already-released hold restores stock once and stages no second event', async () => {
      const { service, holds, outbox } = makeService({ 'seat-A': 10 });
      await service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 4 });
      await service.release({ bookingId: 'bk_1' });

      const outcome = await service.release({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ released: true, holdId: 'hold_1' });
      await expect(holds.availableFor('seat-A')).resolves.toBe(10); // not over-restored to 14
      expect(outbox.all().filter((r) => r.eventType === 'inventory.released')).toHaveLength(1);
    });

    it('treats releasing an unknown booking as a successful no-op', async () => {
      const { service, outbox } = makeService();

      const outcome = await service.release({ bookingId: 'ghost' });

      expect(outcome).toEqual({ released: true, holdId: '' });
      expect(outbox.all()).toHaveLength(0);
    });
  });

  describe('transactional staging', () => {
    // The state change and its event share one unit of work: if the outbox write
    // fails, the hold must roll back with it — no state without its event.
    class ExplodingOutboxStore extends InMemoryOutboxStore {
      override async add(): Promise<void> {
        throw new Error('outbox write failed');
      }
    }

    it('rolls the hold back when staging its event fails — no state, no event', async () => {
      const holds = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });
      const outbox = new ExplodingOutboxStore();
      const service = new InventoryService({ holds, outbox, idFactory: () => 'hold_1' });

      await expect(service.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 3 })).rejects.toThrow(
        'outbox write failed',
      );

      // The hold never persisted and the stock was never drawn down.
      await expect(holds.findByBooking('bk_1')).resolves.toBeUndefined();
      await expect(holds.availableFor('seat-A')).resolves.toBe(10);
      expect(outbox.all()).toHaveLength(0);
    });

    it('rolls the release back when staging its event fails — stock not restored twice', async () => {
      const holds = new InMemoryHoldRepository({ stock: { 'seat-A': 10 } });
      const good = new InventoryService({ holds, outbox: new InMemoryOutboxStore(), idFactory: () => 'hold_1' });
      await good.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 3 });

      const service = new InventoryService({ holds, outbox: new ExplodingOutboxStore() });
      await expect(service.release({ bookingId: 'bk_1' })).rejects.toThrow('outbox write failed');

      // Still held: the release neither flipped the status nor returned the stock.
      await expect(holds.findByBooking('bk_1')).resolves.toMatchObject({ status: 'held' });
      await expect(holds.availableFor('seat-A')).resolves.toBe(7);
    });
  });
});
