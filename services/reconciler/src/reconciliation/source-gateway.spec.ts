import { InMemorySourceOfTruthGateway } from './source-gateway';

describe('InMemorySourceOfTruthGateway', () => {
  it('assembles a per-booking snapshot from recorded source states', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    gateway.recordInventory('bk_1', 'held');
    gateway.recordSupplier('bk_1', 'confirmed');
    gateway.recordLedger('bk_1', 'committed');

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot).toMatchObject({
      bookingId: 'bk_1',
      inventory: 'held',
      supplier: 'confirmed',
      ledger: 'committed',
    });
  });

  it('defaults unrecorded sources to absent', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    gateway.recordSupplier('bk_1', 'confirmed');

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot).toMatchObject({ inventory: 'absent', supplier: 'confirmed', ledger: 'absent' });
  });

  it('keeps the first trace context seen for a booking (lineage is stable)', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    gateway.recordInventory('bk_1', 'held', { trace: { traceparent: 'first' } });
    gateway.recordLedger('bk_1', 'committed', { trace: { traceparent: 'second' } });

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot!.trace).toEqual({ traceparent: 'first' });
  });

  it('carries observedAt through, latest write wins', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    gateway.recordInventory('bk_1', 'held', { observedAt: new Date('2026-06-29T00:00:00Z') });
    gateway.recordLedger('bk_1', 'committed', { observedAt: new Date('2026-06-29T01:00:00Z') });

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot!.observedAt).toEqual(new Date('2026-06-29T01:00:00Z'));
  });

  it('returns every recorded booking', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    gateway.recordInventory('bk_1', 'held');
    gateway.recordInventory('bk_2', 'released');

    const snapshots = await gateway.collectSettled();
    expect(snapshots.map((s) => s.bookingId).sort()).toEqual(['bk_1', 'bk_2']);
  });

  describe('ordering by occurredAt', () => {
    const t = (minute: number): Date => new Date(`2026-10-06T09:0${minute}:00.000Z`);

    it('ignores an observation older than the state already recorded for that source', async () => {
      const gateway = new InMemorySourceOfTruthGateway();
      gateway.recordSupplier('bk_1', 'cancelled', { occurredAt: t(2) });
      gateway.recordSupplier('bk_1', 'confirmed', { occurredAt: t(1) });

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot!.supplier).toBe('cancelled');
    });

    it('applies an observation that is newer, or equally new', async () => {
      const gateway = new InMemorySourceOfTruthGateway();
      gateway.recordInventory('bk_1', 'held', { occurredAt: t(1) });
      gateway.recordInventory('bk_1', 'released', { occurredAt: t(2) });
      gateway.recordLedger('bk_1', 'committed', { occurredAt: t(3) });
      gateway.recordLedger('bk_1', 'reversed', { occurredAt: t(3) });

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ inventory: 'released', ledger: 'reversed' });
    });

    it('orders each source on its own clock', async () => {
      // A late inventory event is stale for inventory, whatever the supplier did since.
      const gateway = new InMemorySourceOfTruthGateway();
      gateway.recordSupplier('bk_1', 'confirmed', { occurredAt: t(5) });
      gateway.recordInventory('bk_1', 'held', { occurredAt: t(1) });

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({ inventory: 'held', supplier: 'confirmed' });
    });

    it('falls back to arrival order when either side has no occurredAt', async () => {
      const gateway = new InMemorySourceOfTruthGateway();
      gateway.recordInventory('bk_1', 'released', { occurredAt: t(2) });
      gateway.recordInventory('bk_1', 'held');
      gateway.recordSupplier('bk_2', 'cancelled');
      gateway.recordSupplier('bk_2', 'confirmed', { occurredAt: t(1) });

      const snapshots = await gateway.collectSettled();
      expect(snapshots.find((s) => s.bookingId === 'bk_1')!.inventory).toBe('held');
      expect(snapshots.find((s) => s.bookingId === 'bk_2')!.supplier).toBe('confirmed');
    });

    it('still takes trace and observedAt from a stale observation', async () => {
      const gateway = new InMemorySourceOfTruthGateway();
      gateway.recordSupplier('bk_1', 'cancelled', {
        occurredAt: t(2),
        observedAt: new Date('2026-10-06T09:10:00Z'),
      });
      gateway.recordSupplier('bk_1', 'confirmed', {
        occurredAt: t(1),
        observedAt: new Date('2026-10-06T09:20:00Z'),
        trace: { traceparent: 'late' },
      });

      const [snapshot] = await gateway.collectSettled();
      expect(snapshot).toMatchObject({
        supplier: 'cancelled',
        observedAt: new Date('2026-10-06T09:20:00Z'),
        trace: { traceparent: 'late' },
      });
    });
  });

  it('returns no bookings when nothing has been recorded', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    await expect(gateway.collectSettled()).resolves.toEqual([]);
  });
});
