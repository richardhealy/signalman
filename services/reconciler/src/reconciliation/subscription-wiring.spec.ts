import { Test } from '@nestjs/testing';
import {
  BrokerSubscriptionHost,
  InMemoryBroker,
  type BrokerFromEnvResult,
  type BrokerMessage,
} from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';
import {
  MESSAGE_BROKER,
  ReconcilerModule,
  SOURCE_OF_TRUTH_GATEWAY,
} from './reconciler.module';
import { ReconcilerService } from './reconciler.service';

function event(subject: string, bookingId: string, id: string): BrokerMessage {
  return { id, subject, payload: { bookingId }, headers: {} };
}

/**
 * Proves that the {@link BrokerSubscriptionHost} the module registers feeds
 * deliveries from the broker into the {@link BrokerSourceOfTruthGateway}, so a
 * published source event actually updates the reconciler's projection and the
 * service detects the resulting divergence on the next pass.
 *
 * {@link MESSAGE_BROKER} is overridden with a shared in-memory broker so the
 * test controls what is published. {@link SOURCE_OF_TRUTH_GATEWAY} is overridden
 * with a {@link BrokerSourceOfTruthGateway} using `settleGraceMs: 0` so settled
 * bookings are returned immediately without waiting for the grace window.
 */
describe('reconciler subscription wiring', () => {
  async function bootModule(): Promise<{
    broker: InMemoryBroker;
    host: BrokerSubscriptionHost;
    gateway: BrokerSourceOfTruthGateway;
    service: ReconcilerService;
    close: () => Promise<void>;
  }> {
    const broker = new InMemoryBroker();
    const brokerResult: BrokerFromEnvResult = {
      broker,
      kind: 'memory',
      close: () => Promise.resolve(),
    };
    // Grace window of 0 so all recorded bookings are immediately settled.
    const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });

    const moduleRef = await Test.createTestingModule({ imports: [ReconcilerModule] })
      .overrideProvider(MESSAGE_BROKER)
      .useValue(brokerResult)
      .overrideProvider(SOURCE_OF_TRUTH_GATEWAY)
      .useValue(gateway)
      .compile();

    const host = moduleRef.get(BrokerSubscriptionHost);
    const service = moduleRef.get(ReconcilerService);
    host.start();

    return { broker, host, gateway, service, close: () => moduleRef.close() };
  }

  it('projects an inventory.held event into the source-of-truth snapshot', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(event('inventory.held', 'bk_1', 'evt_1'));
    await broker.drain();

    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ bookingId: 'bk_1', inventory: 'held' });

    await close();
  });

  it('projects supplier.confirmed and ledger.committed for the same booking', async () => {
    const { broker, gateway, close } = await bootModule();

    await broker.publish(event('inventory.held', 'bk_2', 'e1'));
    await broker.publish(event('supplier.confirmed', 'bk_2', 'e2'));
    await broker.publish(event('ledger.committed', 'bk_2', 'e3'));
    await broker.drain();

    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({
      bookingId: 'bk_2',
      inventory: 'held',
      supplier: 'confirmed',
      ledger: 'committed',
    });

    await close();
  });

  it('detects a supplier_confirmed_ledger_missing divergence from real broker events', async () => {
    const { broker, service, close } = await bootModule();

    // Supplier confirmed but ledger never committed — the headline divergence.
    await broker.publish(event('inventory.held', 'bk_3', 'e1'));
    await broker.publish(event('supplier.confirmed', 'bk_3', 'e2'));
    await broker.drain();

    const { findingsCreated } = await service.runOnce();
    expect(findingsCreated.some((f) => f.bookingId === 'bk_3' && f.kind === 'supplier_confirmed_ledger_missing')).toBe(true);

    await close();
  });

  it('dedups findings — a second runOnce does not re-record the same divergence', async () => {
    const { broker, service, close } = await bootModule();

    await broker.publish(event('supplier.confirmed', 'bk_4', 'e1'));
    await broker.drain();

    const first = await service.runOnce();
    expect(first.findingsCreated.some((f) => f.bookingId === 'bk_4')).toBe(true);

    // Second pass — already on file, so no new findings.
    const second = await service.runOnce();
    expect(second.findingsCreated.filter((f) => f.bookingId === 'bk_4')).toHaveLength(0);

    await close();
  });
});
