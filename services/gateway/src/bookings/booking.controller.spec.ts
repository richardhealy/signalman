import { BadGatewayException, BadRequestException, NotFoundException } from '@nestjs/common';
import { BookingController, parseBookingRequest } from './booking.controller';
import { BookingService } from './booking.service';
import { type BookingRecord, type BookingRequest } from './booking';

const VALID_BODY = { sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' };

describe('parseBookingRequest', () => {
  it('accepts and normalises a valid body', () => {
    expect(parseBookingRequest({ ...VALID_BODY, sku: '  seat-economy  ' })).toEqual({
      sku: 'seat-economy',
      qty: 2,
      amount: 4200,
      currency: 'USD',
    });
  });

  it('keeps a supplied booking id', () => {
    expect(parseBookingRequest({ ...VALID_BODY, bookingId: 'bk_1' })).toMatchObject({
      bookingId: 'bk_1',
    });
  });

  it.each([
    ['a non-object body', 'nope'],
    ['a missing sku', { qty: 1, amount: 1, currency: 'USD' }],
    ['an empty sku', { ...VALID_BODY, sku: '   ' }],
    ['a zero qty', { ...VALID_BODY, qty: 0 }],
    ['a fractional qty', { ...VALID_BODY, qty: 1.5 }],
    ['a negative amount', { ...VALID_BODY, amount: -1 }],
    ['a non-numeric amount', { ...VALID_BODY, amount: '4200' }],
    ['a blank currency', { ...VALID_BODY, currency: '' }],
    ['an empty supplied booking id', { ...VALID_BODY, bookingId: '' }],
  ])('rejects %s with a BadRequest', (_label, body) => {
    expect(() => parseBookingRequest(body)).toThrow(BadRequestException);
  });
});

/** A service stub whose book/getStatus behaviour the test controls. */
function stubService(overrides: Partial<Pick<BookingService, 'book' | 'getStatus'>>): BookingService {
  return {
    book: overrides.book ?? (async () => {
      throw new Error('unexpected book call');
    }),
    getStatus: overrides.getStatus ?? (async () => undefined),
  } as unknown as BookingService;
}

const RECORD: BookingRecord = {
  bookingId: 'bk_1',
  status: 'booked',
  request: { sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' },
  traceId: '0af7651916cd43dd8448eb211c80319c',
  recordedAt: '2026-06-29T12:00:00.000Z',
  holdId: 'hold_1',
};

describe('BookingController', () => {
  describe('create', () => {
    it('validates the body and returns the service record', async () => {
      let received: BookingRequest | undefined;
      const controller = new BookingController(
        stubService({
          book: async (request) => {
            received = request;
            return RECORD;
          },
        }),
      );

      const result = await controller.create(VALID_BODY);

      expect(result).toBe(RECORD);
      expect(received).toEqual(VALID_BODY);
    });

    it('rejects an invalid body before calling the service', async () => {
      let called = false;
      const controller = new BookingController(
        stubService({
          book: async () => {
            called = true;
            return RECORD;
          },
        }),
      );

      await expect(controller.create({ sku: '', qty: 0, amount: 0, currency: '' })).rejects.toThrow(
        BadRequestException,
      );
      expect(called).toBe(false);
    });

    it('maps a coordinator outage onto a BadGateway', async () => {
      const controller = new BookingController(
        stubService({
          book: async () => {
            throw new Error('14 UNAVAILABLE: no connection established');
          },
        }),
      );

      await expect(controller.create(VALID_BODY)).rejects.toThrow(BadGatewayException);
    });
  });

  describe('status', () => {
    it('returns the recorded outcome', async () => {
      const controller = new BookingController(stubService({ getStatus: async () => RECORD }));

      expect(await controller.status('bk_1')).toBe(RECORD);
    });

    it('throws NotFound for an unknown booking', async () => {
      const controller = new BookingController(stubService({ getStatus: async () => undefined }));

      await expect(controller.status('bk_unknown')).rejects.toThrow(NotFoundException);
    });
  });
});
