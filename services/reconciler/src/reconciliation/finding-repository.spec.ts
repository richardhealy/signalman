import { InMemoryDivergenceFindingRepository } from './finding-repository';
import { type DivergenceFinding } from './finding';

function finding(overrides: Partial<DivergenceFinding> = {}): DivergenceFinding {
  return {
    id: 'fnd_1',
    bookingId: 'bk_1',
    kind: 'orphaned_hold',
    severity: 'warning',
    detail: 'the hold was never released',
    observed: { inventory: 'held', supplier: 'cancelled', ledger: 'reversed' },
    detectedAt: new Date('2026-06-29T00:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryDivergenceFindingRepository', () => {
  it('saves a finding and reads it back by booking', async () => {
    const repo = new InMemoryDivergenceFindingRepository();
    await repo.save(finding());

    await expect(repo.findByBooking('bk_1')).resolves.toEqual([finding()]);
    await expect(repo.has({ bookingId: 'bk_1', kind: 'orphaned_hold' })).resolves.toBe(true);
  });

  it('reports has() false for an unrecorded (booking, kind)', async () => {
    const repo = new InMemoryDivergenceFindingRepository();
    await repo.save(finding());

    await expect(repo.has({ bookingId: 'bk_1', kind: 'supplier_confirmed_ledger_missing' })).resolves.toBe(false);
    await expect(repo.has({ bookingId: 'bk_2', kind: 'orphaned_hold' })).resolves.toBe(false);
  });

  it('is idempotent per (bookingId, kind): a re-save of the same key does not duplicate', async () => {
    const repo = new InMemoryDivergenceFindingRepository();
    await repo.save(finding({ id: 'fnd_1' }));
    await repo.save(finding({ id: 'fnd_2' })); // same booking + kind, different id

    const all = await repo.findByBooking('bk_1');
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('fnd_1'); // the first write stands
  });

  it('keeps distinct kinds for the same booking', async () => {
    const repo = new InMemoryDivergenceFindingRepository();
    await repo.save(finding({ id: 'fnd_1', kind: 'orphaned_hold' }));
    await repo.save(finding({ id: 'fnd_2', kind: 'supplier_confirmed_ledger_missing' }));

    const all = await repo.findByBooking('bk_1');
    expect(all.map((f) => f.kind).sort()).toEqual([
      'orphaned_hold',
      'supplier_confirmed_ledger_missing',
    ]);
  });

  it('hands back copies so callers cannot mutate stored state', async () => {
    const repo = new InMemoryDivergenceFindingRepository();
    await repo.save(finding());

    const [read] = await repo.findByBooking('bk_1');
    (read as { detail: string }).detail = 'mutated';

    const [reread] = await repo.findByBooking('bk_1');
    expect(reread!.detail).toBe('the hold was never released');
  });
});
