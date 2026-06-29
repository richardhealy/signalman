/**
 * The broker-backed {@link SourceOfTruthGateway} — the real implementation that
 * feeds the reconciler with events from the services that each own part of the
 * booking truth.
 *
 * While {@link InMemorySourceOfTruthGateway} is the reference used in unit tests
 * (pre-seeded with canned observations), the production reconciler needs to see
 * what the services *actually report*, which it learns by subscribing to their
 * domain events:
 *
 * - `inventory.*`  — what inventory reports about holds and releases.
 * - `supplier.*`   — what the supplier reports about confirmations and cancellations.
 * - `ledger.*`     — what the ledger reports about committed and reversed entries.
 *
 * Each event updates the per-booking projection held by an inner
 * {@link InMemorySourceOfTruthGateway}. {@link collectSettled} then applies a
 * settle-grace window — only returning bookings whose last source event was
 * observed at least {@link settleGraceMs} ago — so an in-flight booking whose
 * events are still arriving is never reconciled before the saga completes, which
 * would mistake legitimately in-progress partial state for a divergence.
 *
 * Wire the gateway into the module by:
 *  1. Registering `BrokerSourceOfTruthGateway` as a provider.
 *  2. Passing `gateway.handler()` as the `handler` in a {@link BrokerSubscription}
 *     on `['inventory.*', 'supplier.*', 'ledger.*']`.
 *  3. Binding `SOURCE_OF_TRUTH_GATEWAY` to the same instance (so the reconciler
 *     service gets the `SourceOfTruthGateway` interface without knowing the
 *     concrete type).
 */
import { type BrokerHandler, type BrokerMessage } from '@signalman/broker';
import { type BookingSnapshot } from './booking-snapshot';
import {
  InMemorySourceOfTruthGateway,
  type SourceObservation,
  type SourceOfTruthGateway,
} from './source-gateway';

/** Default settle-grace: wait 5 seconds after the last observed source event. */
export const DEFAULT_SETTLE_GRACE_MS = 5_000;

/** Options for {@link BrokerSourceOfTruthGateway}. */
export interface BrokerSourceOfTruthGatewayOptions {
  /**
   * How long (milliseconds) after the last source event a booking must be
   * silent before it is eligible for reconciliation. Defaults to
   * {@link DEFAULT_SETTLE_GRACE_MS}.
   */
  settleGraceMs?: number;
  /**
   * Clock returning the current time. Defaults to `() => new Date()`. Override
   * in tests to drive timing without real delays.
   */
  clock?: () => Date;
}

/**
 * The broker-backed {@link SourceOfTruthGateway}.
 *
 * Subscribes to `inventory.*`, `supplier.*`, and `ledger.*` events via a
 * {@link BrokerHandler} and projects each delivery into a per-booking snapshot.
 * Only settled bookings (last event > {@link settleGraceMs} ago) are returned by
 * {@link collectSettled}.
 */
export class BrokerSourceOfTruthGateway implements SourceOfTruthGateway {
  private readonly inner: InMemorySourceOfTruthGateway;
  private readonly settleGraceMs: number;
  private readonly clock: () => Date;

  constructor(options: BrokerSourceOfTruthGatewayOptions = {}) {
    this.inner = new InMemorySourceOfTruthGateway();
    this.settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * The broker handler that projects source-of-truth events into the internal
   * per-booking projection.
   *
   * Register this on a {@link BrokerSubscriptionHost} for subjects
   * `['inventory.*', 'supplier.*', 'ledger.*']`. Subjects not in the list above
   * (e.g. `payment.*`) are silently ignored — payment state is not part of the
   * reconciliation invariants.
   */
  handler(): BrokerHandler {
    return async (message: BrokerMessage): Promise<void> => {
      const payload = message.payload as { bookingId: string };
      const { bookingId } = payload;
      const observation: SourceObservation = {
        trace: message.headers,
        observedAt: this.clock(),
      };

      switch (message.subject) {
        case 'inventory.held':
          this.inner.recordInventory(bookingId, 'held', observation);
          break;
        case 'inventory.released':
          this.inner.recordInventory(bookingId, 'released', observation);
          break;
        case 'supplier.confirmed':
          this.inner.recordSupplier(bookingId, 'confirmed', observation);
          break;
        case 'supplier.cancelled':
          this.inner.recordSupplier(bookingId, 'cancelled', observation);
          break;
        case 'ledger.committed':
          this.inner.recordLedger(bookingId, 'committed', observation);
          break;
        case 'ledger.reversed':
          this.inner.recordLedger(bookingId, 'reversed', observation);
          break;
        // payment.* and any future subjects are intentionally ignored.
      }
    };
  }

  /**
   * Returns bookings that have settled — whose last source event was observed
   * at least {@link settleGraceMs} ago. In-flight bookings whose saga events
   * are still arriving are excluded to avoid false divergence findings.
   */
  async collectSettled(): Promise<BookingSnapshot[]> {
    const all = await this.inner.collectSettled();
    const cutoff = new Date(this.clock().getTime() - this.settleGraceMs);
    return all.filter((s) => s.observedAt !== undefined && s.observedAt <= cutoff);
  }
}
