import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';
import { PAYMENTS_GRPC_PACKAGE, PAYMENTS_PROTO_PATH } from './proto';

/** Where the gRPC server binds; overridable so docker-compose can address it. */
const GRPC_URL = process.env.PAYMENTS_GRPC_URL ?? '0.0.0.0:50052';

/**
 * Boots the payments gRPC microservice. Telemetry starts first so spans and RED
 * metrics flow from the very first request, then the gRPC transport comes up
 * bound to the `Payments` proto contract.
 *
 * The proto loader is configured with `longs: Number` so the `uint64` amount
 * arrives as a JavaScript number — booking amounts sit far below `2^53`, so no
 * precision is lost, and the service avoids string-handling money.
 *
 * Shutdown hooks are enabled so the {@link OutboxRelayHost} the module registers
 * stops its relay, flushes once, and closes the broker on `SIGTERM`/`SIGINT`. The
 * relay starts on application bootstrap, draining staged `payment.*` events onto
 * the configured broker.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'payments', serviceVersion: '0.1.0' });

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: PAYMENTS_GRPC_PACKAGE,
      protoPath: PAYMENTS_PROTO_PATH,
      url: GRPC_URL,
      loader: { longs: Number },
    },
  });

  app.enableShutdownHooks();
  await app.listen();
  Logger.log(`payments gRPC listening on ${GRPC_URL}`, 'Bootstrap');
}

void bootstrap();
