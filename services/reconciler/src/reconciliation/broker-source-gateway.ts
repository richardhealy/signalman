/**
 * The broker-backed {@link SourceOfTruthGateway} — the reconciler's live read
 * side, built by projecting the source-of-truth events as they flow through the
 * broker.
 *
 * Subscribes to `inventory.*`, `supplier.*`, and `ledger.*`, and for each
 * delivered event updates the per-booking cross-source projection. Once a
 * booking's last event is older than the settle-grace window,
 * {@link collectSettled} includes it — preventing in-flight bookings from being
 * flagged as divergent while their saga is still running.
 *
 * This is a **fan-out** subscriber: `ledger.*` events also go to the notifier,
 * and `inventory.*`/`supplier.*` events may reach other consumers. Each consume
 * span therefore uses a **span link** to the producer's trace rather than
 * making the producer the parent — the OTel messaging semconv recommendation for
 * fan-out, where one producer span has multiple child consumers and a strict
 * parent-child tree would misrepresent the lineage.
 */
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Link,
  type Tracer,
} from '@opentelemetry/api';
import { type BrokerMessage, type BrokerSubscription } from '@signalman/broker';
import { getTracer } from '@signalman/otel';
import { extractContext } from '@signalman/propagation';
import { type BrokerHeaders } from '@signalman/propagation';
import {
  type BookingSnapshot,
  type InventoryState,
  type LedgerState,
  type SupplierState,
} from './booking-snapshot';
import { type SourceOfTruthGateway } from './source-gateway';

/** A booking's projection as it is assembled from source events. */
interface Projection {
  inventory: InventoryState;
  supplier: SupplierState;
  ledger: LedgerState;
  /** Trace headers from the first event seen for this booking (stable across events). */
  trace?: BrokerHeaders;
  /** When the most recent source event for this booking was received. */
  observedAt?: Date;
}

function emptyProjection(): Projection {
  return { inventory: 'absent', supplier: 'absent', ledger: 'absent' };
}

/** Pull a `bookingId` string from a message payload, returning undefined if absent. */
function extractBookingId(message: BrokerMessage): string | undefined {
  const payload = message.payload as Record<string, unknown> | null | undefined;
  const id = payload?.bookingId;
  return typeof id === 'string' ? id : undefined;
}

/** Construction inputs for {@link BrokerSourceOfTruthGateway}. */
export interface BrokerSourceOfTruthGatewayOptions {
  /**
   * How long (ms) the gateway waits after the last event for a booking before
   * treating it as settled and returning it from {@link collectSettled}.
   * Defaults to 5 000 ms.
   */
  settleGraceMs?: number;
  /** Tracer for consume spans; defaults to the `@signalman/reconciler` tracer. */
  tracer?: Tracer;
  /** Clock for `observedAt` and the settle-grace comparison. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

export class BrokerSourceOfTruthGateway implements SourceOfTruthGateway {
  private readonly byBooking = new Map<string, Projection>();
  private readonly settleGraceMs: number;
  private readonly tracer: Tracer;
  private readonly clock: () => Date;

  constructor(options: BrokerSourceOfTruthGatewayOptions = {}) {
    this.settleGraceMs = options.settleGraceMs ?? 5_000;
    this.tracer = options.tracer ?? getTracer('@signalman/reconciler');
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * The subscriptions this gateway needs to build its projection.
   *
   * Pass the returned list to a {@link BrokerSubscriptionHost} (or register them
   * directly on a broker) to begin consuming source events.
   */
  subscriptions(): BrokerSubscription[] {
    return [
      { subjects: 'inventory.*', handler: async (m) => this.handleInventory(m) },
      { subjects: 'supplier.*', handler: async (m) => this.handleSupplier(m) },
      { subjects: 'ledger.*', handler: async (m) => this.handleLedger(m) },
    ];
  }

  /**
   * Settled bookings — those whose last source event is older than
   * `settleGraceMs` — returned as cross-source snapshots ready for the
   * comparison engine.
   */
  async collectSettled(): Promise<BookingSnapshot[]> {
    const cutoff = new Date(this.clock().getTime() - this.settleGraceMs);
    const result: BookingSnapshot[] = [];
    for (const [bookingId, p] of this.byBooking) {
      if (p.observedAt === undefined || p.observedAt <= cutoff) {
        result.push({
          bookingId,
          inventory: p.inventory,
          supplier: p.supplier,
          ledger: p.ledger,
          ...(p.trace !== undefined ? { trace: p.trace } : {}),
          ...(p.observedAt !== undefined ? { observedAt: p.observedAt } : {}),
        });
      }
    }
    return result;
  }

  private handleInventory(message: BrokerMessage): void {
    const bookingId = extractBookingId(message);
    if (!bookingId) return;

    const state: InventoryState = message.subject === 'inventory.held' ? 'held' : 'released';
    this.inSpan(message, `project ${message.subject}`, () => {
      this.update(bookingId, (p) => {
        p.inventory = state;
      }, message.headers);
    });
  }

  private handleSupplier(message: BrokerMessage): void {
    const bookingId = extractBookingId(message);
    if (!bookingId) return;

    const state: SupplierState = message.subject === 'supplier.confirmed' ? 'confirmed' : 'cancelled';
    this.inSpan(message, `project ${message.subject}`, () => {
      this.update(bookingId, (p) => {
        p.supplier = state;
      }, message.headers);
    });
  }

  private handleLedger(message: BrokerMessage): void {
    const bookingId = extractBookingId(message);
    if (!bookingId) return;

    const state: LedgerState = message.subject === 'ledger.committed' ? 'committed' : 'reversed';
    this.inSpan(message, `project ${message.subject}`, () => {
      this.update(bookingId, (p) => {
        p.ledger = state;
      }, message.headers);
    });
  }

  /**
   * Run `fn` under a CONSUMER span with a **span link** to the producer's trace
   * context — the fan-out pattern. The link carries the booking's lineage without
   * falsely making this consumer a child of the producer; each consumer in a
   * fan-out has its own trace that links back to the common producer.
   */
  private inSpan(message: BrokerMessage, name: string, fn: () => void): void {
    const producerCtx = extractContext(message.headers, otelContext.active());
    const producerSpanCtx = trace.getSpanContext(producerCtx);
    const links: Link[] = producerSpanCtx ? [{ context: producerSpanCtx }] : [];

    const span = this.tracer.startSpan(name, {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.operation.name': 'process',
        'messaging.destination.name': message.subject,
        'messaging.message.id': message.id,
        'signalman.reconciler.projection': 'source_of_truth',
      },
      links,
    });

    try {
      otelContext.with(trace.setSpan(otelContext.active(), span), fn);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      span.recordException(error instanceof Error ? error : { message: msg });
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
      throw error;
    } finally {
      span.end();
    }
  }

  private update(
    bookingId: string,
    mutate: (p: Projection) => void,
    headers: BrokerHeaders,
  ): void {
    const projection = this.byBooking.get(bookingId) ?? emptyProjection();
    mutate(projection);
    if (projection.trace === undefined && Object.keys(headers).length > 0) {
      projection.trace = headers;
    }
    projection.observedAt = this.clock();
    this.byBooking.set(bookingId, projection);
  }
}
