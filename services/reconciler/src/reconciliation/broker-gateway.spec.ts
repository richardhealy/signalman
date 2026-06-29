import { type BrokerMessage } from '@signalman/broker';
import {
  BrokerSourceOfTruthGateway,
  DEFAULT_SETTLE_GRACE_MS,
} from './broker-gateway';

/** A minimal BrokerMessage for a source-of-truth event. */
function makeEvent(
  subject: string,
  bookingId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): BrokerMessage {
  return {
    id: `evt_${subject}_${bookingId}`,
    subject,
    payload: { bookingId, ...extra },
    headers,
  };
}

describe('BrokerSourceOfTruthGateway', () => {
  let now: Date;
  let gateway: BrokerSourceOfTruthGateway;

  beforeEach(() => {
    now = new Date('2026-06-29T12:00:00.000Z');
    gateway = new BrokerSourceOfTruthGateway({
      settleGraceMs: 5_000,
      clock: () => now,
    });
  });

  /** Deliver a message through the gateway's handler. */
  const deliver = (gw: BrokerSourceOfTruthGateway, message: BrokerMessage) =>
    gw.handler()(message);

  /** Advance the test clock by `ms` milliseconds. */
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };

  describe('event projection', () => {
    it('projects inventory.held into inventory=held', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1', { sku: 'S1', qty: 1 }));
      advance(10_000);
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', inventory: 'held' });
    });

    it('projects inventory.released into inventory=released', async () => {
      await deliver(gateway, makeEvent('inventory.released', 'bk_1', { sku: 'S1', qty: 1 }));
      advance(10_000);
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', inventory: 'released' });
    });

    it('projects supplier.confirmed into supplier=confirmed', async () => {
      await deliver(gateway, makeEvent('supplier.confirmed', 'bk_1', { confirmationId: 'c_1' }));
      advance(10_000);
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', supplier: 'confirmed' });
    });

    it('projects supplier.cancelled into supplier=cancelled', async () => {
      await deliver(gateway, makeEvent('supplier.cancelled', 'bk_1', { confirmationId: 'c_1' }));
      advance(10_000);
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', supplier: 'cancelled' });
    });

    it('projects ledger.committed into ledger=committed', async () => {
      await deliver(
        gateway,
        makeEvent('ledger.committed', 'bk_1', { amount: 4200, currency: 'USD', entryId: 'e_1' }),
      );
      advance(10_000);
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', ledger: 'committed' });
    });

    it('projects ledger.reversed into ledger=reversed', async () => {
      await deliver(
        gateway,
        makeEvent('ledger.reversed', 'bk_1', { amount: 4200, currency: 'USD', entryId: 'e_1' }),
      );
      advance(10_000);
      const [snap] = await gateway.collectSettled();
      expect(snap).toMatchObject({ bookingId: 'bk_1', ledger: 'reversed' });
    });

    it('assembles a full cross-source snapshot from multiple events', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1', { sku: 'S1', qty: 1 }));
      await deliver(gateway, makeEvent('supplier.confirmed', 'bk_1', { confirmationId: 'c_1' }));
      await deliver(
        gateway,
        makeEvent('ledger.committed', 'bk_1', { amount: 4200, currency: 'USD', entryId: 'e_1' }),
      );
      advance(10_000);

      const settled = await gateway.collectSettled();
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({
        bookingId: 'bk_1',
        inventory: 'held',
        supplier: 'confirmed',
        ledger: 'committed',
      });
    });

    it('handles multiple bookings independently', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1'));
      await deliver(
        gateway,
        makeEvent('ledger.committed', 'bk_2', { amount: 100, currency: 'USD', entryId: 'e_2' }),
      );
      advance(10_000);

      const settled = await gateway.collectSettled();
      const byId = Object.fromEntries(settled.map((s) => [s.bookingId, s]));
      expect(byId['bk_1']).toMatchObject({ inventory: 'held', ledger: 'absent' });
      expect(byId['bk_2']).toMatchObject({ inventory: 'absent', ledger: 'committed' });
    });

    it('ignores payment.* and other unknown subjects without throwing', async () => {
      await expect(
        deliver(gateway, makeEvent('payment.authorized', 'bk_1', { authId: 'auth_1' })),
      ).resolves.toBeUndefined();
      advance(10_000);
      // No snapshot produced: no source-of-truth event was recorded
      expect(await gateway.collectSettled()).toHaveLength(0);
    });
  });

  describe('settle-grace window', () => {
    it('excludes bookings observed within the grace window', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1'));
      // Clock still at observation time — booking is 0ms old, well within the 5s grace
      expect(await gateway.collectSettled()).toHaveLength(0);
    });

    it('includes a booking observed at exactly the grace boundary', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1'));
      advance(5_000); // cutoff = now - 5000 = observedAt → observedAt <= cutoff is true
      expect(await gateway.collectSettled()).toHaveLength(1);
    });

    it('includes bookings observed past the grace window', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1'));
      advance(6_000);
      const settled = await gateway.collectSettled();
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ bookingId: 'bk_1' });
    });

    it('resets the settle clock when a new event arrives for the same booking', async () => {
      await deliver(gateway, makeEvent('inventory.held', 'bk_1'));
      advance(4_000); // 4s later — still within 5s grace
      await deliver(gateway, makeEvent('supplier.confirmed', 'bk_1')); // resets observedAt

      advance(3_000); // 3s since the last event — still within grace
      expect(await gateway.collectSettled()).toHaveLength(0);

      advance(3_000); // 6s since the last event — now settled
      expect(await gateway.collectSettled()).toHaveLength(1);
    });

    it('returns no snapshots when nothing has been observed', async () => {
      expect(await gateway.collectSettled()).toHaveLength(0);
    });

    it('uses DEFAULT_SETTLE_GRACE_MS when no settleGraceMs option is provided', async () => {
      const gw = new BrokerSourceOfTruthGateway({ clock: () => now });
      await gw.handler()(makeEvent('inventory.held', 'bk_1'));
      advance(DEFAULT_SETTLE_GRACE_MS);
      expect(await gw.collectSettled()).toHaveLength(1);
    });
  });

  describe('trace context', () => {
    it('carries the trace headers from the first event into the snapshot', async () => {
      const firstHeaders = { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' };
      const secondHeaders = { traceparent: '00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01' };

      await deliver(gateway, makeEvent('inventory.held', 'bk_1', {}, firstHeaders));
      await deliver(gateway, makeEvent('supplier.confirmed', 'bk_1', {}, secondHeaders));
      advance(10_000);

      const [snap] = await gateway.collectSettled();
      // First trace context wins — the booking's lineage is stable across its events
      expect(snap!.trace).toEqual(firstHeaders);
    });

    it('stamps observedAt on each snapshot', async () => {
      const observedAt = new Date(now);
      await deliver(
        gateway,
        makeEvent('ledger.committed', 'bk_1', { amount: 100, currency: 'USD', entryId: 'e_1' }),
      );
      advance(10_000);

      const [snap] = await gateway.collectSettled();
      expect(snap!.observedAt).toEqual(observedAt);
    });
  });
});
