import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { LedgerModule } from './entries/ledger.module';

/**
 * Root module for the ledger service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor, so every gRPC
 * handler is wrapped in a SERVER span (the ledger hop of the booking trace) and
 * metered with the RED method. {@link LedgerModule} contributes the
 * commit/reverse surface.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'ledger' }), LedgerModule],
})
export class AppModule {}
