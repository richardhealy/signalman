import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';
import { INVENTORY_GRPC_PACKAGE, INVENTORY_PROTO_PATH } from './proto';

/** Where the gRPC server binds; overridable so docker-compose can address it. */
const GRPC_URL = process.env.INVENTORY_GRPC_URL ?? '0.0.0.0:50051';

/**
 * Boots the inventory gRPC microservice. Telemetry starts first so spans and
 * RED metrics flow from the very first request, then the gRPC transport comes up
 * bound to the `Inventory` proto contract.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'inventory', serviceVersion: '0.1.0' });

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: INVENTORY_GRPC_PACKAGE,
      protoPath: INVENTORY_PROTO_PATH,
      url: GRPC_URL,
    },
  });

  await app.listen();
  Logger.log(`inventory gRPC listening on ${GRPC_URL}`, 'Bootstrap');
}

void bootstrap();
