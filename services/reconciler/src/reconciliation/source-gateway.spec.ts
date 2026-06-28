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

  it('returns no bookings when nothing has been recorded', async () => {
    const gateway = new InMemorySourceOfTruthGateway();
    await expect(gateway.collectSettled()).resolves.toEqual([]);
  });
});
