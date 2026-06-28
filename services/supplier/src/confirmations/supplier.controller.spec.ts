import { InMemoryOutboxStore } from '@signalman/outbox';
import { InMemoryConfirmationRepository } from './confirmation-repository';
import { SimulatedSupplierPartner, type SimulatedSupplierPartnerOptions } from './partner';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';

function makeController(partnerOptions: SimulatedSupplierPartnerOptions = {}) {
  const confirmations = new InMemoryConfirmationRepository();
  const outbox = new InMemoryOutboxStore();
  const partner = new SimulatedSupplierPartner({
    delay: () => Promise.resolve(),
    idFactory: () => 'ref',
    ...partnerOptions,
  });
  let seq = 0;
  const service = new SupplierService({
    confirmations,
    outbox,
    partner,
    idFactory: () => `conf_rec_${++seq}`,
  });
  return { controller: new SupplierController(service), confirmations, outbox };
}

const confirmReq = { bookingId: 'bk_1', sku: 'seat-A', qty: 2 };

describe('SupplierController', () => {
  describe('Confirm', () => {
    it('maps an accepted confirmation onto a full ConfirmReply', async () => {
      const { controller } = makeController();

      const reply = await controller.confirm(confirmReq);

      expect(reply).toEqual({ confirmed: true, confirmationId: 'ref', reason: '' });
    });

    it('maps a rejection onto a reply carrying the reason and no reference', async () => {
      const { controller } = makeController({ rejectRate: 1, random: () => 0 });

      const reply = await controller.confirm(confirmReq);

      expect(reply).toEqual({ confirmed: false, confirmationId: '', reason: 'no_availability' });
    });
  });

  describe('Cancel', () => {
    it('maps a cancel onto a CancelReply', async () => {
      const { controller } = makeController();
      await controller.confirm(confirmReq);

      const reply = await controller.cancel({ bookingId: 'bk_1' });

      expect(reply).toEqual({ cancelled: true, confirmationId: 'ref' });
    });

    it('reports a successful no-op for an unknown booking', async () => {
      const { controller } = makeController();

      const reply = await controller.cancel({ bookingId: 'ghost' });

      expect(reply).toEqual({ cancelled: true, confirmationId: '' });
    });
  });
});
