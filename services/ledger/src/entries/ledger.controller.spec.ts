import { InMemoryOutboxStore } from '@signalman/outbox';
import { InMemoryLedgerRepository } from './entry-repository';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

function makeController() {
  const entries = new InMemoryLedgerRepository();
  const outbox = new InMemoryOutboxStore();
  let seq = 0;
  const service = new LedgerService({
    entries,
    outbox,
    idFactory: () => `entry_${++seq}`,
  });
  return { controller: new LedgerController(service), entries, outbox };
}

const commitReq = { bookingId: 'bk_1', amount: 4200, currency: 'USD', captureId: 'cap_1' };

describe('LedgerController', () => {
  describe('Commit', () => {
    it('maps a posted entry onto a full CommitReply', async () => {
      const { controller } = makeController();

      const reply = await controller.commit(commitReq);

      expect(reply).toEqual({ committed: true, entryId: 'entry_1', reason: '' });
    });

    it('maps a rejection onto a reply carrying the reason and no entry id', async () => {
      const { controller } = makeController();

      const reply = await controller.commit({ ...commitReq, amount: 0 });

      expect(reply).toEqual({ committed: false, entryId: '', reason: 'invalid_amount' });
    });
  });

  describe('Reverse', () => {
    it('maps a reversal onto a ReverseReply', async () => {
      const { controller } = makeController();
      await controller.commit(commitReq);

      const reply = await controller.reverse({ bookingId: 'bk_1' });

      expect(reply).toEqual({ reversed: true, entryId: 'entry_1' });
    });

    it('reports a successful no-op for an unknown booking', async () => {
      const { controller } = makeController();

      const reply = await controller.reverse({ bookingId: 'ghost' });

      expect(reply).toEqual({ reversed: true, entryId: '' });
    });
  });
});
