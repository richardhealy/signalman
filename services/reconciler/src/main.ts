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
 * scheduler's interval timer also keeps the event loop alive (SIGINT/SIGTERM still
 * terminate it as usual). The in-memory source gateway it reads is empty until the
 * broker/datastore-backed gateway lands, so passes are no-ops for now — but the
 * cadence, the comparison engine, and the trace-linked findings are all live.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'reconciler', serviceVersion: '0.1.0' });

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const scheduler = app.get(ReconciliationScheduler);
  scheduler.start();

  Logger.log(
    'reconciler ready (periodic reconciliation; source gateway wired to live stores with the datastore/broker milestone)',
    'Bootstrap',
  );
}

void bootstrap();
