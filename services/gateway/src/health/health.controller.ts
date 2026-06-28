import { Controller, Get } from '@nestjs/common';

/** Shape returned by the liveness/readiness probe. */
export interface HealthStatus {
  status: 'ok';
  service: string;
}

/**
 * Liveness/readiness probe for the gateway. Kept dependency-free so it answers
 * even when downstream services are degraded — its job is to report that *this*
 * process is up, not to assert the health of the wider booking saga.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return { status: 'ok', service: 'gateway' };
  }
}
