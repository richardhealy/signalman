import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';
import { ReconciliationScheduler } from './reconciliation/scheduler';

/**
 * Boots the reconciler as a standalone application context.
 *
 * Like the notifier, the reconciler has no synchronous gRPC/HTTP surface — it is a
 * periodic background job — so it runs as a Nest application context rather than a
 * server: telemetry starts first, then the providers initialise, then the
 * {@link ReconciliationScheduler} starts running passes on its interval. The
 * {@link BrokerSubscriptionHost} establishes subscriptions to `inventory.*`,
 * `supplier.*`, and `ledger.*` on bootstrap so the source-of-truth gateway builds
 * live per-booking projections from the real event stream. Shutdown hooks are
 * enabled so the subscription and broker close cleanly on SIGTERM/SIGINT; the
 * scheduler's interval timer keeps the event loop alive between passes.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'reconciler', serviceVersion: '0.1.0' });

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const scheduler = app.get(ReconciliationScheduler);
  scheduler.start();

  Logger.log(
    'reconciler ready — subscribed to inventory.*/supplier.*/ledger.* for live source-of-truth projection',
    'Bootstrap',
  );
}

void bootstrap();
