/**
 * The reconciler's read-side seam over the sources of truth.
 *
 * To compare the services the reconciler needs a cross-source projection of each
 * booking — what inventory, the supplier, and the ledger each report — restricted
 * to bookings that have *settled* (an in-flight booking shows partial state that
 * is not yet a divergence). The {@link SourceOfTruthGateway} is that seam: how the
 * projection is gathered (consuming each service's events, querying read replicas,
 * or calling gRPC read endpoints) is an implementation detail behind it.
 *
 * {@link InMemorySourceOfTruthGateway} is the reference implementation used in
 * tests and until the broker/datastore-backed gateway lands. It models the
 * event-driven path: each service's state events are *recorded* into a per-booking
 * projection, and {@link InMemorySourceOfTruthGateway.collectSettled} hands back
 * the assembled snapshots. The broker-backed gateway swaps in behind the same
 * interface, subscribing to `inventory.*`, `supplier.*`, and `ledger.*` to build
 * the same projection and applying the real settle-grace window.
 */
import { type BrokerHeaders } from '@signalman/propagation';
import {
  type BookingSnapshot,
  type InventoryState,
  type LedgerState,
  type SupplierState,
} from './booking-snapshot';

/** The read side the reconciler pulls settled bookings from. */
export interface SourceOfTruthGateway {
  /**
   * The settled bookings to reconcile, each as a cross-source snapshot. Only
   * bookings past the settle-grace window are returned, so the comparison never
   * mistakes an in-flight booking for a divergence.
   */
  collectSettled(): Promise<BookingSnapshot[]>;
}

/** A booking's projection as it is built up from recorded source events. */
interface Projection {
  inventory: InventoryState;
  supplier: SupplierState;
  ledger: LedgerState;
  trace?: BrokerHeaders;
  observedAt?: Date;
}

/** Optional trace/observation metadata carried with a recorded source observation. */
export interface SourceObservation {
  /** The booking's trace context (`traceparent` headers), captured when the source event was published. */
  trace?: BrokerHeaders;
  /** When the observation was made. */
  observedAt?: Date;
}

function emptyProjection(): Projection {
  return { inventory: 'absent', supplier: 'absent', ledger: 'absent' };
}

/**
 * An in-memory {@link SourceOfTruthGateway} that builds per-booking projections
 * from recorded source observations — the shape the broker-backed gateway will
 * fill from real events.
 *
 * Each `record*` call updates one booking's projection with what a source now
 * reports; the first observation carrying a trace context wins (the booking's
 * lineage is stable across its events), so a finding links back to where the
 * booking began. {@link collectSettled} returns every recorded booking; the
 * reference gateway treats whatever has been recorded as settled, leaving the
 * real settle-grace filtering to the production implementation.
 */
export class InMemorySourceOfTruthGateway implements SourceOfTruthGateway {
  private readonly byBooking = new Map<string, Projection>();

  /** Record what inventory reports for a booking. */
  recordInventory(bookingId: string, state: InventoryState, meta: SourceObservation = {}): void {
    this.update(bookingId, (p) => (p.inventory = state), meta);
  }

  /** Record what the supplier reports for a booking. */
  recordSupplier(bookingId: string, state: SupplierState, meta: SourceObservation = {}): void {
    this.update(bookingId, (p) => (p.supplier = state), meta);
  }

  /** Record what the ledger reports for a booking. */
  recordLedger(bookingId: string, state: LedgerState, meta: SourceObservation = {}): void {
    this.update(bookingId, (p) => (p.ledger = state), meta);
  }

  async collectSettled(): Promise<BookingSnapshot[]> {
    return [...this.byBooking.entries()].map(([bookingId, projection]) => {
      const snapshot: BookingSnapshot = {
        bookingId,
        inventory: projection.inventory,
        supplier: projection.supplier,
        ledger: projection.ledger,
      };
      return {
        ...snapshot,
        ...(projection.trace !== undefined ? { trace: projection.trace } : {}),
        ...(projection.observedAt !== undefined ? { observedAt: projection.observedAt } : {}),
      };
    });
  }

  private update(bookingId: string, mutate: (p: Projection) => void, meta: SourceObservation): void {
    const projection = this.byBooking.get(bookingId) ?? emptyProjection();
    mutate(projection);
    // First trace context wins — the booking's lineage is stable across its events.
    if (projection.trace === undefined && meta.trace !== undefined) {
      projection.trace = meta.trace;
    }
    if (meta.observedAt !== undefined) {
      projection.observedAt = meta.observedAt;
    }
    this.byBooking.set(bookingId, projection);
  }
}
