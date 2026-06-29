/**
 * The broker-backed {@link SourceOfTruthGateway} for the reconciler.
 *
 * Where the {@link InMemorySourceOfTruthGateway} is pre-populated by test code,
 * this implementation learns the state of each booking by listening to the
 * domain events the producing services publish: `inventory.held`,
 * `inventory.released`, `supplier.confirmed`, `supplier.cancelled`,
 * `ledger.committed`, and `ledger.reversed`. Each delivery is projected into a
 * per-booking snapshot, keeping the reconciler's read model up to date without
 * polling the owning services.
 *
 * A **settle-grace window** keeps the comparison honest: a booking mid-saga will
 * legitimately show partial state (held but not yet confirmed), which is not a
 * divergence — it is in-flight. {@link collectSettled} therefore excludes any
 * booking whose most recent event arrived within the last {@link settleGraceMs}
 * milliseconds, so only bookings that have not changed recently are compared.
 *
 * The broker handler is {@link handleMessage}, which the reconciler module passes
 * to a {@link BrokerSubscriptionHost} so the gateway is driven by real broker
 * deliveries in a running service.
 */
import { type BrokerMessage } from '@signalman/broker';
import { type BookingSnapshot } from './booking-snapshot';
import { InMemorySourceOfTruthGateway, type SourceOfTruthGateway } from './source-gateway';

interface WithBookingId {
  bookingId: string;
}

/** Construction inputs for a {@link BrokerSourceOfTruthGateway}. */
export interface BrokerSourceGatewayOptions {
  /**
   * How long after the most recent event for a booking before it is considered
   * settled and eligible for reconciliation. Defaults to 5 000 ms.
   */
  settleGraceMs?: number;
  /** Clock; defaults to `() => new Date()`. */
  clock?: () => Date;
}

export class BrokerSourceOfTruthGateway implements SourceOfTruthGateway {
  private readonly inner = new InMemorySourceOfTruthGateway();
  private readonly settleGraceMs: number;
  private readonly clock: () => Date;

  constructor(options: BrokerSourceGatewayOptions = {}) {
    this.settleGraceMs = options.settleGraceMs ?? 5_000;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Project a delivered broker message into the per-booking snapshot.
   *
   * Recognises `inventory.*`, `supplier.*`, and `ledger.*` events and updates
   * the corresponding source state for the booking. The message's trace headers
   * are preserved (first-trace-wins, so the booking's lineage is stable across
   * its events), and `observedAt` is stamped with the current clock time so the
   * settle-grace window can filter in-flight bookings.
   *
   * Unknown subjects (e.g. `payment.authorized`) and messages without a
   * `bookingId` in their payload are silently ignored.
   */
  handleMessage(message: BrokerMessage): void {
    const payload = message.payload as WithBookingId;
    const bookingId = payload?.bookingId;
    if (!bookingId) return;

    const meta = { trace: message.headers, observedAt: this.clock() };
    const { subject } = message;

    if (subject === 'inventory.held') {
      this.inner.recordInventory(bookingId, 'held', meta);
    } else if (subject === 'inventory.released') {
      this.inner.recordInventory(bookingId, 'released', meta);
    } else if (subject === 'supplier.confirmed') {
      this.inner.recordSupplier(bookingId, 'confirmed', meta);
    } else if (subject === 'supplier.cancelled') {
      this.inner.recordSupplier(bookingId, 'cancelled', meta);
    } else if (subject === 'ledger.committed') {
      this.inner.recordLedger(bookingId, 'committed', meta);
    } else if (subject === 'ledger.reversed') {
      this.inner.recordLedger(bookingId, 'reversed', meta);
    }
  }

  /**
   * Return settled bookings — those whose most recent event arrived more than
   * {@link settleGraceMs} milliseconds ago. In-flight bookings (recently updated)
   * are excluded so the comparison engine never flags partial mid-saga state as a
   * divergence.
   *
   * Bookings with no recorded `observedAt` are excluded (they cannot be timed).
   */
  async collectSettled(): Promise<BookingSnapshot[]> {
    const all = await this.inner.collectSettled();
    const cutoffMs = this.clock().getTime() - this.settleGraceMs;
    return all.filter(
      (s) => s.observedAt !== undefined && s.observedAt.getTime() <= cutoffMs,
    );
  }
}
