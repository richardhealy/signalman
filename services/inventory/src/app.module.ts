import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { InventoryModule } from './holds/inventory.module';

/**
 * Root module for the inventory service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor, so every gRPC
 * handler is wrapped in a SERVER span (the inventory hop of the booking trace)
 * and metered with the RED method. {@link InventoryModule} contributes the
 * hold-management surface itself.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'inventory' }), InventoryModule],
})
export class AppModule {}
