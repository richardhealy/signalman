import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Wires the gateway's health probe into the application. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
