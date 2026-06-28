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
 * initialise, which also validates the wiring. With no transport attached yet
 * nothing holds the event loop open, so a keep-alive timer keeps the host resident
 * (SIGINT/SIGTERM still terminate it as usual) — this is where the broker
 * subscription that feeds {@link BookingNotificationConsumer} lands with the broker
 * milestone, replacing the placeholder timer with real work.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'notifier', serviceVersion: '0.1.0' });

  await NestFactory.createApplicationContext(AppModule);

  Logger.log(
    'notifier ready (event consumer; broker subscription lands with the broker milestone)',
    'Bootstrap',
  );

  // No transport holds the event loop open yet; keep the host resident until it is
  // signalled to stop. A later milestone swaps this for the broker subscription.
  setInterval(() => undefined, 60_000);
}

void bootstrap();
