import { InMemoryOutboxStore, type OutboxRecord } from '@signalman/outbox';
import { InMemoryPaymentRepository } from './payment-repository';
import { PaymentsService } from './payments.service';
import {
  PspUnavailableError,
  type Psp,
  type PspAuthorizeRequest,
  type PspAuthorizeResult,
  type PspCaptureResult,
} from './psp';

/** A scripted {@link Psp} that records calls and returns canned results. */
class FakePsp implements Psp {
  authorizeResult: PspAuthorizeResult = { approved: true, authorizationId: 'auth_1' };
  authorizeError?: Error;
  captureResult: PspCaptureResult = { captureId: 'cap_1' };
  readonly authorizeCalls: PspAuthorizeRequest[] = [];
  readonly captureCalls: string[] = [];
  readonly voidCalls: string[] = [];

  async authorize(request: PspAuthorizeRequest): Promise<PspAuthorizeResult> {
    this.authorizeCalls.push(request);
    if (this.authorizeError) {
      throw this.authorizeError;
    }
    return this.authorizeResult;
  }

  async capture(authorizationId: string): Promise<PspCaptureResult> {
    this.captureCalls.push(authorizationId);
    return this.captureResult;
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    this.voidCalls.push(authorizationId);
  }
}

function makeService() {
  const payments = new InMemoryPaymentRepository();
  const outbox = new InMemoryOutboxStore();
  const psp = new FakePsp();
  let seq = 0;
  const service = new PaymentsService({
    payments,
    outbox,
    psp,
    idFactory: () => `pay_${++seq}`,
    clock: () => new Date('2026-06-28T00:00:00Z'),
  });
  return { service, payments, outbox, psp };
}

const eventsOfType = (outbox: InMemoryOutboxStore, type: string): OutboxRecord[] =>
  outbox.all().filter((r) => r.eventType === type);

const authorizeCmd = { bookingId: 'bk_1', amount: 5000, currency: 'USD' };

describe('PaymentsService', () => {
  describe('authorize', () => {
    it('authorizes via the PSP, persists the payment, and stages a payment.authorized event', async () => {
      const { service, payments, outbox } = makeService();

      const outcome = await service.authorize(authorizeCmd);

      expect(outcome).toEqual({
        authorized: true,
        paymentId: 'pay_1',
        authorizationId: 'auth_1',
        status: 'authorized',
      });
      await expect(payments.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'authorized',
        amount: 5000,
        currency: 'USD',
        authorizationId: 'auth_1',
        createdAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'payment.authorized')).toMatchObject([
        {
          aggregateType: 'payment',
          aggregateId: 'pay_1',
          payload: { bookingId: 'bk_1', amount: 5000, currency: 'USD', authorizationId: 'auth_1' },
        },
      ]);
    });

    it('is idempotent per booking: a repeat returns the standing authorization without re-charging', async () => {
      const { service, psp, outbox } = makeService();

      const first = await service.authorize(authorizeCmd);
      const second = await service.authorize(authorizeCmd);

      expect(second).toEqual(first);
      expect(psp.authorizeCalls).toHaveLength(1); // PSP hit once, not twice
      expect(eventsOfType(outbox, 'payment.authorized')).toHaveLength(1);
    });

    it('returns the standing payment for an already-captured booking without calling the PSP', async () => {
      const { service, psp } = makeService();
      await service.authorize(authorizeCmd);
      await service.capture({ bookingId: 'bk_1' });

      const outcome = await service.authorize(authorizeCmd);

      expect(outcome).toMatchObject({ authorized: true, paymentId: 'pay_1', status: 'captured' });
      expect(psp.authorizeCalls).toHaveLength(1);
    });

    it('reports a PSP decline as data, changing no state and staging no event', async () => {
      const { service, payments, outbox, psp } = makeService();
      psp.authorizeResult = { approved: false, declineReason: 'card_declined' };

      const outcome = await service.authorize(authorizeCmd);

      expect(outcome).toEqual({ authorized: false, reason: 'card_declined' });
      await expect(payments.findByBooking('bk_1')).resolves.toBeUndefined();
      expect(outbox.all()).toHaveLength(0);
    });

    it('propagates a PSP outage (so the gRPC span errors) without persisting or staging anything', async () => {
      const { service, payments, outbox, psp } = makeService();
      psp.authorizeError = new PspUnavailableError('PSP authorize timed out');

      await expect(service.authorize(authorizeCmd)).rejects.toBeInstanceOf(PspUnavailableError);
      await expect(payments.findByBooking('bk_1')).resolves.toBeUndefined();
      expect(outbox.all()).toHaveLength(0);
    });

    it('re-authorizes a voided booking as a fresh payment', async () => {
      const { service, psp } = makeService();
      await service.authorize(authorizeCmd);
      await service.voidAuthorization({ bookingId: 'bk_1' });
      psp.authorizeResult = { approved: true, authorizationId: 'auth_2' };

      const outcome = await service.authorize(authorizeCmd);

      expect(outcome).toMatchObject({
        authorized: true,
        paymentId: 'pay_2',
        authorizationId: 'auth_2',
        status: 'authorized',
      });
      expect(psp.authorizeCalls).toHaveLength(2);
    });
  });

  describe('capture', () => {
    it('captures an authorized payment, advances state, and stages a payment.captured event', async () => {
      const { service, payments, outbox, psp } = makeService();
      await service.authorize(authorizeCmd);

      const outcome = await service.capture({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ captured: true, paymentId: 'pay_1', captureId: 'cap_1' });
      expect(psp.captureCalls).toEqual(['auth_1']);
      await expect(payments.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'captured',
        captureId: 'cap_1',
        capturedAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'payment.captured')).toMatchObject([
        {
          aggregateId: 'pay_1',
          payload: {
            bookingId: 'bk_1',
            amount: 5000,
            currency: 'USD',
            authorizationId: 'auth_1',
            captureId: 'cap_1',
          },
        },
      ]);
    });

    it('is idempotent: a repeat capture returns the standing capture and stages no second event', async () => {
      const { service, outbox, psp } = makeService();
      await service.authorize(authorizeCmd);
      const first = await service.capture({ bookingId: 'bk_1' });

      const second = await service.capture({ bookingId: 'bk_1' });

      expect(second).toEqual(first);
      expect(psp.captureCalls).toHaveLength(1);
      expect(eventsOfType(outbox, 'payment.captured')).toHaveLength(1);
    });

    it('rejects a capture with no authorization', async () => {
      const { service, psp } = makeService();

      const outcome = await service.capture({ bookingId: 'ghost' });

      expect(outcome).toEqual({ captured: false, reason: 'no_authorization' });
      expect(psp.captureCalls).toHaveLength(0);
    });

    it('rejects a capture against a voided authorization', async () => {
      const { service } = makeService();
      await service.authorize(authorizeCmd);
      await service.voidAuthorization({ bookingId: 'bk_1' });

      const outcome = await service.capture({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ captured: false, reason: 'authorization_voided' });
    });
  });

  describe('voidAuthorization', () => {
    it('voids an authorized payment, advances state, and stages a payment.voided event', async () => {
      const { service, payments, outbox, psp } = makeService();
      await service.authorize(authorizeCmd);

      const outcome = await service.voidAuthorization({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ voided: true, paymentId: 'pay_1' });
      expect(psp.voidCalls).toEqual(['auth_1']);
      await expect(payments.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'voided',
        voidedAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'payment.voided')).toMatchObject([
        { aggregateId: 'pay_1', payload: { bookingId: 'bk_1', authorizationId: 'auth_1' } },
      ]);
    });

    it('is idempotent: voiding an already-voided booking is a no-op success with no second event', async () => {
      const { service, outbox, psp } = makeService();
      await service.authorize(authorizeCmd);
      await service.voidAuthorization({ bookingId: 'bk_1' });

      const outcome = await service.voidAuthorization({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ voided: true, paymentId: 'pay_1' });
      expect(psp.voidCalls).toHaveLength(1); // PSP void called once, not twice
      expect(eventsOfType(outbox, 'payment.voided')).toHaveLength(1);
    });

    it('treats voiding an unknown booking as a successful no-op', async () => {
      const { service, outbox, psp } = makeService();

      const outcome = await service.voidAuthorization({ bookingId: 'ghost' });

      expect(outcome).toEqual({ voided: true, paymentId: '' });
      expect(psp.voidCalls).toHaveLength(0);
      expect(outbox.all()).toHaveLength(0);
    });

    it('does not void a captured payment (refund is out of scope); reports the desired end state', async () => {
      const { service, outbox, psp } = makeService();
      await service.authorize(authorizeCmd);
      await service.capture({ bookingId: 'bk_1' });

      const outcome = await service.voidAuthorization({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ voided: true, paymentId: 'pay_1' });
      expect(psp.voidCalls).toHaveLength(0);
      expect(eventsOfType(outbox, 'payment.voided')).toHaveLength(0);
    });
  });
});
