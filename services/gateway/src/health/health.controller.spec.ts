import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    controller = moduleRef.get(HealthController);
  });

  it('reports the gateway service as healthy', () => {
    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('gateway');
  });
});
