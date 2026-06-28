import { type Payment } from './payment';
import { InMemoryPaymentRepository } from './payment-repository';

function authorized(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'pay_1',
    bookingId: 'bk_1',
    amount: 5000,
    currency: 'USD',
    status: 'authorized',
    authorizationId: 'auth_1',
    createdAt: new Date('2026-06-28T00:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryPaymentRepository', () => {
  it('returns undefined for a booking with no payment', async () => {
    const repo = new InMemoryPaymentRepository();
    await expect(repo.findByBooking('bk_unknown')).resolves.toBeUndefined();
  });

  it('commits a payment and reads it back by booking', async () => {
    const repo = new InMemoryPaymentRepository();
    await repo.commit(authorized());

    await expect(repo.findByBooking('bk_1')).resolves.toMatchObject({
      id: 'pay_1',
      status: 'authorized',
      authorizationId: 'auth_1',
    });
  });

  it('upserts on bookingId: a transition advances the same record in place', async () => {
    const repo = new InMemoryPaymentRepository();
    await repo.commit(authorized());

    await repo.commit(authorized({ status: 'captured', captureId: 'cap_1' }));

    await expect(repo.findByBooking('bk_1')).resolves.toMatchObject({
      status: 'captured',
      captureId: 'cap_1',
    });
  });

  it('hands back copies so callers cannot mutate stored state', async () => {
    const repo = new InMemoryPaymentRepository();
    await repo.commit(authorized());

    const read = await repo.findByBooking('bk_1');
    (read as Payment as { status: string }).status = 'voided';

    await expect(repo.findByBooking('bk_1')).resolves.toMatchObject({ status: 'authorized' });
  });
});
