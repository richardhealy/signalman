import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';
import { SUPPLIER_GRPC_PACKAGE, SUPPLIER_PROTO_PATH } from './proto';

/** Where the gRPC server binds; overridable so docker-compose can address it. */
const GRPC_URL = process.env.SUPPLIER_GRPC_URL ?? '0.0.0.0:50053';

/**
 * Boots the supplier gRPC microservice. Telemetry starts first so spans and RED
 * metrics flow from the very first request, then the gRPC transport comes up
 * bound to the `Supplier` proto contract.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'supplier', serviceVersion: '0.1.0' });

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: SUPPLIER_GRPC_PACKAGE,
      protoPath: SUPPLIER_PROTO_PATH,
      url: GRPC_URL,
    },
  });

  await app.listen();
  Logger.log(`supplier gRPC listening on ${GRPC_URL}`, 'Bootstrap');
}

void bootstrap();
