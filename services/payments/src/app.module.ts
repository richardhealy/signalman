import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { PaymentsModule } from './payments/payments.module';

/**
 * Root module for the payments service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor, so every gRPC
 * handler is wrapped in a SERVER span (the payments hop of the booking trace)
 * and metered with the RED method. {@link PaymentsModule} contributes the
 * authorize/capture/void surface and its PSP boundary.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'payments' }), PaymentsModule],
})
export class AppModule {}
