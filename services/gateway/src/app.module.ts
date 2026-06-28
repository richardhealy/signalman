import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';

/**
 * Root module for the gateway service — the public HTTP entry point that will,
 * in later milestones, open a booking's root span and drive the saga
 * coordinator over gRPC. For now it exposes only the health probe.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
