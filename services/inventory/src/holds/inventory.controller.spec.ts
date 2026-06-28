import { InMemoryOutboxStore } from '@signalman/outbox';
import { InMemoryHoldRepository } from './hold-repository';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';

function makeController(stock: Record<string, number> = { 'seat-A': 10 }) {
  const holds = new InMemoryHoldRepository({ stock });
  const outbox = new InMemoryOutboxStore();
  let seq = 0;
  const service = new InventoryService({ holds, outbox, idFactory: () => `hold_${++seq}` });
  return { controller: new InventoryController(service), holds, outbox };
}

describe('InventoryController', () => {
  describe('Hold', () => {
    it('maps a granted hold onto a full HoldReply', async () => {
      const { controller } = makeController({ 'seat-A': 10 });

      const reply = await controller.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 3 });

      expect(reply).toEqual({ held: true, holdId: 'hold_1', reason: '', available: 7 });
    });

    it('maps a rejected hold onto a reply carrying the reason and no hold id', async () => {
      const { controller } = makeController({ 'seat-A': 1 });

      const reply = await controller.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 5 });

      expect(reply).toEqual({ held: false, holdId: '', reason: 'insufficient_stock', available: 1 });
    });
  });

  describe('Release', () => {
    it('maps a release onto a ReleaseReply', async () => {
      const { controller } = makeController({ 'seat-A': 10 });
      await controller.hold({ bookingId: 'bk_1', sku: 'seat-A', qty: 2 });

      const reply = await controller.release({ bookingId: 'bk_1' });

      expect(reply).toEqual({ released: true, holdId: 'hold_1' });
    });

    it('reports a successful no-op for an unknown booking', async () => {
      const { controller } = makeController();

      const reply = await controller.release({ bookingId: 'ghost' });

      expect(reply).toEqual({ released: true, holdId: '' });
    });
  });
});
