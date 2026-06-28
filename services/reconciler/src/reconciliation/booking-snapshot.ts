/**
 * The reconciler's input: a **cross-source snapshot** of one booking, assembled
 * from what each source of truth independently says happened.
 *
 * Reconciliation is the spec's payoff — catching the moment the sources of truth
 * diverge. To do that the reconciler first projects, per booking, the state each
 * owning service reports (inventory's hold, the supplier's confirmation, the
 * ledger's posting), then compares them against the invariants that a consistent
 * booking must satisfy. This module is the shape of that projection; the
 * comparison itself lives in {@link ./reconciliation}.
 *
 * The snapshot also carries the **trace context** the booking's events were
 * published under, so a finding can be linked straight back to the originating
 * booking trace — the property that lets you jump from "this booking is
 * inconsistent" to "here is exactly how it got that way" in one hop.
 */
import { type BrokerHeaders } from '@signalman/propagation';

/**
 * What inventory reports for a booking.
 *
 * - `held`     — a live hold stands against the booking's stock.
 * - `released` — the hold was released (the compensation ran, or the booking was unwound).
 * - `absent`   — inventory has no record of the booking.
 */
export type InventoryState = 'held' | 'released' | 'absent';

/**
 * What the supplier reports for a booking.
 *
 * - `confirmed` — the external partner confirmed the booking.
 * - `cancelled` — the confirmation was cancelled (the compensation ran).
 * - `absent`    — the supplier has no record of the booking.
 */
export type SupplierState = 'confirmed' | 'cancelled' | 'absent';

/**
 * What the ledger reports for a booking.
 *
 * - `committed` — the booking's money is posted to the financial record.
 * - `reversed`  — the posting was backed out (the compensation ran).
 * - `absent`    — the ledger has no record of the booking.
 */
export type LedgerState = 'committed' | 'reversed' | 'absent';

/**
 * The three states the reconciler compares, captured together.
 *
 * Carried on a {@link DivergenceFinding} so a finding records the exact
 * cross-source state that made it fire — the evidence, not just the verdict.
 */
export interface ObservedStates {
  readonly inventory: InventoryState;
  readonly supplier: SupplierState;
  readonly ledger: LedgerState;
}

/**
 * A booking as the reconciler sees it across every source of truth, plus the
 * trace context to link any finding back to where the booking came from.
 *
 * Only **settled** bookings should be reconciled: a booking still mid-saga will
 * legitimately show partial state (held but not yet confirmed, say) that is not a
 * divergence, merely in-flight. Filtering those out is the gateway's job (it only
 * emits bookings past a settle-grace window), which keeps the comparison engine a
 * pure function of the snapshot — see {@link ./reconciliation}.
 */
export interface BookingSnapshot {
  /** The booking this snapshot describes. */
  readonly bookingId: string;
  /** What inventory reports. */
  readonly inventory: InventoryState;
  /** What the supplier reports. */
  readonly supplier: SupplierState;
  /** What the ledger reports. */
  readonly ledger: LedgerState;
  /**
   * Broker headers carrying the `traceparent` of the booking's events, used to
   * link a finding back to the originating booking trace. Absent when no source
   * recorded a trace context (e.g. a record predating propagation).
   */
  readonly trace?: BrokerHeaders;
  /** When this snapshot was assembled; carried through onto findings for audit. */
  readonly observedAt?: Date;
}
