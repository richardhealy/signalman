import { InMemoryBroker } from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';

/**
 * Wire the gateway's subscriptions into a fresh broker and publish one event,
 * then drain so all deliveries have settled before assertions run.
 */
async function emit(
  broker: InMemoryBroker,
  subject: string,
  bookingId: string,
  headers: Record<string, string> = {},
): Promise<void> {
  let seq = 0;
  await broker.publish({ id: `msg-${++seq}`, subject, payload: { bookingId }, headers });
  await broker.drain();
}

function wireGateway(
  gateway: BrokerSourceOfTruthGateway,
  broker: InMemoryBroker,
): void {
  for (const sub of gateway.subscriptions()) {
    broker.subscribe(sub.subjects, sub.handler);
  }
}

describe('BrokerSourceOfTruthGateway', () => {
  describe('event projection', () => {
    it('projects inventory.held', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'inventory.held', 'bk_1');

      const snapshots = await gateway.collectSettled();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ bookingId: 'bk_1', inventory: 'held', supplier: 'absent', ledger: 'absent' });
    });

    it('projects inventory.released', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'inventory.released', 'bk_1');

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ inventory: 'released' });
    });

    it('projects supplier.confirmed', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'supplier.confirmed', 'bk_1');

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ supplier: 'confirmed' });
    });

    it('projects supplier.cancelled', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'supplier.cancelled', 'bk_1');

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ supplier: 'cancelled' });
    });

    it('projects ledger.committed', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'ledger.committed', 'bk_1');

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ ledger: 'committed' });
    });

    it('projects ledger.reversed', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'ledger.reversed', 'bk_1');

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ ledger: 'reversed' });
    });

    it('assembles a cross-source snapshot from multiple events for the same booking', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'inventory.held', 'bk_1');
      await emit(broker, 'supplier.confirmed', 'bk_1');
      await emit(broker, 'ledger.committed', 'bk_1');

      const snapshots = await gateway.collectSettled();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        bookingId: 'bk_1',
        inventory: 'held',
        supplier: 'confirmed',
        ledger: 'committed',
      });
    });

    it('tracks multiple bookings independently', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'inventory.held', 'bk_1');
      await emit(broker, 'supplier.confirmed', 'bk_2');

      const snapshots = await gateway.collectSettled();
      expect(snapshots).toHaveLength(2);
      const bk1 = snapshots.find((s) => s.bookingId === 'bk_1');
      const bk2 = snapshots.find((s) => s.bookingId === 'bk_2');
      expect(bk1).toMatchObject({ inventory: 'held', supplier: 'absent', ledger: 'absent' });
      expect(bk2).toMatchObject({ inventory: 'absent', supplier: 'confirmed', ledger: 'absent' });
    });

    it('passes trace headers through as the booking trace context', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await broker.publish({
        id: 'msg-tp',
        subject: 'ledger.committed',
        payload: { bookingId: 'bk_1' },
        headers: { traceparent: '00-trace-span-01' },
      });
      await broker.drain();

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot?.trace).toEqual({ traceparent: '00-trace-span-01' });
    });
  });

  describe('settle-grace window', () => {
    it('withholds bookings whose last event is within the grace window', async () => {
      let now = 0;
      const clock = () => new Date(now);
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 1_000, clock });
      wireGateway(gateway, broker);

      now = 500;
      await emit(broker, 'ledger.committed', 'bk_1');

      // At t=1_400: cutoff = 1_400 - 1_000 = 400. observedAt (500) > 400 → withheld.
      now = 1_400;
      expect(await gateway.collectSettled()).toHaveLength(0);
    });

    it('returns bookings whose last event is past the grace window', async () => {
      let now = 0;
      const clock = () => new Date(now);
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 1_000, clock });
      wireGateway(gateway, broker);

      now = 0;
      await emit(broker, 'ledger.committed', 'bk_1');

      // At t=1_001: cutoff = 1_001 - 1_000 = 1. observedAt (0) <= 1 → settled.
      now = 1_001;
      expect(await gateway.collectSettled()).toHaveLength(1);
    });

    it('resets the settle timer when a later event arrives', async () => {
      let now = 0;
      const clock = () => new Date(now);
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 1_000, clock });
      wireGateway(gateway, broker);

      // First event at t=0.
      now = 0;
      await emit(broker, 'inventory.held', 'bk_1');

      // Second event at t=900 — resets the observe time to 900.
      now = 900;
      await emit(broker, 'ledger.committed', 'bk_1');

      // At t=1_050: cutoff = 50. observedAt (900) > 50 → withheld (even though
      // 1_050ms have passed since the first event, only 150ms since the last).
      now = 1_050;
      expect(await gateway.collectSettled()).toHaveLength(0);

      // At t=1_901: cutoff = 901. observedAt (900) <= 901 → settled.
      now = 1_901;
      expect(await gateway.collectSettled()).toHaveLength(1);
    });

    it('returns all bookings when settleGraceMs is 0', async () => {
      const broker = new InMemoryBroker();
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      wireGateway(gateway, broker);

      await emit(broker, 'ledger.committed', 'bk_1');

      expect(await gateway.collectSettled()).toHaveLength(1);
    });

    it('returns an empty list when nothing has been observed', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      expect(await gateway.collectSettled()).toEqual([]);
    });
  });

  describe('subscriptions()', () => {
    it('returns subscriptions covering inventory.*, supplier.*, and ledger.*', () => {
      const gateway = new BrokerSourceOfTruthGateway();
      const subjects = gateway.subscriptions().map((s) => s.subjects);
      expect(subjects).toContain('inventory.*');
      expect(subjects).toContain('supplier.*');
      expect(subjects).toContain('ledger.*');
    });
  });
});
