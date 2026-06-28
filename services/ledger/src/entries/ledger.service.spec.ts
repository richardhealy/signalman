import { InMemoryOutboxStore, type OutboxRecord } from '@signalman/outbox';
import { InMemoryLedgerRepository } from './entry-repository';
import { LedgerService } from './ledger.service';

function makeService() {
  const entries = new InMemoryLedgerRepository();
  const outbox = new InMemoryOutboxStore();
  let seq = 0;
  const service = new LedgerService({
    entries,
    outbox,
    idFactory: () => `entry_${++seq}`,
    clock: () => new Date('2026-06-28T00:00:00Z'),
  });
  return { service, entries, outbox };
}

const eventsOfType = (outbox: InMemoryOutboxStore, type: string): OutboxRecord[] =>
  outbox.all().filter((r) => r.eventType === type);

const commitCmd = { bookingId: 'bk_1', amount: 4200, currency: 'USD', captureId: 'cap_1' };

describe('LedgerService', () => {
  describe('commit', () => {
    it('posts the entry, persists it, and stages a ledger.committed event', async () => {
      const { service, entries, outbox } = makeService();

      const outcome = await service.commit(commitCmd);

      expect(outcome).toEqual({ committed: true, entryId: 'entry_1' });
      await expect(entries.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'committed',
        amount: 4200,
        currency: 'USD',
        captureId: 'cap_1',
        committedAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'ledger.committed')).toMatchObject([
        {
          aggregateType: 'ledger_entry',
          aggregateId: 'entry_1',
          payload: {
            bookingId: 'bk_1',
            amount: 4200,
            currency: 'USD',
            entryId: 'entry_1',
            captureId: 'cap_1',
          },
        },
      ]);
    });

    it('defaults the capture reference to empty when the caller omits it', async () => {
      const { service, entries } = makeService();

      await service.commit({ bookingId: 'bk_1', amount: 100, currency: 'USD' });

      await expect(entries.findByBooking('bk_1')).resolves.toMatchObject({ captureId: '' });
    });

    it('is idempotent per booking: a repeat returns the standing entry without re-posting', async () => {
      const { service, outbox } = makeService();

      const first = await service.commit(commitCmd);
      const second = await service.commit(commitCmd);

      expect(second).toEqual(first);
      expect(eventsOfType(outbox, 'ledger.committed')).toHaveLength(1);
    });

    it('rejects a non-positive amount as data, changing no state and staging no event', async () => {
      const { service, entries, outbox } = makeService();

      const outcome = await service.commit({ ...commitCmd, amount: 0 });

      expect(outcome).toEqual({ committed: false, reason: 'invalid_amount' });
      await expect(entries.findByBooking('bk_1')).resolves.toBeUndefined();
      expect(outbox.all()).toHaveLength(0);
    });

    it('rejects a non-integer amount (e.g. a stray fractional minor unit)', async () => {
      const { service, outbox } = makeService();

      const outcome = await service.commit({ ...commitCmd, amount: 12.5 });

      expect(outcome).toEqual({ committed: false, reason: 'invalid_amount' });
      expect(outbox.all()).toHaveLength(0);
    });

    it('re-posts a reversed booking as a fresh entry', async () => {
      const { service, outbox } = makeService();
      await service.commit(commitCmd);
      await service.reverse({ bookingId: 'bk_1' });

      const outcome = await service.commit(commitCmd);

      expect(outcome).toEqual({ committed: true, entryId: 'entry_2' });
      expect(eventsOfType(outbox, 'ledger.committed')).toHaveLength(2);
    });
  });

  describe('reverse', () => {
    it('reverses an entry, advances state, and stages a ledger.reversed event', async () => {
      const { service, entries, outbox } = makeService();
      await service.commit(commitCmd);

      const outcome = await service.reverse({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ reversed: true, entryId: 'entry_1' });
      await expect(entries.findByBooking('bk_1')).resolves.toMatchObject({
        status: 'reversed',
        reversedAt: new Date('2026-06-28T00:00:00Z'),
      });
      expect(eventsOfType(outbox, 'ledger.reversed')).toMatchObject([
        {
          aggregateId: 'entry_1',
          payload: { bookingId: 'bk_1', amount: 4200, currency: 'USD', entryId: 'entry_1' },
        },
      ]);
    });

    it('is idempotent: reversing an already-reversed booking is a no-op success with no second event', async () => {
      const { service, outbox } = makeService();
      await service.commit(commitCmd);
      await service.reverse({ bookingId: 'bk_1' });

      const outcome = await service.reverse({ bookingId: 'bk_1' });

      expect(outcome).toEqual({ reversed: true, entryId: 'entry_1' });
      expect(eventsOfType(outbox, 'ledger.reversed')).toHaveLength(1);
    });

    it('treats reversing an unknown booking as a successful no-op', async () => {
      const { service, outbox } = makeService();

      const outcome = await service.reverse({ bookingId: 'ghost' });

      expect(outcome).toEqual({ reversed: true, entryId: '' });
      expect(outbox.all()).toHaveLength(0);
    });
  });
});
