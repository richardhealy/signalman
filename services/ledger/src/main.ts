import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';
import { LEDGER_GRPC_PACKAGE, LEDGER_PROTO_PATH } from './proto';

/** Where the gRPC server binds; overridable so docker-compose can address it. */
const GRPC_URL = process.env.LEDGER_GRPC_URL ?? '0.0.0.0:50054';

/**
 * Boots the ledger gRPC microservice. Telemetry starts first so spans and RED
 * metrics flow from the very first request, then the gRPC transport comes up
 * bound to the `Ledger` proto contract.
 *
 * Shutdown hooks are enabled so the {@link OutboxRelayHost} the module registers
 * stops its relay, flushes once, and closes the broker on `SIGTERM`/`SIGINT`. The
 * relay starts on application bootstrap, draining staged `ledger.*` events onto
 * the configured broker.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'ledger', serviceVersion: '0.1.0' });

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: LEDGER_GRPC_PACKAGE,
      protoPath: LEDGER_PROTO_PATH,
      url: GRPC_URL,
      // Decode the `uint64 amount` field as a JS number rather than the
      // proto-loader default (a Long object), so the amount the ledger posts and
      // stages into its outbox events is the plain number its types declare —
      // what the reconciler later compares against the other sources of truth.
      loader: { longs: Number },
    },
  });

  app.enableShutdownHooks();
  await app.listen();
  Logger.log(`ledger gRPC listening on ${GRPC_URL}`, 'Bootstrap');
}

void bootstrap();
