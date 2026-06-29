import { type BrokerMessage } from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';

describe('BrokerSourceOfTruthGateway', () => {
  let now: Date;
  let gateway: BrokerSourceOfTruthGateway;

  const SETTLE_GRACE_MS = 5_000;

  beforeEach(() => {
    now = new Date('2026-06-29T12:00:00Z');
    gateway = new BrokerSourceOfTruthGateway({
      settleGraceMs: SETTLE_GRACE_MS,
      clock: () => now,
    });
  });

  function advance(ms: number): void {
    now = new Date(now.getTime() + ms);
  }

  function message(subject: string, bookingId: string, traceparent = 'tp_' + bookingId): BrokerMessage {
    return {
      id: `msg_${subject}_${bookingId}`,
      subject,
      payload: { bookingId },
      headers: { traceparent },
    };
  }

  // --- subject routing ---

  it('maps inventory.held to the held inventory state', async () => {
    gateway.handle(message('inventory.held', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ bookingId: 'bk_1', inventory: 'held' });
  });

  it('maps inventory.released to the released inventory state', async () => {
    gateway.handle(message('inventory.released', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ inventory: 'released' });
  });

  it('maps supplier.confirmed to the confirmed supplier state', async () => {
    gateway.handle(message('supplier.confirmed', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ supplier: 'confirmed' });
  });

  it('maps supplier.cancelled to the cancelled supplier state', async () => {
    gateway.handle(message('supplier.cancelled', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ supplier: 'cancelled' });
  });

  it('maps ledger.committed to the committed ledger state', async () => {
    gateway.handle(message('ledger.committed', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ ledger: 'committed' });
  });

  it('maps ledger.reversed to the reversed ledger state', async () => {
    gateway.handle(message('ledger.reversed', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ ledger: 'reversed' });
  });

  it('ignores unknown subjects without updating any projection', async () => {
    gateway.handle(message('payment.authorized', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const settled = await gateway.collectSettled();
    // payment events are not a source of truth the reconciler tracks
    expect(settled).toHaveLength(0);
  });

  it('ignores messages with no payload bookingId', async () => {
    const bad: BrokerMessage = { id: 'x', subject: 'inventory.held', payload: {}, headers: {} };
    expect(() => gateway.handle(bad)).not.toThrow();
    advance(SETTLE_GRACE_MS + 1);
    expect(await gateway.collectSettled()).toHaveLength(0);
  });

  // --- cross-source projection ---

  it('assembles a full cross-source projection from multiple events', async () => {
    gateway.handle(message('inventory.held', 'bk_1'));
    gateway.handle(message('supplier.confirmed', 'bk_1'));
    gateway.handle(message('ledger.committed', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({
      bookingId: 'bk_1',
      inventory: 'held',
      supplier: 'confirmed',
      ledger: 'committed',
    });
  });

  it('defaults unobserved sources to absent', async () => {
    gateway.handle(message('supplier.confirmed', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap).toMatchObject({ inventory: 'absent', supplier: 'confirmed', ledger: 'absent' });
  });

  it('handles multiple bookings independently', async () => {
    gateway.handle(message('inventory.held', 'bk_1'));
    gateway.handle(message('ledger.committed', 'bk_2'));
    advance(SETTLE_GRACE_MS + 1);
    const settled = await gateway.collectSettled();
    const byId = Object.fromEntries(settled.map((s) => [s.bookingId, s]));
    expect(byId['bk_1']).toMatchObject({ inventory: 'held', ledger: 'absent' });
    expect(byId['bk_2']).toMatchObject({ inventory: 'absent', ledger: 'committed' });
  });

  // --- trace propagation ---

  it('propagates the message trace headers onto the snapshot', async () => {
    gateway.handle(message('inventory.held', 'bk_1', 'tp_original'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap.trace).toEqual({ traceparent: 'tp_original' });
  });

  it('keeps the first trace context seen for a booking (lineage is stable)', async () => {
    gateway.handle(message('inventory.held', 'bk_1', 'tp_first'));
    gateway.handle(message('ledger.committed', 'bk_1', 'tp_second'));
    advance(SETTLE_GRACE_MS + 1);
    const [snap] = await gateway.collectSettled();
    expect(snap.trace).toEqual({ traceparent: 'tp_first' });
  });

  // --- settle-grace window ---

  it('omits bookings whose last event is within the settle-grace window', async () => {
    gateway.handle(message('inventory.held', 'bk_1'));
    // Only 2 seconds passed; grace is 5 seconds
    advance(2_000);
    expect(await gateway.collectSettled()).toHaveLength(0);
  });

  it('returns bookings after the settle-grace window passes', async () => {
    gateway.handle(message('inventory.held', 'bk_1'));
    advance(SETTLE_GRACE_MS + 1);
    expect(await gateway.collectSettled()).toHaveLength(1);
  });

  it('resets the settle window when a later event arrives for the same booking', async () => {
    gateway.handle(message('inventory.held', 'bk_1'));
    advance(4_000); // close to settled
    gateway.handle(message('supplier.confirmed', 'bk_1')); // resets observedAt
    advance(2_000); // only 2s after the reset; grace is 5s
    // The booking should not be settled yet (2s < 5s grace from the last event)
    expect(await gateway.collectSettled()).toHaveLength(0);
  });

  it('returns no bookings when nothing has been observed', async () => {
    advance(SETTLE_GRACE_MS + 1);
    expect(await gateway.collectSettled()).toHaveLength(0);
  });
});
