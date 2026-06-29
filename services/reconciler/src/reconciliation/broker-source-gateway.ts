/**
 * A broker-backed {@link SourceOfTruthGateway} that projects real domain events
 * into the per-booking snapshots the reconciler compares.
 *
 * It subscribes to `inventory.*`, `supplier.*`, and `ledger.*` on the broker and
 * records each event into an {@link InMemorySourceOfTruthGateway}, turning the
 * event stream into the cross-source snapshot the reconciler needs. Only bookings
 * that have not seen a new event for at least {@link settleGraceMs} milliseconds
 * are returned from {@link collectSettled}, so the comparison never mistakes an
 * in-flight saga step for a divergence.
 *
 * Register the subscriptions from {@link BrokerSourceOfTruthGateway.subscriptions}
 * with a {@link BrokerSubscriptionHost} so they are established on bootstrap and
 * torn down on shutdown.
 */
import { type BrokerMessage, type BrokerSubscription } from '@signalman/broker';
import { type BookingSnapshot, type InventoryState, type LedgerState, type SupplierState } from './booking-snapshot';
import { InMemorySourceOfTruthGateway, type SourceOfTruthGateway } from './source-gateway';

/** Construction options for {@link BrokerSourceOfTruthGateway}. */
export interface BrokerSourceOfTruthGatewayOptions {
  /**
   * How long after the last observed event to wait before treating a booking as
   * settled and returning it from {@link BrokerSourceOfTruthGateway.collectSettled}.
   * Defaults to 30 000 ms.
   *
   * A booking still mid-saga shows partial state that is not yet a divergence;
   * the grace window lets the saga finish before the reconciler compares.
   */
  settleGraceMs?: number;
  /**
   * Clock for the current time; defaults to `() => new Date()`. Override for
   * deterministic tests.
   */
  clock?: () => Date;
}

export class BrokerSourceOfTruthGateway implements SourceOfTruthGateway {
  private readonly inner = new InMemorySourceOfTruthGateway();
  private readonly settleGraceMs: number;
  private readonly clock: () => Date;

  constructor(options: BrokerSourceOfTruthGatewayOptions = {}) {
    this.settleGraceMs = options.settleGraceMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * The broker subscriptions that feed this gateway's projection — one for each
   * source-of-truth domain (`inventory.*`, `supplier.*`, `ledger.*`). Register
   * them with a {@link BrokerSubscriptionHost}.
   */
  subscriptions(): BrokerSubscription[] {
    return [
      { subjects: 'inventory.*', handler: (m) => this.handleInventory(m) },
      { subjects: 'supplier.*', handler: (m) => this.handleSupplier(m) },
      { subjects: 'ledger.*', handler: (m) => this.handleLedger(m) },
    ];
  }

  /**
   * Settled bookings to reconcile — those whose last observed event is older than
   * the settle-grace window. A booking whose most recent event arrived within the
   * window is withheld so partial saga state is never mistaken for divergence.
   */
  async collectSettled(): Promise<BookingSnapshot[]> {
    const cutoff = new Date(this.clock().getTime() - this.settleGraceMs);
    const all = await this.inner.collectSettled();
    return all.filter((s) => s.observedAt === undefined || s.observedAt <= cutoff);
  }

  private async handleInventory(message: BrokerMessage): Promise<void> {
    const payload = message.payload as { bookingId: string };
    const state: InventoryState = message.subject === 'inventory.held' ? 'held' : 'released';
    this.inner.recordInventory(payload.bookingId, state, {
      trace: message.headers,
      observedAt: this.clock(),
    });
  }

  private async handleSupplier(message: BrokerMessage): Promise<void> {
    const payload = message.payload as { bookingId: string };
    const state: SupplierState = message.subject === 'supplier.confirmed' ? 'confirmed' : 'cancelled';
    this.inner.recordSupplier(payload.bookingId, state, {
      trace: message.headers,
      observedAt: this.clock(),
    });
  }

  private async handleLedger(message: BrokerMessage): Promise<void> {
    const payload = message.payload as { bookingId: string };
    const state: LedgerState = message.subject === 'ledger.committed' ? 'committed' : 'reversed';
    this.inner.recordLedger(payload.bookingId, state, {
      trace: message.headers,
      observedAt: this.clock(),
    });
  }
}
