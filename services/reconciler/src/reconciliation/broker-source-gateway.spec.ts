import { type BrokerMessage } from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';

function makeMessage(subject: string, bookingId: string | null, traceparent?: string): BrokerMessage {
  return {
    id: 'msg_1',
    subject,
    payload: bookingId !== null ? { bookingId } : {},
    headers: traceparent !== undefined ? { traceparent } : {},
  };
}

describe('BrokerSourceOfTruthGateway', () => {
  const BOOKING = 'bk_abc';

  describe('event projection', () => {
    it('projects inventory.held onto the booking snapshot', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('inventory.held', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: BOOKING, inventory: 'held', supplier: 'absent', ledger: 'absent' });
    });

    it('projects inventory.released', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('inventory.released', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ inventory: 'released' });
    });

    it('projects supplier.confirmed', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('supplier.confirmed', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ supplier: 'confirmed' });
    });

    it('projects supplier.cancelled', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('supplier.cancelled', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ supplier: 'cancelled' });
    });

    it('projects ledger.committed', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('ledger.committed', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ ledger: 'committed' });
    });

    it('projects ledger.reversed', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('ledger.reversed', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ ledger: 'reversed' });
    });

    it('assembles a full cross-source snapshot from multiple events', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('inventory.held', BOOKING));
      gateway.handleMessage(makeMessage('supplier.confirmed', BOOKING));
      gateway.handleMessage(makeMessage('ledger.committed', BOOKING));
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: BOOKING, inventory: 'held', supplier: 'confirmed', ledger: 'committed' });
    });

    it('keeps the first trace context seen for a booking (lineage is stable)', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('inventory.held', BOOKING, 'traceparent-first'));
      gateway.handleMessage(makeMessage('supplier.confirmed', BOOKING, 'traceparent-second'));
      const [snap] = await gateway.collectSettled();
      expect(snap!.trace).toEqual({ traceparent: 'traceparent-first' });
    });

    it('handles multiple bookings independently', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('inventory.held', 'bk_1'));
      gateway.handleMessage(makeMessage('ledger.committed', 'bk_2'));
      const snaps = await gateway.collectSettled();
      const ids = snaps.map((s) => s.bookingId).sort();
      expect(ids).toEqual(['bk_1', 'bk_2']);
    });
  });

  describe('settle-grace window', () => {
    it('excludes a booking observed within the grace period', async () => {
      const now = new Date('2026-06-29T10:00:00.000Z');
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 5_000, clock: () => now });
      gateway.handleMessage(makeMessage('ledger.committed', BOOKING));
      // Same instant — within the 5 s grace window
      const snaps = await gateway.collectSettled();
      expect(snaps).toHaveLength(0);
    });

    it('includes a booking once the grace period has elapsed', async () => {
      let now = new Date('2026-06-29T10:00:00.000Z');
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 5_000, clock: () => now });
      gateway.handleMessage(makeMessage('ledger.committed', BOOKING));
      // Advance 6 s past the observation
      now = new Date(now.getTime() + 6_000);
      const snaps = await gateway.collectSettled();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]).toMatchObject({ bookingId: BOOKING, ledger: 'committed' });
    });

    it('resets the grace window when a new event arrives (booking is still in-flight)', async () => {
      let now = new Date('2026-06-29T10:00:00.000Z');
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 5_000, clock: () => now });
      gateway.handleMessage(makeMessage('inventory.held', BOOKING));
      // 4 s later — another event arrives; the booking is still in-flight
      now = new Date(now.getTime() + 4_000);
      gateway.handleMessage(makeMessage('supplier.confirmed', BOOKING));
      // Now 4 s after the second event — total 8 s but within the 5 s grace from the last
      const snaps = await gateway.collectSettled();
      expect(snaps).toHaveLength(0);
      // 2 more seconds — now 6 s past the last event → settled
      now = new Date(now.getTime() + 6_000);
      const settled = await gateway.collectSettled();
      expect(settled).toHaveLength(1);
    });
  });

  describe('guard rails', () => {
    it('silently ignores a message with no bookingId', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      expect(() => gateway.handleMessage(makeMessage('inventory.held', null))).not.toThrow();
      expect(await gateway.collectSettled()).toHaveLength(0);
    });

    it('silently ignores an unknown subject', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      gateway.handleMessage(makeMessage('payment.authorized', BOOKING));
      // Nothing was recorded — the booking does not appear
      expect(await gateway.collectSettled()).toHaveLength(0);
    });

    it('returns no snapshots when no events have been received', async () => {
      const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      await expect(gateway.collectSettled()).resolves.toEqual([]);
    });
  });
});
