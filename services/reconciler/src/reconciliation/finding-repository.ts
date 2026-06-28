/**
 * Persistence for the reconciler's source of truth: the {@link DivergenceFinding}
 * records.
 *
 * The contract is database-agnostic so the reconciler and its tests run against
 * {@link InMemoryDivergenceFindingRepository} without a live datastore. The
 * production implementation backs this with the reconciler's own Postgres. The
 * one behaviour every implementation must honour is idempotency per
 * `(bookingId, kind)`: a reconciliation pass re-examining a still-diverged
 * booking records the finding once, not once per pass — otherwise a recurring
 * drift would bury the dashboard in duplicates.
 */
import { type DivergenceFinding, type DivergenceKind } from './finding';

/** Identity of a finding for dedup: a booking and the divergence kind. */
export interface FindingKey {
  bookingId: string;
  kind: DivergenceKind;
}

/** The persistence seam a finding write goes through. */
export interface DivergenceFindingRepository {
  /** Every finding recorded for a booking, in insertion order. */
  findByBooking(bookingId: string): Promise<DivergenceFinding[]>;

  /**
   * Whether a finding already exists for this `(bookingId, kind)`. The reconciler
   * guards {@link save} with this so a recurring divergence is recorded once.
   */
  has(key: FindingKey): Promise<boolean>;

  /**
   * Persist a finding. Inserts on `(bookingId, kind)`; callers guard with
   * {@link has} first, so this is never asked to overwrite an existing record.
   */
  save(finding: DivergenceFinding): Promise<void>;
}

/** Compose the dedup map key for a `(bookingId, kind)` pair. */
function keyOf(bookingId: string, kind: DivergenceKind): string {
  return `${bookingId}::${kind}`;
}

/**
 * An in-memory {@link DivergenceFindingRepository}, the reference implementation
 * used as a fake in tests until the Postgres-backed store lands. Reads hand back
 * copies and writes store copies, so callers cannot observe or corrupt internal
 * state — the isolation a transactional row insert would give.
 */
export class InMemoryDivergenceFindingRepository implements DivergenceFindingRepository {
  /** Keyed by `(bookingId, kind)` for O(1) dedup. */
  private readonly byKey = new Map<string, DivergenceFinding>();
  /** Per-booking insertion order, so reads return findings as they were recorded. */
  private readonly byBooking = new Map<string, DivergenceFinding[]>();

  async findByBooking(bookingId: string): Promise<DivergenceFinding[]> {
    const findings = this.byBooking.get(bookingId) ?? [];
    return findings.map((finding) => ({ ...finding }));
  }

  async has(key: FindingKey): Promise<boolean> {
    return this.byKey.has(keyOf(key.bookingId, key.kind));
  }

  async save(finding: DivergenceFinding): Promise<void> {
    const key = keyOf(finding.bookingId, finding.kind);
    if (this.byKey.has(key)) {
      return;
    }
    const stored = { ...finding };
    this.byKey.set(key, stored);
    const forBooking = this.byBooking.get(finding.bookingId) ?? [];
    forBooking.push(stored);
    this.byBooking.set(finding.bookingId, forBooking);
  }
}
