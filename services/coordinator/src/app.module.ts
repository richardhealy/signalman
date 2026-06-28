import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { SagaModule } from './saga/saga.module';

/**
 * Root module for the coordinator service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor, so the `Book`
 * gRPC handler is wrapped in a SERVER span — the coordinator hop of the booking
 * trace — and metered with the RED method. Every saga step and compensation span
 * the {@link SagaModule}'s orchestrator opens is a child of that SERVER span, so
 * one booking is one connected subtree rooted here.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'coordinator' }), SagaModule],
})
export class AppModule {}
