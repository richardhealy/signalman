import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';

/**
 * Boots the notifier as a standalone application context.
 *
 * The notifier is a pure **async consumer** — it has no synchronous gRPC/HTTP
 * surface, so it runs as a Nest application context rather than a server: telemetry
 * starts first, then the providers (the consumer, service, channel, inbox)
 * initialise. The {@link BrokerSubscriptionHost} the module registers subscribes the
 * {@link BookingNotificationConsumer} to `ledger.committed` on application bootstrap,
 * so a booking's terminal event drives the notification; shutdown hooks are enabled
 * so it drops the subscription and closes the transport on `SIGTERM`/`SIGINT`.
 *
 * With the NATS transport the broker connection holds the event loop open; the
 * in-memory reference (the default) does not, so a keep-alive timer keeps the host
 * resident either way. Real cross-service delivery needs `BROKER=nats` so every
 * service shares one broker — under the in-memory default each process owns its own.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'notifier', serviceVersion: '0.1.0' });

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  Logger.log('notifier ready (subscribed to ledger.committed)', 'Bootstrap');

  // The in-memory broker holds nothing open; keep the host resident until signalled
  // to stop (SIGINT/SIGTERM still terminate it, running the shutdown hooks).
  setInterval(() => undefined, 60_000);
}

void bootstrap();
