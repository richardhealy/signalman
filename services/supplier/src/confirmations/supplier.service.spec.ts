import { InMemoryOutboxStore, type OutboxRecord } from '@signalman/outbox';
import { InMemoryConfirmationRepository } from './confirmation-repository';
import {
  SupplierUnavailableError,
  type SupplierConfirmRequest,
  type SupplierConfirmResult,
  type SupplierPartner,
} from './partner';
import { SupplierService } from './supplier.service';

/** A scripted {@link SupplierPartner} that records calls and returns canned results. */
class FakePartner implements SupplierPartner {
  confirmResult: SupplierConfirmResult = { accepted: true, confirmationId: 'conf_1' };
  confirmError?: Error;
  readonly confirmCalls: SupplierConfirmRequest[] = [];
  readonly cancelCalls: string[] = [];

  async confirm(request: SupplierConfirmRequest): Promise<SupplierConfirmResult> {
    this.confirmCalls.push(request);
    if (this.confirmError) {
      throw this.confirmError;
    }
    return this.confirmResult;
  }

  async cancel(confirmationId: string): Promise<void> {
    this.cancelCalls.push(confirmationId);
  }
}

function makeService() {
  const confirmations = new InMemoryConfirmationRepository();
  const outbox = new InMemoryOutboxStore();
  const partner = new FakePartner();
  let seq = 0;
  const service = new SupplierService({
    confirmations,
    outbox,
    partner,
    idFactory: () => `conf_rec_${++seq}`,
    clock: () => new Date('2026-06-28T00:00:00Z'),
  });
  return { service, confirmations, outbox, partner };
}

const eventsOfType = (outbox: InMemoryOutboxStore, type: string): OutboxRecord[] =>
  outbox.all().filter((r) => r.eventType === type);

const confirmCmd = { bookingId: 'bk_1', sku: 'seat-A', qty: 2 };

describe('SupplierService', () => {
  describe('confirm', () => {
    it('confirms via the partner, persists the confirmation, and stages a supplier.confirmed event', async () => {
      const { service, confirmations, outbox } = makeService();

      const outcome = await service.confirm(confirmCmd);

      expect(outcome).toEqual({ confirmed: true, confirmationId: 'conf_1' });
      await expect(confirmations.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'confirmed',
        sku: 'seat-A',
        qty: 2,
        confirmationId: 'conf_1',
        createdAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'supplier.confirmed')).toMatchObject([
        {
          aggregateType: 'confirmation',
          aggregateId: 'conf_rec_1',
          payload: { bookingId: 'bk_1', sku: 'seat-A', qty: 2, confirmationId: 'conf_1' },
        },
      ]);
    });

    it('is idempotent per booking: a repeat returns the standing confirmation without re-confirming', async () => {
      const { service, partner, outbox } = makeService();

      const first = await service.confirm(confirmCmd);
      const second = await service.confirm(confirmCmd);

      expect(second).toEqual(first);
      expect(partner.confirmCalls).toHaveLength(1); // partner hit once, not twice
      expect(eventsOfType(outbox, 'supplier.confirmed')).toHaveLength(1);
    });

    it('reports a partner rejection as data, changing no state and staging no event', async () => {
      const { service, confirmations, outbox, partner } = makeService();
      partner.confirmResult = { accepted: false, rejectionReason: 'no_availability' };

      const outcome = await service.confirm(confirmCmd);

      expect(outcome).toEqual({ confirmed: false, reason: 'no_availability' });
      await expect(confirmations.findByBooking('bk_1')).resolves.toBeUndefined();
      expect(outbox.all()).toHaveLength(0);
    });

    it('propagates a partner outage (so the gRPC span errors) without persisting or staging anything', async () => {
      const { service, confirmations, outbox, partner } = makeService();
      partner.confirmError = new SupplierUnavailableError('supplier confirm timed out');

      await expect(service.confirm(confirmCmd)).rejects.toBeInstanceOf(SupplierUnavailableError);
      await expect(confirmations.findByBooking('bk_1')).resolves.toBeUndefined();
      expect(outbox.all()).toHaveLength(0);
    });

    it('re-confirms a cancelled booking as a fresh confirmation', async () => {
      const { service, partner } = makeService();
      await service.confirm(confirmCmd);
      await service.cancel({ bookingId: 'bk_1' });
      partner.confirmResult = { accepted: true, confirmationId: 'conf_2' };

      const outcome = await service.confirm(confirmCmd);

      expect(outcome).toEqual({ confirmed: true, confirmationId: 'conf_2' });
      expect(partner.confirmCalls).toHaveLength(2);
    });
  });

  describe('cancel', () => {
    it('cancels a confirmation, advances state, and stages a supplier.cancelled event', async () => {
      const { service, confirmations, outbox, partner } = makeService();
      await service.confirm(confirmCmd);

      const outcome = await service.cancel({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ cancelled: true, confirmationId: 'conf_1' });
      expect(partner.cancelCalls).toEqual(['conf_1']);
      await expect(confirmations.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'cancelled',
        cancelledAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'supplier.cancelled')).toMatchObject([
        {
          aggregateId: 'conf_rec_1',
          payload: { bookingId: 'bk_1', sku: 'seat-A', qty: 2, confirmationId: 'conf_1' },
        },
      ]);
    });

    it('is idempotent: cancelling an already-cancelled booking is a no-op success with no second event', async () => {
      const { service, outbox, partner } = makeService();
      await service.confirm(confirmCmd);
      await service.cancel({ bookingId: 'bk_1' });

      const outcome = await service.cancel({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ cancelled: true, confirmationId: 'conf_1' });
      expect(partner.cancelCalls).toHaveLength(1); // partner cancel called once, not twice
      expect(eventsOfType(outbox, 'supplier.cancelled')).toHaveLength(1);
    });

    it('treats cancelling an unknown booking as a successful no-op', async () => {
      const { service, outbox, partner } = makeService();

      const outcome = await service.cancel({ bookingId: 'ghost' });

      expect(outcome).toEqual({ cancelled: true, confirmationId: '' });
      expect(partner.cancelCalls).toHaveLength(0);
      expect(outbox.all()).toHaveLength(0);
    });
  });
});
