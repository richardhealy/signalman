import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@signalman/interceptor';
import { ReconcilerModule } from './reconciliation/reconciler.module';

/**
 * Root module for the reconciler service.
 *
 * `ObservabilityModule.forRoot` registers the global interceptor so that, once the
 * reconciler gains a broker transport to build its projection from `inventory.*`,
 * `supplier.*`, and `ledger.*` events, every consume handler is wrapped in a SERVER
 * span and metered with the RED method — the same treatment the gRPC legs get.
 * Until then the reconciler's spans come from the `reconcile.pass` and
 * `reconcile.divergence` spans the {@link ReconcilerService} opens. {@link ReconcilerModule}
 * contributes the comparison engine, the findings store, and the periodic scheduler.
 */
@Module({
  imports: [ObservabilityModule.forRoot({ scope: 'reconciler' }), ReconcilerModule],
})
export class AppModule {}
