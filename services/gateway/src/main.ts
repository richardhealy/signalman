import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';

/**
 * Boots the gateway HTTP server. Telemetry starts first so the SERVER span the
 * observability interceptor opens around `POST /bookings` is the **root** of the
 * booking trace from the very first request, then the HTTP transport comes up.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'gateway', serviceVersion: '0.1.0' });

  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`gateway listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
