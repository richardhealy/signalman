import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { startTelemetry } from '@signalman/otel';
import { AppModule } from './app.module';
import { COORDINATOR_GRPC_PACKAGE, COORDINATOR_PROTO_PATH } from './proto';

/** Where the gRPC server binds; overridable so docker-compose can address it. */
const GRPC_URL = process.env.COORDINATOR_GRPC_URL ?? '0.0.0.0:50050';

/**
 * Boots the coordinator gRPC microservice. Telemetry starts first so the saga's
 * step and compensation spans flow from the very first booking, then the gRPC
 * transport comes up bound to the `Coordinator` proto contract the gateway calls.
 */
async function bootstrap(): Promise<void> {
  startTelemetry({ serviceName: 'coordinator', serviceVersion: '0.1.0' });

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: COORDINATOR_GRPC_PACKAGE,
      protoPath: COORDINATOR_PROTO_PATH,
      url: GRPC_URL,
    },
  });

  await app.listen();
  Logger.log(`coordinator gRPC listening on ${GRPC_URL}`, 'Bootstrap');
}

void bootstrap();
