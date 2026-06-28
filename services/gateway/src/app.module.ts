import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { BookingModule } from './bookings/booking.module';
import { HealthModule } from './health/health.module';

/**
 * Root module for the gateway service — the public HTTP entry point.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor, so every HTTP
 * handler is wrapped in a SERVER span and metered with the RED method. A
 * `POST /bookings` request carries no upstream parent, so its SERVER span is the
 * **root** of the booking trace; the {@link BookingModule}'s coordinator port
 * then continues that trace over gRPC, and the whole booking — coordinator and
 * every leg below it — hangs off this one entry point.
 */
@Module({
  imports: [
    ObservabilityModule.forRoot({ scope: 'gateway' }),
    HealthModule,
    BookingModule,
  ],
})
export class AppModule {}
