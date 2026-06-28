/**
 * Wiring for the gateway's booking surface.
 *
 * It binds the {@link BookingController} (the HTTP entry point) to a
 * {@link BookingService} that drives the live coordinator over gRPC and records
 * outcomes in the in-memory {@link BookingStore} reference. The coordinator's
 * dial address is env-overridable (`COORDINATOR_GRPC_URL`) so docker-compose can
 * address it by service name; the connection is lazy, so the gateway boots even
 * before the coordinator is up. The Postgres-backed booking store swaps in here
 * behind the same {@link BOOKING_STORE} token with the datastore milestone.
 */
import { Module } from '@nestjs/common';
import { type BookingStore, BOOKING_STORE, InMemoryBookingStore } from './booking-store';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { createCoordinatorCall, GrpcCoordinatorPort } from './coordinator-client';
import { type CoordinatorPort, COORDINATOR_PORT } from './coordinator-port';

/** Where the coordinator is dialled; env-overridable so compose can address by name. */
const COORDINATOR_URL = process.env.COORDINATOR_GRPC_URL ?? 'localhost:50050';

@Module({
  controllers: [BookingController],
  providers: [
    {
      provide: COORDINATOR_PORT,
      useFactory: (): CoordinatorPort =>
        new GrpcCoordinatorPort(createCoordinatorCall({ url: COORDINATOR_URL })),
    },
    { provide: BOOKING_STORE, useFactory: (): BookingStore => new InMemoryBookingStore() },
    {
      provide: BookingService,
      useFactory: (coordinator: CoordinatorPort, store: BookingStore): BookingService =>
        new BookingService({ coordinator, store }),
      inject: [COORDINATOR_PORT, BOOKING_STORE],
    },
  ],
})
export class BookingModule {}
