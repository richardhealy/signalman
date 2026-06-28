import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BOOKING_STORE, InMemoryBookingStore, type BookingStore } from './booking-store';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { COORDINATOR_PORT, type BookResult, type CoordinatorPort } from './coordinator-port';

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

/** A coordinator the test steers: returns a canned reply, or throws to simulate an outage. */
class FakeCoordinator implements CoordinatorPort {
  reply: BookResult = BOOKED;
  outage = false;

  async book(): Promise<BookResult> {
    if (this.outage) {
      throw new Error('14 UNAVAILABLE: no connection established');
    }
    return this.reply;
  }
}

describe('Bookings HTTP surface', () => {
  let app: INestApplication;
  let coordinator: FakeCoordinator;

  beforeEach(async () => {
    coordinator = new FakeCoordinator();
    const moduleRef = await Test.createTestingModule({
      controllers: [BookingController],
      providers: [
        { provide: COORDINATOR_PORT, useValue: coordinator },
        { provide: BOOKING_STORE, useValue: new InMemoryBookingStore() },
        {
          provide: BookingService,
          useFactory: (port: CoordinatorPort, store: BookingStore) =>
            new BookingService({ coordinator: port, store, newId: () => 'minted-id' }),
          inject: [COORDINATOR_PORT, BOOKING_STORE],
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /bookings books a request and returns 201 with the record', async () => {
    const response = await request(app.getHttpServer())
      .post('/bookings')
      .send({ bookingId: 'bk_1', sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      bookingId: 'bk_1',
      status: 'booked',
      holdId: 'hold_1',
      entryId: 'entry_1',
    });
  });

  it('POST /bookings records a failed saga outcome as a 201 with status failed', async () => {
    coordinator.reply = FAILED;

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .send({ sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      bookingId: 'minted-id',
      status: 'failed',
      failedStep: 'supplier.confirm',
      reason: 'partner_rejected',
      compensated: true,
    });
  });

  it('POST /bookings rejects a malformed body with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/bookings')
      .send({ sku: '', qty: 0, amount: -1, currency: '' });

    expect(response.status).toBe(400);
  });

  it('POST /bookings surfaces a coordinator outage as 502', async () => {
    coordinator.outage = true;

    const response = await request(app.getHttpServer())
      .post('/bookings')
      .send({ sku: 'seat-economy', qty: 2, amount: 4200, currency: 'USD' });

    expect(response.status).toBe(502);
  });

  it('GET /bookings/:id reads back a recorded booking', async () => {
    await request(app.getHttpServer())
      .post('/bookings')
      .send({ bookingId: 'bk_status', sku: 'seat-economy', qty: 1, amount: 1000, currency: 'USD' });

    const response = await request(app.getHttpServer()).get('/bookings/bk_status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ bookingId: 'bk_status', status: 'booked' });
  });

  it('GET /bookings/:id returns 404 for an unknown booking', async () => {
    const response = await request(app.getHttpServer()).get('/bookings/bk_unknown');

    expect(response.status).toBe(404);
  });
});
