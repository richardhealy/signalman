/**
 * Wiring for the gateway's booking surface.
 *
 * It binds the {@link BookingController} (the HTTP entry point) to a
 * {@link BookingService} that drives the live coordinator over gRPC and records
 * outcomes in the configured {@link BookingStore}. The coordinator's dial address
 * is env-overridable (`COORDINATOR_GRPC_URL`) so docker-compose can address it by
 * service name; the connection is lazy, so the gateway boots even before the
 * coordinator is up.
 *
 * **Datastore selection** — driven by `POSTGRES_URL`:
 * - When set, a `Pool` connects to Postgres and the service uses
 *   {@link PostgresBookingStore} backed by the `gateway` schema. The table is
 *   created (if absent) on bootstrap.
 * - When absent, the in-memory {@link InMemoryBookingStore} reference stands in,
 *   keeping the unit suite and single-process demos infrastructure-free.
 */
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { type BookingStore, BOOKING_STORE, InMemoryBookingStore } from './booking-store';
import { PostgresBookingStore } from './pg-booking-store';
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
    {
      provide: BOOKING_STORE,
      useFactory: async (): Promise<BookingStore> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const store = new PostgresBookingStore(pool, 'gateway');
          await store.ensureSchema();
          return store;
        }
        return new InMemoryBookingStore();
      },
    },
    {
      provide: BookingService,
      useFactory: (coordinator: CoordinatorPort, store: BookingStore): BookingService =>
        new BookingService({ coordinator, store }),
      inject: [COORDINATOR_PORT, BOOKING_STORE],
    },
  ],
})
export class BookingModule {}
