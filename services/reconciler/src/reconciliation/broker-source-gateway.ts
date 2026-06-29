/**
 * A {@link SourceOfTruthGateway} that builds per-booking projections by consuming
 * source-of-truth events from the broker — the production sibling of
 * {@link InMemorySourceOfTruthGateway}.
 *
 * It subscribes to `inventory.*`, `supplier.*`, and `ledger.*` subjects, maps each
 * event onto one of the three source states, and records the update (with its trace
 * context) into an internal {@link InMemorySourceOfTruthGateway}. The settle-grace
 * window prevents the reconciler from comparing a booking that is still mid-saga:
 * {@link collectSettled} only returns bookings whose last event arrived more than
 * `settleGraceMs` milliseconds ago.
 *
 * Wiring: call {@link subscriptions} to get the {@link BrokerSubscription} entries,
 * then pass them to a {@link BrokerSubscriptionHost} so the host owns the
 * subscribe/unsubscribe lifecycle while this gateway owns the projection logic.
 */
import { type BrokerMessage, type BrokerSubscription } from '@signalman/broker';
import { type BookingSnapshot, type InventoryState, type LedgerState, type SupplierState } from './booking-snapshot';
import { InMemorySourceOfTruthGateway } from './source-gateway';
import { type SourceOfTruthGateway } from './source-gateway';

/**
 * How long (ms) after the last source event a booking must be idle before it is
 * considered settled and eligible for reconciliation.
 *
 * The default of 10 s covers the longest expected saga step (the deliberately slow
 * simulated supplier) with margin; override via `RECONCILER_SETTLE_GRACE_MS`.
 */
export const DEFAULT_SETTLE_GRACE_MS = 10_000;

/** Construction inputs for {@link BrokerSourceOfTruthGateway}. */
export interface BrokerSourceOfTruthGatewayOptions {
  /**
   * How long after the booking's last source event before it is considered
   * settled. Defaults to {@link DEFAULT_SETTLE_GRACE_MS}.
   */
  settleGraceMs?: number;
  /**
   * Wall-clock source (ms since epoch); defaults to `Date.now`. Override in
   * tests to control time without sleeping.
   */
  clock?: () => number;
}

/** Minimal payload shape carried by every source event. */
interface SourceEventPayload {
  bookingId: string;
}

/**
 * Broker-backed source-of-truth gateway that projects per-booking state from
 * `inventory.*`, `supplier.*`, and `ledger.*` events.
 *
 * The gateway is effectively an event-sourced read model: each consumed event is
 * the latest word from that source (e.g. `inventory.released` supersedes
 * `inventory.held`), and the internal in-memory store gives the cross-source
 * snapshot the reconciler needs.
 */
export class BrokerSourceOfTruthGateway implements SourceOfTruthGateway {
  private readonly inner: InMemorySourceOfTruthGateway;
  private readonly settleGraceMs: number;
  private readonly clock: () => number;
  /** Wall-clock timestamp (ms) of the most recent event recorded for each booking. */
  private readonly lastSeen = new Map<string, number>();

  constructor(options: BrokerSourceOfTruthGatewayOptions = {}) {
    this.inner = new InMemorySourceOfTruthGateway();
    this.settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Handle an `inventory.*` event and update the booking's inventory projection.
   *
   * Subject→state mapping:
   * - `inventory.held`     → `held`
   * - any other (`.released`) → `released`
   */
  onInventoryEvent(message: BrokerMessage): void {
    const payload = message.payload as SourceEventPayload;
    const state: InventoryState = message.subject === 'inventory.held' ? 'held' : 'released';
    this.inner.recordInventory(payload.bookingId, state, {
      trace: message.headers,
      observedAt: new Date(this.clock()),
    });
    this.touch(payload.bookingId);
  }

  /**
   * Handle a `supplier.*` event and update the booking's supplier projection.
   *
   * Subject→state mapping:
   * - `supplier.confirmed`  → `confirmed`
   * - any other (`.cancelled`) → `cancelled`
   */
  onSupplierEvent(message: BrokerMessage): void {
    const payload = message.payload as SourceEventPayload;
    const state: SupplierState = message.subject === 'supplier.confirmed' ? 'confirmed' : 'cancelled';
    this.inner.recordSupplier(payload.bookingId, state, {
      trace: message.headers,
      observedAt: new Date(this.clock()),
    });
    this.touch(payload.bookingId);
  }

  /**
   * Handle a `ledger.*` event and update the booking's ledger projection.
   *
   * Subject→state mapping:
   * - `ledger.committed`  → `committed`
   * - any other (`.reversed`) → `reversed`
   */
  onLedgerEvent(message: BrokerMessage): void {
    const payload = message.payload as SourceEventPayload;
    const state: LedgerState = message.subject === 'ledger.committed' ? 'committed' : 'reversed';
    this.inner.recordLedger(payload.bookingId, state, {
      trace: message.headers,
      observedAt: new Date(this.clock()),
    });
    this.touch(payload.bookingId);
  }

  /**
   * The three {@link BrokerSubscription} entries to register with a
   * {@link BrokerSubscriptionHost}: `inventory.*`, `supplier.*`, `ledger.*`.
   *
   * Passing these to the host keeps subscription lifecycle (subscribe/unsubscribe)
   * separate from projection logic (this class), so both are independently testable.
   */
  subscriptions(): BrokerSubscription[] {
    return [
      { subjects: 'inventory.*', handler: async (msg) => { this.onInventoryEvent(msg); } },
      { subjects: 'supplier.*', handler: async (msg) => { this.onSupplierEvent(msg); } },
      { subjects: 'ledger.*', handler: async (msg) => { this.onLedgerEvent(msg); } },
    ];
  }

  /**
   * Settled bookings: those for which the last source event arrived at least
   * `settleGraceMs` milliseconds ago.
   *
   * A booking still mid-saga will legitimately show partial state (held but not
   * yet confirmed) that is not a divergence — the grace window ensures the
   * reconciler never sees such bookings.
   */
  async collectSettled(): Promise<BookingSnapshot[]> {
    const now = this.clock();
    const all = await this.inner.collectSettled();
    return all.filter((s) => {
      const last = this.lastSeen.get(s.bookingId) ?? 0;
      return now - last >= this.settleGraceMs;
    });
  }

  private touch(bookingId: string): void {
    this.lastSeen.set(bookingId, this.clock());
  }
}
