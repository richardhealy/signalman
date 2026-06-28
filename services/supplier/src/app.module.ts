import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { SupplierModule } from './confirmations/supplier.module';

/**
 * Root module for the supplier service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor, so every gRPC
 * handler is wrapped in a SERVER span (the supplier hop of the booking trace)
 * and metered with the RED method. {@link SupplierModule} contributes the
 * confirm/cancel surface and its partner boundary.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'supplier' }), SupplierModule],
})
export class AppModule {}
