import { Test } from '@nestjs/testing';
import { InMemoryBroker, OutboxRelayHost, type BrokerFromEnvResult } from '@signalman/broker';
import { InventoryModule, MESSAGE_BROKER } from './inventory.module';
import { InventoryService } from './inventory.service';

/**
 * Proves the per-service wiring, not the relay mechanics (those live in
 * `@signalman/broker`): that the {@link OutboxRelayHost} the module registers
 * drains the *same* outbox the {@link InventoryService} stages into, onto the
 * configured broker. The `MESSAGE_BROKER` provider is overridden with a shared
 * in-memory broker so the test can subscribe and observe the published event.
 */
describe('inventory relay wiring', () => {
  it('drains a staged inventory.held event onto the configured broker', async () => {
    const broker = new InMemoryBroker();
    const brokerResult: BrokerFromEnvResult = {
      broker,
      kind: 'memory',
      close: () => Promise.resolve(),
    };

    const moduleRef = await Test.createTestingModule({ imports: [InventoryModule] })
      .overrideProvider(MESSAGE_BROKER)
      .useValue(brokerResult)
      .compile();

    const service = moduleRef.get(InventoryService);
    const host = moduleRef.get(OutboxRelayHost);

    const delivered: Array<{ subject: string; payload: unknown }> = [];
    broker.subscribe('inventory.>', (message) => {
      delivered.push({ subject: message.subject, payload: message.payload });
      return Promise.resolve();
    });

    const outcome = await service.hold({ bookingId: 'bk_1', sku: 'seat-economy', qty: 2 });
    expect(outcome.held).toBe(true);

    await host.flush();
    await broker.drain();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].subject).toBe('inventory.held');
    expect(delivered[0].payload).toMatchObject({ bookingId: 'bk_1', sku: 'seat-economy', qty: 2 });

    await moduleRef.close();
  });
});
