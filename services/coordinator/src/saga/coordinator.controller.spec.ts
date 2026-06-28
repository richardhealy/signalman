import { BookingSaga, type BookCommand, type BookOutcome } from './booking-saga';
import { CoordinatorController } from './coordinator.controller';

/** A saga stub that returns a canned outcome and records the command it got. */
function stubSaga(outcome: BookOutcome): { saga: BookingSaga; commands: BookCommand[] } {
  const commands: BookCommand[] = [];
  const saga = {
    async book(command: BookCommand): Promise<BookOutcome> {
      commands.push(command);
      return outcome;
    },
  } as BookingSaga;
  return { saga, commands };
}

const REQUEST = {
  bookingId: 'bk_1',
  sku: 'seat-economy',
  qty: 2,
  amount: 4200,
  currency: 'USD',
};

describe('CoordinatorController', () => {
  it('forwards the request to the saga as a BookCommand', async () => {
    const { saga, commands } = stubSaga({
      booked: true,
      holdId: 'hold_1',
      authorizationId: 'auth_1',
      confirmationId: 'conf_1',
      captureId: 'cap_1',
      entryId: 'entry_1',
    });

    await new CoordinatorController(saga).book(REQUEST);

    expect(commands).toEqual([
      { bookingId: 'bk_1', sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' },
    ]);
  });

  it('maps a booked outcome onto a full reply with empty failure fields', async () => {
    const { saga } = stubSaga({
      booked: true,
      holdId: 'hold_1',
      authorizationId: 'auth_1',
      confirmationId: 'conf_1',
      captureId: 'cap_1',
      entryId: 'entry_1',
    });

    const reply = await new CoordinatorController(saga).book(REQUEST);

    expect(reply).toEqual({
      booked: true,
      holdId: 'hold_1',
      authorizationId: 'auth_1',
      confirmationId: 'conf_1',
      captureId: 'cap_1',
      entryId: 'entry_1',
      failedStep: '',
      reason: '',
      compensated: false,
    });
  });

  it('maps a failed-and-compensated outcome onto a reply with empty references', async () => {
    const { saga } = stubSaga({
      booked: false,
      failedStep: 'supplier.confirm',
      reason: 'partner_rejected',
      compensated: true,
    });

    const reply = await new CoordinatorController(saga).book(REQUEST);

    expect(reply).toEqual({
      booked: false,
      holdId: '',
      authorizationId: '',
      confirmationId: '',
      captureId: '',
      entryId: '',
      failedStep: 'supplier.confirm',
      reason: 'partner_rejected',
      compensated: true,
    });
  });

  it('carries through compensated:false when the first step failed', async () => {
    const { saga } = stubSaga({
      booked: false,
      failedStep: 'inventory.hold',
      reason: 'insufficient_stock',
      compensated: false,
    });

    const reply = await new CoordinatorController(saga).book(REQUEST);

    expect(reply).toMatchObject({ booked: false, compensated: false });
  });
});
