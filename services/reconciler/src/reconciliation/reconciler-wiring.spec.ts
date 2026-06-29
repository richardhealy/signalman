import { Test } from '@nestjs/testing';
import {
  BrokerSubscriptionHost,
  InMemoryBroker,
  type BrokerFromEnvResult,
  type BrokerMessage,
} from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';
import { ReconcilerService } from './reconciler.service';
import { MESSAGE_BROKER, ReconcilerModule, SOURCE_OF_TRUTH_GATEWAY } from './reconciler.module';

/** Minimal source-event messages the broker relay would publish. */
function inventoryHeld(bookingId: string): BrokerMessage {
  return { id: `inv_${bookingId}`, subject: 'inventory.held', payload: { bookingId, sku: 'SKU-1', qty: 1 }, headers: {} };
}
function supplierConfirmed(bookingId: string): BrokerMessage {
  return { id: `sup_${bookingId}`, subject: 'supplier.confirmed', payload: { bookingId, sku: 'SKU-1', qty: 1, confirmationId: `c_${bookingId}` }, headers: {} };
}
function ledgerCommitted(bookingId: string): BrokerMessage {
  return { id: `led_${bookingId}`, subject: 'ledger.committed', payload: { bookingId, amount: 100, currency: 'USD', entryId: `e_${bookingId}` }, headers: {} };
}
function ledgerReversed(bookingId: string): BrokerMessage {
  return { id: `lrev_${bookingId}`, subject: 'ledger.reversed', payload: { bookingId, amount: 100, currency: 'USD', entryId: `e_${bookingId}` }, headers: {} };
}

/**
 * Proves the per-service wiring: that the {@link BrokerSubscriptionHost} the module
 * registers subscribes the gateway to `inventory.*`, `supplier.*`, and `ledger.*`
 * on the configured broker, so events arriving on those subjects drive the
 * source-of-truth projection — the input the {@link ReconcilerService} reads when
 * it runs a reconciliation pass.
 *
 * The `MESSAGE_BROKER` provider is overridden with a shared in-memory broker the
 * test publishes onto. The `SOURCE_OF_TRUTH_GATEWAY` is overridden where needed
 * with a 0ms settle-grace gateway so the reconciler can compare bookings
 * immediately after the events arrive.
 */
describe('reconciler subscription wiring', () => {
  /** Boot the module with a shared in-memory broker, using default settle-grace. */
  async function bootModule(): Promise<{
    broker: InMemoryBroker;
    host: BrokerSubscriptionHost;
    gateway: BrokerSourceOfTruthGateway;
    service: ReconcilerService;
    close: () => Promise<void>;
  }> {
    const broker = new InMemoryBroker();
    const brokerResult: BrokerFromEnvResult = { broker, kind: 'memory', close: () => Promise.resolve() };

    const moduleRef = await Test.createTestingModule({ imports: [ReconcilerModule] })
      .overrideProvider(MESSAGE_BROKER)
      .useValue(brokerResult)
      .compile();

    const host = moduleRef.get(BrokerSubscriptionHost);
    const gateway = moduleRef.get<BrokerSourceOfTruthGateway>(SOURCE_OF_TRUTH_GATEWAY);
    const service = moduleRef.get(ReconcilerService);
    host.start();

    return { broker, host, gateway, service, close: () => moduleRef.close() };
  }

  /**
   * Boot with a 0ms settle-grace gateway so `collectSettled()` returns bookings
   * immediately — lets the integration tests call `service.runOnce()` right after
   * the events are drained, without real-time delay.
   */
  async function bootModuleZeroGrace(): Promise<{
    broker: InMemoryBroker;
    host: BrokerSubscriptionHost;
    gateway: BrokerSourceOfTruthGateway;
    service: ReconcilerService;
    close: () => Promise<void>;
  }> {
    const broker = new InMemoryBroker();
    const brokerResult: BrokerFromEnvResult = { broker, kind: 'memory', close: () => Promise.resolve() };
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

  describe('projection — events arriving on the broker update the source-of-truth projection', () => {
    it('records an inventory.held event', async () => {
      const { broker, gateway, close } = await bootModule();

      await broker.publish(inventoryHeld('bk_1'));
      await broker.drain();

      const allSnapshots = await gateway['inner'].collectSettled();
      expect(allSnapshots.find((s) => s.bookingId === 'bk_1')?.inventory).toBe('held');
      await close();
    });

    it('records supplier.confirmed and ledger.committed for the same booking', async () => {
      const { broker, gateway, close } = await bootModule();

      await broker.publish(supplierConfirmed('bk_1'));
      await broker.publish(ledgerCommitted('bk_1'));
      await broker.drain();

      const allSnapshots = await gateway['inner'].collectSettled();
      const snap = allSnapshots.find((s) => s.bookingId === 'bk_1');
      expect(snap?.supplier).toBe('confirmed');
      expect(snap?.ledger).toBe('committed');
      await close();
    });

    it('tracks multiple bookings independently', async () => {
      const { broker, gateway, close } = await bootModule();

      await broker.publish(inventoryHeld('bk_1'));
      await broker.publish(inventoryHeld('bk_2'));
      await broker.publish(ledgerCommitted('bk_2'));
      await broker.drain();

      const allSnapshots = await gateway['inner'].collectSettled();
      const byId = Object.fromEntries(allSnapshots.map((s) => [s.bookingId, s]));
      expect(byId['bk_1']?.inventory).toBe('held');
      expect(byId['bk_2']?.inventory).toBe('held');
      expect(byId['bk_2']?.ledger).toBe('committed');
      await close();
    });

    it('supersedes ledger.committed with a later ledger.reversed (compensation)', async () => {
      const { broker, gateway, close } = await bootModule();

      await broker.publish(ledgerCommitted('bk_1'));
      await broker.drain();
      await broker.publish(ledgerReversed('bk_1'));
      await broker.drain();

      const allSnapshots = await gateway['inner'].collectSettled();
      const snap = allSnapshots.find((s) => s.bookingId === 'bk_1');
      expect(snap?.ledger).toBe('reversed');
      await close();
    });
  });

  describe('reconciler integration — events drive the full reconcile pass', () => {
    it('a consistent settled booking produces no divergences', async () => {
      const { broker, service, close } = await bootModuleZeroGrace();

      await broker.publish(inventoryHeld('bk_1'));
      await broker.publish(supplierConfirmed('bk_1'));
      await broker.publish(ledgerCommitted('bk_1'));
      await broker.drain();

      const report = await service.runOnce();
      expect(report.findingsCreated).toHaveLength(0);
      expect(report.bookingsScanned).toBe(1);
      await close();
    });

    it('detects supplier_confirmed_ledger_missing when ledger event is absent', async () => {
      const { broker, service, close } = await bootModuleZeroGrace();

      await broker.publish(inventoryHeld('bk_1'));
      await broker.publish(supplierConfirmed('bk_1'));
      // ledger.committed deliberately absent → divergence
      await broker.drain();

      const report = await service.runOnce();
      expect(report.findingsCreated.some((f) => f.kind === 'supplier_confirmed_ledger_missing')).toBe(true);
      await close();
    });
  });
});
