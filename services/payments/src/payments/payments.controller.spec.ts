import { InMemoryOutboxStore } from '@signalman/outbox';
import { InMemoryPaymentRepository } from './payment-repository';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SimulatedPsp, type SimulatedPspOptions } from './psp';

function makeController(pspOptions: SimulatedPspOptions = {}) {
  const payments = new InMemoryPaymentRepository();
  const outbox = new InMemoryOutboxStore();
  const psp = new SimulatedPsp({
    delay: () => Promise.resolve(),
    idFactory: () => 'ref',
    ...pspOptions,
  });
  let seq = 0;
  const service = new PaymentsService({ payments, outbox, psp, idFactory: () => `pay_${++seq}` });
  return { controller: new PaymentsController(service), payments, outbox };
}

const authorizeReq = { bookingId: 'bk_1', amount: 5000, currency: 'USD' };

describe('PaymentsController', () => {
  describe('Authorize', () => {
    it('maps an approved authorization onto a full AuthorizeReply', async () => {
      const { controller } = makeController();

      const reply = await controller.authorize(authorizeReq);

      expect(reply).toEqual({
        authorized: true,
        paymentId: 'pay_1',
        authorizationId: 'ref',
        reason: '',
      });
    });

    it('maps a decline onto a reply carrying the reason and no references', async () => {
      const { controller } = makeController({ declineRate: 1, random: () => 0 });

      const reply = await controller.authorize(authorizeReq);

      expect(reply).toEqual({
        authorized: false,
        paymentId: '',
        authorizationId: '',
        reason: 'card_declined',
      });
    });
  });

  describe('Capture', () => {
    it('maps a capture onto a full CaptureReply', async () => {
      const { controller } = makeController();
      await controller.authorize(authorizeReq);

      const reply = await controller.capture({ bookingId: 'bk_1' });

      expect(reply).toEqual({ captured: true, paymentId: 'pay_1', captureId: 'ref', reason: '' });
    });

    it('maps a capture with no authorization onto a reply carrying the reason', async () => {
      const { controller } = makeController();

      const reply = await controller.capture({ bookingId: 'ghost' });

      expect(reply).toEqual({ captured: false, paymentId: '', captureId: '', reason: 'no_authorization' });
    });
  });

  describe('Void', () => {
    it('maps a void onto a VoidReply', async () => {
      const { controller } = makeController();
      await controller.authorize(authorizeReq);

      const reply = await controller.voidAuthorization({ bookingId: 'bk_1' });

      expect(reply).toEqual({ voided: true, paymentId: 'pay_1' });
    });

    it('reports a successful no-op for an unknown booking', async () => {
      const { controller } = makeController();

      const reply = await controller.voidAuthorization({ bookingId: 'ghost' });

      expect(reply).toEqual({ voided: true, paymentId: '' });
    });
  });
});
