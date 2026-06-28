import { type BookingSnapshot } from './booking-snapshot';
import { detectDivergences } from './reconciliation';

function snapshot(overrides: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    bookingId: 'bk_1',
    inventory: 'absent',
    supplier: 'absent',
    ledger: 'absent',
    ...overrides,
  };
}

describe('detectDivergences', () => {
  describe('consistent bookings (no divergence)', () => {
    it('a completed booking — held, confirmed, committed', () => {
      expect(
        detectDivergences(snapshot({ inventory: 'held', supplier: 'confirmed', ledger: 'committed' })),
      ).toEqual([]);
    });

    it('a completed booking whose hold was released after confirmation', () => {
      expect(
        detectDivergences(snapshot({ inventory: 'released', supplier: 'confirmed', ledger: 'committed' })),
      ).toEqual([]);
    });

    it('a fully unwound booking — released, cancelled, reversed', () => {
      expect(
        detectDivergences(snapshot({ inventory: 'released', supplier: 'cancelled', ledger: 'reversed' })),
      ).toEqual([]);
    });

    it('a booking no source ever recorded — all absent', () => {
      expect(detectDivergences(snapshot())).toEqual([]);
    });
  });

  describe('supplier_confirmed_ledger_missing (the headline)', () => {
    it('fires when the supplier confirmed but the ledger has no record', () => {
      const found = detectDivergences(
        snapshot({ inventory: 'held', supplier: 'confirmed', ledger: 'absent' }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        kind: 'supplier_confirmed_ledger_missing',
        severity: 'critical',
        observed: { inventory: 'held', supplier: 'confirmed', ledger: 'absent' },
      });
      expect(found[0]!.detail).toContain('no committed financial record');
    });

    it('fires when the supplier confirmed but the ledger was reversed', () => {
      const found = detectDivergences(
        snapshot({ inventory: 'held', supplier: 'confirmed', ledger: 'reversed' }),
      );
      expect(found.map((d) => d.kind)).toEqual(['supplier_confirmed_ledger_missing']);
    });
  });

  describe('ledger_committed_supplier_unconfirmed (the mirror)', () => {
    it('fires when the ledger committed but the supplier cancelled', () => {
      const found = detectDivergences(
        snapshot({ inventory: 'held', supplier: 'cancelled', ledger: 'committed' }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        kind: 'ledger_committed_supplier_unconfirmed',
        severity: 'critical',
      });
      expect(found[0]!.detail).toContain('money is posted');
    });

    it('fires when the ledger committed but the supplier has no record', () => {
      const found = detectDivergences(
        snapshot({ inventory: 'released', supplier: 'absent', ledger: 'committed' }),
      );
      expect(found.map((d) => d.kind)).toEqual(['ledger_committed_supplier_unconfirmed']);
    });
  });

  describe('orphaned_hold', () => {
    it('fires when a hold stands on a booking that did not complete', () => {
      const found = detectDivergences(
        snapshot({ inventory: 'held', supplier: 'cancelled', ledger: 'reversed' }),
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'orphaned_hold', severity: 'warning' });
      expect(found[0]!.detail).toContain('never released');
    });

    it('fires for a held-only booking (settled but never progressed)', () => {
      const found = detectDivergences(snapshot({ inventory: 'held' }));
      expect(found.map((d) => d.kind)).toEqual(['orphaned_hold']);
    });

    it('does not fire when the hold belongs to a confirmed booking', () => {
      // supplier confirmed → the held inventory is the live reservation, not an orphan.
      const found = detectDivergences(
        snapshot({ inventory: 'held', supplier: 'confirmed', ledger: 'committed' }),
      );
      expect(found).toEqual([]);
    });
  });
});
