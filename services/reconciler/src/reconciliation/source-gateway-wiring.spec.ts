import { Test } from '@nestjs/testing';
import {
  BrokerSubscriptionHost,
  InMemoryBroker,
  type BrokerFromEnvResult,
  type BrokerMessage,
} from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';
import { MESSAGE_BROKER, ReconcilerModule, SOURCE_OF_TRUTH_GATEWAY } from './reconciler.module';

/** A delivered broker message for one of the three source subjects. */
function sourceMessage(subject: string, bookingId: string): BrokerMessage {
  return {
    id: `msg_${subject}_${bookingId}`,
    subject,
    payload: { bookingId },
    headers: { traceparent: `tp_${bookingId}` },
  };
}

/**
 * Proves the per-module subscription wiring for the reconciler's source gateway:
 * that the {@link BrokerSubscriptionHost} established by {@link ReconcilerModule}
 * routes `inventory.*`, `supplier.*`, and `ledger.*` events into the
 * {@link BrokerSourceOfTruthGateway} so the reconciler sees real booking state.
 *
 * The `MESSAGE_BROKER` provider is overridden with a shared in-memory broker the
 * test publishes onto; `SOURCE_OF_TRUTH_GATEWAY` is overridden with a
 * `BrokerSourceOfTruthGateway` whose settle-grace window is 0 ms so events are
 * immediately settled, letting the test assert `collectSettled()` synchronously
 * after a `drain()`.
 */
describe('reconciler source gateway wiring', () => {
  async function bootModule(): Promise<{
    broker: InMemoryBroker;
    host: BrokerSubscriptionHost;
    gateway: BrokerSourceOfTruthGateway;
    close: () => Promise<void>;
  }> {
    const broker = new InMemoryBroker();
    const brokerResult: BrokerFromEnvResult = {
      broker,
      kind: 'memory',
      close: () => Promise.resolve(),
    };

    // settleGraceMs: 0 so every event is immediately "settled" in tests.
    const testGateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });

    const moduleRef = await Test.createTestingModule({ imports: [ReconcilerModule] })
      .overrideProvider(MESSAGE_BROKER)
      .useValue(brokerResult)
      .overrideProvider(SOURCE_OF_TRUTH_GATEWAY)
      .useValue(testGateway)
      .compile();

    const host = moduleRef.get(BrokerSubscriptionHost);
    const gateway = moduleRef.get<BrokerSourceOfTruthGateway>(SOURCE_OF_TRUTH_GATEWAY);

    // Start the subscription host (Nest would call onApplicationBootstrap).
    host.start();

    return { broker, host, gateway, close: () => moduleRef.close() };
  }

  it('routes inventory.held events from the broker into the gateway projection', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceMessage('inventory.held', 'bk_1'));
    await broker.drain();

    const settled = await gateway.collectSettled();
    expect(settled).toContainEqual(
      expect.objectContaining({ bookingId: 'bk_1', inventory: 'held' }),
    );

    await close();
  });

  it('routes supplier.confirmed events into the gateway projection', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceMessage('supplier.confirmed', 'bk_2'));
    await broker.drain();

    const settled = await gateway.collectSettled();
    expect(settled).toContainEqual(
      expect.objectContaining({ bookingId: 'bk_2', supplier: 'confirmed' }),
    );

    await close();
  });

  it('routes ledger.committed events into the gateway projection', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceMessage('ledger.committed', 'bk_3'));
    await broker.drain();

    const settled = await gateway.collectSettled();
    expect(settled).toContainEqual(
      expect.objectContaining({ bookingId: 'bk_3', ledger: 'committed' }),
    );

    await close();
  });

  it('assembles a full cross-source snapshot from all three source events', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceMessage('inventory.held', 'bk_4'));
    await broker.publish(sourceMessage('supplier.confirmed', 'bk_4'));
    await broker.publish(sourceMessage('ledger.committed', 'bk_4'));
    await broker.drain();

    const settled = await gateway.collectSettled();
    expect(settled).toContainEqual(
      expect.objectContaining({
        bookingId: 'bk_4',
        inventory: 'held',
        supplier: 'confirmed',
        ledger: 'committed',
      }),
    );

    await close();
  });

  it('propagates trace headers from the message onto the snapshot', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceMessage('inventory.held', 'bk_5'));
    await broker.drain();

    const settled = await gateway.collectSettled();
    const snap = settled.find((s) => s.bookingId === 'bk_5');
    expect(snap?.trace).toEqual({ traceparent: 'tp_bk_5' });

    await close();
  });
});
