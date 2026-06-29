import { type BrokerMessage } from '@signalman/broker';
import { BrokerSourceOfTruthGateway, DEFAULT_SETTLE_GRACE_MS } from './broker-source-gateway';

/** Build a minimal BrokerMessage for a source event. */
function msg(
  subject: string,
  bookingId: string,
  extra: Partial<BrokerMessage> = {},
): BrokerMessage {
  return {
    id: `msg_${subject}_${bookingId}`,
    subject,
    payload: { bookingId, ...((extra.payload as object) ?? {}) },
    headers: extra.headers ?? {},
    ...extra,
  };
}

describe('BrokerSourceOfTruthGateway', () => {
  describe('event projection', () => {
    it('maps inventory.held to held state', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onInventoryEvent(msg('inventory.held', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s).toMatchObject({ bookingId: 'bk_1', inventory: 'held' });
    });

    it('maps inventory.released to released state', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onInventoryEvent(msg('inventory.released', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.inventory).toBe('released');
    });

    it('maps supplier.confirmed to confirmed state', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onSupplierEvent(msg('supplier.confirmed', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.supplier).toBe('confirmed');
    });

    it('maps supplier.cancelled to cancelled state', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onSupplierEvent(msg('supplier.cancelled', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.supplier).toBe('cancelled');
    });

    it('maps ledger.committed to committed state', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onLedgerEvent(msg('ledger.committed', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.ledger).toBe('committed');
    });

    it('maps ledger.reversed to reversed state', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onLedgerEvent(msg('ledger.reversed', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.ledger).toBe('reversed');
    });

    it('assembles a full cross-source snapshot from three events', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onInventoryEvent(msg('inventory.held', 'bk_1'));
      gw.onSupplierEvent(msg('supplier.confirmed', 'bk_1'));
      gw.onLedgerEvent(msg('ledger.committed', 'bk_1'));

      const [s] = await gw.collectSettled();
      expect(s).toMatchObject({
        bookingId: 'bk_1',
        inventory: 'held',
        supplier: 'confirmed',
        ledger: 'committed',
      });
    });

    it('later event supersedes earlier state for the same source', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onInventoryEvent(msg('inventory.held', 'bk_1'));
      gw.onInventoryEvent(msg('inventory.released', 'bk_1'));

      const [s] = await gw.collectSettled();
      expect(s!.inventory).toBe('released');
    });

    it('tracks multiple bookings independently', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onInventoryEvent(msg('inventory.held', 'bk_1'));
      gw.onInventoryEvent(msg('inventory.released', 'bk_2'));

      const snapshots = await gw.collectSettled();
      const byId = Object.fromEntries(snapshots.map((s) => [s.bookingId, s]));
      expect(byId['bk_1']!.inventory).toBe('held');
      expect(byId['bk_2']!.inventory).toBe('released');
    });

    it('defaults unseen sources to absent', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onSupplierEvent(msg('supplier.confirmed', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s).toMatchObject({ inventory: 'absent', supplier: 'confirmed', ledger: 'absent' });
    });

    it('carries the trace context from the first event', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onInventoryEvent(msg('inventory.held', 'bk_1', { headers: { traceparent: 'tp-1' } }));
      gw.onSupplierEvent(msg('supplier.confirmed', 'bk_1', { headers: { traceparent: 'tp-2' } }));

      const [s] = await gw.collectSettled();
      expect(s!.trace).toEqual({ traceparent: 'tp-1' });
    });
  });

  describe('settle-grace window', () => {
    it('hides bookings whose last event is within the grace window', async () => {
      const now = 1000;
      const clock = jest.fn(() => now);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 5000, clock });

      gw.onLedgerEvent(msg('ledger.committed', 'bk_1'));
      // Last event at t=1000; now=1000 → 0ms elapsed, still within grace.
      await expect(gw.collectSettled()).resolves.toEqual([]);
    });

    it('returns a booking once the grace window has elapsed', async () => {
      let now = 1000;
      const clock = jest.fn(() => now);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 5000, clock });

      gw.onLedgerEvent(msg('ledger.committed', 'bk_1'));
      now = 6001; // 5001ms after the event → past the grace window
      const snapshots = await gw.collectSettled();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.bookingId).toBe('bk_1');
    });

    it('resets the grace timer on each new event', async () => {
      let now = 1000; // mutable: advanced to simulate time passing
      const clock = jest.fn(() => now);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 5000, clock });

      gw.onInventoryEvent(msg('inventory.held', 'bk_1'));
      now = 5999; // almost past grace
      gw.onLedgerEvent(msg('ledger.committed', 'bk_1')); // resets timer
      now = 9000; // 3001ms after the last event — still within grace
      await expect(gw.collectSettled()).resolves.toEqual([]);

      now = 11001; // now 5001ms past the ledger event
      const snapshots = await gw.collectSettled();
      expect(snapshots).toHaveLength(1);
    });

    it('settles immediately when settleGraceMs is 0', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });

      gw.onLedgerEvent(msg('ledger.committed', 'bk_1'));
      const snapshots = await gw.collectSettled();
      expect(snapshots).toHaveLength(1);
    });

    it('returns nothing when nothing has been recorded', async () => {
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
      await expect(gw.collectSettled()).resolves.toEqual([]);
    });
  });

  describe('subscriptions()', () => {
    it('returns three subscription entries covering the three source streams', () => {
      const gw = new BrokerSourceOfTruthGateway();
      const subs = gw.subscriptions();
      const subjects = subs.map((s) => s.subjects);
      expect(subjects).toEqual(
        expect.arrayContaining(['inventory.*', 'supplier.*', 'ledger.*']),
      );
      expect(subs).toHaveLength(3);
    });

    it('inventory.* handler records events into the projection', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });
      const [inventorySub] = gw.subscriptions();

      await inventorySub!.handler(msg('inventory.held', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.inventory).toBe('held');
    });

    it('supplier.* handler records events into the projection', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });
      const subs = gw.subscriptions();
      const supplierSub = subs.find((s) => s.subjects === 'supplier.*');

      await supplierSub!.handler(msg('supplier.confirmed', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.supplier).toBe('confirmed');
    });

    it('ledger.* handler records events into the projection', async () => {
      const clock = jest.fn().mockReturnValue(0);
      const gw = new BrokerSourceOfTruthGateway({ settleGraceMs: 0, clock });
      const subs = gw.subscriptions();
      const ledgerSub = subs.find((s) => s.subjects === 'ledger.*');

      await ledgerSub!.handler(msg('ledger.committed', 'bk_1'));
      const [s] = await gw.collectSettled();
      expect(s!.ledger).toBe('committed');
    });
  });

  describe('DEFAULT_SETTLE_GRACE_MS', () => {
    it('is a positive number large enough to cover a mid-saga state', () => {
      expect(DEFAULT_SETTLE_GRACE_MS).toBeGreaterThan(0);
      expect(typeof DEFAULT_SETTLE_GRACE_MS).toBe('number');
    });
  });
});
