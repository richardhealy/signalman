import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { NotifierModule } from './notifications/notifier.module';

/**
 * Root module for the notifier service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor so that, once the
 * notifier gains a broker transport, every `@EventPattern` consume handler is
 * wrapped in a SERVER span and metered with the RED method — the same treatment
 * the gRPC legs get. Until then the notifier's spans come from the inbox CONSUMER
 * span the {@link BookingNotificationConsumer} opens. {@link NotifierModule}
 * contributes the notify surface and its provider boundary.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'notifier' }), NotifierModule],
})
export class AppModule {}
