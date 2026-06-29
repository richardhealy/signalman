import { Test } from '@nestjs/testing';
import {
  BrokerSubscriptionHost,
  InMemoryBroker,
  type BrokerFromEnvResult,
  type BrokerMessage,
} from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-gateway';
import { MESSAGE_BROKER, ReconcilerModule } from './reconciler.module';

/**
 * Proves the per-service wiring, not the gateway mechanics (those live in
 * `broker-gateway.spec.ts`): that the {@link BrokerSubscriptionHost} the module
 * registers subscribes the gateway's handler to `inventory.*`, `supplier.*`, and
 * `ledger.*` on the *same* broker the service is configured with, so real source
 * events from the producing services actually update the reconciler's view of truth.
 *
 * The `MESSAGE_BROKER` provider is overridden with a shared in-memory broker the
 * test publishes onto, and the `BrokerSourceOfTruthGateway` provider with a
 * zero-grace-window gateway so events are visible in `collectSettled` without delay.
 */
describe('reconciler broker wiring', () => {
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
    // Zero settle-grace so settled snapshots are available immediately in the test.
    const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });

    const moduleRef = await Test.createTestingModule({ imports: [ReconcilerModule] })
      .overrideProvider(MESSAGE_BROKER)
      .useValue(brokerResult)
      .overrideProvider(BrokerSourceOfTruthGateway)
      .useValue(gateway)
      .compile();

    const host = moduleRef.get(BrokerSubscriptionHost);
    host.start();

    return { broker, host, gateway, close: () => moduleRef.close() };
  }

  /** A minimal BrokerMessage for a source-of-truth event. */
  function sourceEvent(subject: string, bookingId: string): BrokerMessage {
    return {
      id: `evt_${subject}_${bookingId}`,
      subject,
      payload: { bookingId, sku: 'S1', qty: 1, confirmationId: 'c_1', amount: 100, currency: 'USD', entryId: 'e_1' },
      headers: { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` },
    };
  }

  it('projects an inventory event off the broker into the gateway', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceEvent('inventory.held', 'bk_1'));
    await broker.drain();

    const settled = await gateway.collectSettled();
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ bookingId: 'bk_1', inventory: 'held' });

    await close();
  });

  it('projects a supplier event off the broker into the gateway', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceEvent('supplier.confirmed', 'bk_1'));
    await broker.drain();

    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ bookingId: 'bk_1', supplier: 'confirmed' });

    await close();
  });

  it('projects a ledger event off the broker into the gateway', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceEvent('ledger.committed', 'bk_1'));
    await broker.drain();

    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ bookingId: 'bk_1', ledger: 'committed' });

    await close();
  });

  it('assembles a full cross-source snapshot from events across all three subjects', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(sourceEvent('inventory.held', 'bk_1'));
    await broker.publish(sourceEvent('supplier.confirmed', 'bk_1'));
    await broker.publish(sourceEvent('ledger.committed', 'bk_1'));
    await broker.drain();

    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({
      bookingId: 'bk_1',
      inventory: 'held',
      supplier: 'confirmed',
      ledger: 'committed',
    });

    await close();
  });

  it('enables the reconciler to detect a divergence induced via broker events', async () => {
    const { broker, gateway, close } = await bootModule();

    // The headline divergence case: supplier confirmed, but ledger never committed.
    await broker.publish(sourceEvent('supplier.confirmed', 'bk_1'));
    await broker.drain();

    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({
      bookingId: 'bk_1',
      supplier: 'confirmed',
      ledger: 'absent',
    });
    // A reconcile pass over this snapshot would fire supplier_confirmed_ledger_missing.

    await close();
  });

  it('stops receiving events after the subscription host stops', async () => {
    const { broker, host, gateway, close } = await bootModule();

    // Deliver an event before stopping.
    await broker.publish(sourceEvent('inventory.held', 'bk_1'));
    await broker.drain();
    expect(await gateway.collectSettled()).toHaveLength(1);

    // Stop the host — subscriptions are dropped.
    await host.stop();

    // An event delivered after stop should not update the gateway.
    await broker.publish(sourceEvent('inventory.released', 'bk_2'));
    await broker.drain();
    const settled = await gateway.collectSettled();
    // bk_1 is still in the gateway (from before stop), but bk_2 is not.
    expect(settled.map((s) => s.bookingId)).not.toContain('bk_2');

    await close();
  });
});
