import { BookingService } from './booking.service';
import { InMemoryBookingStore } from './booking-store';
import { type BookCommand, type BookResult, type CoordinatorPort } from './coordinator-port';
import { type BookingRequest } from './booking';

const BOOKED: BookResult = {
  booked: true,
  holdId: 'hold_1',
  authorizationId: 'auth_1',
  confirmationId: 'conf_1',
  captureId: 'cap_1',
  entryId: 'entry_1',
  failedStep: '',
  reason: '',
  compensated: false,
};

const FAILED: BookResult = {
  booked: false,
  holdId: '',
  authorizationId: '',
  confirmationId: '',
  captureId: '',
  entryId: '',
  failedStep: 'supplier.confirm',
  reason: 'partner_rejected',
  compensated: true,
};

/** A coordinator stub that records the commands it gets and returns a canned reply. */
function stubCoordinator(reply: BookResult): { port: CoordinatorPort; commands: BookCommand[] } {
  const commands: BookCommand[] = [];
  const port: CoordinatorPort = {
    async book(command: BookCommand): Promise<BookResult> {
      commands.push(command);
      return reply;
    },
  };
  return { port, commands };
}

const REQUEST: BookingRequest = {
  bookingId: 'bk_1',
  sku: 'seat-economy',
  qty: 2,
  amount: 4200,
  currency: 'USD',
};

function makeService(reply: BookResult) {
  const { port, commands } = stubCoordinator(reply);
  const store = new InMemoryBookingStore();
  const service = new BookingService({
    coordinator: port,
    store,
    newId: () => 'minted-id',
    clock: () => new Date('2026-06-29T12:00:00.000Z'),
  });
  return { service, store, commands };
}

describe('BookingService', () => {
  it('threads the request onto the saga command, keeping a supplied booking id', async () => {
    const { service, commands } = makeService(BOOKED);

    await service.book(REQUEST);

    expect(commands).toEqual([
      { bookingId: 'bk_1', sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' },
    ]);
  });

  it('mints a booking id when the request omits one', async () => {
    const { service, commands } = makeService(BOOKED);

    const { bookingId } = await service.book({ ...REQUEST, bookingId: undefined });

    expect(bookingId).toBe('minted-id');
    expect(commands[0]?.bookingId).toBe('minted-id');
  });

  it('maps a booked reply onto a booked record with the leg references', async () => {
    const { service } = makeService(BOOKED);

    const record = await service.book(REQUEST);

    expect(record).toMatchObject({
      bookingId: 'bk_1',
      status: 'booked',
      request: { sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' },
      recordedAt: '2026-06-29T12:00:00.000Z',
      holdId: 'hold_1',
      authorizationId: 'auth_1',
      confirmationId: 'conf_1',
      captureId: 'cap_1',
      entryId: 'entry_1',
    });
    expect(record.failedStep).toBeUndefined();
  });

  it('maps a failed reply onto a failed record with the stopping step and reason', async () => {
    const { service } = makeService(FAILED);

    const record = await service.book(REQUEST);

    expect(record).toMatchObject({
      bookingId: 'bk_1',
      status: 'failed',
      failedStep: 'supplier.confirm',
      reason: 'partner_rejected',
      compensated: true,
    });
    expect(record.holdId).toBeUndefined();
  });

  it('persists the outcome so getStatus reads it back', async () => {
    const { service } = makeService(BOOKED);

    const written = await service.book(REQUEST);

    expect(await service.getStatus('bk_1')).toEqual(written);
  });

  it('returns undefined status for an unknown booking', async () => {
    const { service } = makeService(BOOKED);

    expect(await service.getStatus('bk_unknown')).toBeUndefined();
  });

  it('stamps an empty trace id when no span is active', async () => {
    const { service } = makeService(BOOKED);

    const record = await service.book(REQUEST);

    expect(record.traceId).toBe('');
  });
});
