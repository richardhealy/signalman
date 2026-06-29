/**
 * The broker-backed {@link SourceOfTruthGateway} — the production sibling of
 * {@link InMemorySourceOfTruthGateway}.
 *
 * Where the in-memory reference is seeded by test helpers, this gateway builds
 * its per-booking projections by consuming the service events published onto the
 * broker: `inventory.held`/`.released`, `supplier.confirmed`/`.cancelled`, and
 * `ledger.committed`/`.reversed`. Each delivery calls {@link handle}, which maps
 * the subject to the right projection slot and records the message's trace headers
 * so a finding can be linked back to the booking trace.
 *
 * {@link collectSettled} applies a **settle-grace window** — bookings whose last
 * observed event is fresher than `settleGraceMs` are omitted, because an in-flight
 * booking will show partial state (held but not yet committed) that is not a
 * divergence. Pass `settleGraceMs: 0` in tests to settle events immediately.
 *
 * A {@link BrokerSubscriptionHost} drives the subscription lifecycle: it calls
 * {@link sourceEventHandler} to get the handler and subscribes it to
 * `['inventory.*', 'supplier.*', 'ledger.*']` off the configured broker. The
 * module wires this, swapping the gateway in behind the `SOURCE_OF_TRUTH_GATEWAY`
 * token alongside the subscription host.
 */
import { type BrokerHandler, type BrokerMessage } from '@signalman/broker';
import {
  InMemorySourceOfTruthGateway,
  type SourceObservation,
  type SourceOfTruthGateway,
} from './source-gateway';
import { type BookingSnapshot } from './booking-snapshot';

/** Minimum payload shape for every source event the reconciler subscribes to. */
interface SourceEventPayload {
  bookingId: string;
}

/** Default settle-grace window: 10 seconds. */
export const DEFAULT_SETTLE_GRACE_MS = 10_000;

/** Subject patterns the reconciler subscribes to — the three sources of truth. */
export const SOURCE_EVENT_SUBJECTS = ['inventory.*', 'supplier.*', 'ledger.*'] as const;

export interface BrokerSourceOfTruthGatewayOptions {
  /** How many milliseconds after the last event before a booking is considered settled. */
  settleGraceMs?: number;
  /** Clock override for deterministic tests. */
  clock?: () => Date;
}

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
   * Route an incoming broker message into the per-booking projection.
   *
   * The message subject determines which source slot is updated; an unknown
   * subject is silently ignored so the subscription can use wildcards without
   * failing on unexpected events. The message headers carry the booking trace
   * context; the first trace context seen for a booking wins (lineage is stable).
   */
  handle(message: BrokerMessage): void {
    const payload = message.payload as SourceEventPayload;
    if (!payload || typeof payload.bookingId !== 'string') {
      return;
    }
    const { bookingId } = payload;
    const meta: SourceObservation = {
      trace: message.headers,
      observedAt: this.clock(),
    };

    switch (message.subject) {
      case 'inventory.held':
        this.inner.recordInventory(bookingId, 'held', meta);
        break;
      case 'inventory.released':
        this.inner.recordInventory(bookingId, 'released', meta);
        break;
      case 'supplier.confirmed':
        this.inner.recordSupplier(bookingId, 'confirmed', meta);
        break;
      case 'supplier.cancelled':
        this.inner.recordSupplier(bookingId, 'cancelled', meta);
        break;
      case 'ledger.committed':
        this.inner.recordLedger(bookingId, 'committed', meta);
        break;
      case 'ledger.reversed':
        this.inner.recordLedger(bookingId, 'reversed', meta);
        break;
      default:
        // Unknown subject — silently ignore.
        break;
    }
  }

  /**
   * The settled bookings to reconcile. Only bookings whose last observed event
   * is older than `settleGraceMs` are returned — in-flight bookings with
   * recent events are omitted until they stabilise.
   */
  async collectSettled(): Promise<BookingSnapshot[]> {
    const cutoff = new Date(this.clock().getTime() - this.settleGraceMs);
    const all = await this.inner.collectSettled();
    return all.filter(
      (snapshot) => snapshot.observedAt === undefined || snapshot.observedAt <= cutoff,
    );
  }
}

/**
 * Build the broker handler that routes each delivered message to
 * {@link BrokerSourceOfTruthGateway.handle}.
 *
 * The handler is synchronous in spirit (no I/O) but wraps the call in a
 * resolved Promise to satisfy the `BrokerHandler` signature.
 */
export function sourceEventHandler(gateway: BrokerSourceOfTruthGateway): BrokerHandler {
  return async (message) => {
    gateway.handle(message);
  };
}
