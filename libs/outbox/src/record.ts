/**
 * The durable outbox record — the row a service writes *in the same local
 * transaction* as its business state, so an event publishes if and only if the
 * state change committed.
 *
 * This is the heart of the transactional-outbox pattern from the spec: it
 * defeats the dual-write problem (no lost events when a service crashes after
 * committing but before publishing, and no phantom events from a publish whose
 * transaction later rolled back). The record also carries the trace context
 * captured at stage time, so the {@link OutboxRelay} can publish the event on
 * the same booking trace it was born under.
 */
import { context as otelContext, type Context } from '@opentelemetry/api';
import { injectContext, type BrokerHeaders } from '@signalman/propagation';
import { randomUUID } from 'node:crypto';

/**
 * Lifecycle state of an outbox record.
 *
 * - `pending`   — staged and awaiting (or being retried for) publication.
 * - `published` — handed to the broker successfully; terminal.
 * - `failed`    — exhausted its retries and dead-lettered; terminal, needs
 *                 operator attention.
 */
export type OutboxStatus = 'pending' | 'published' | 'failed';

/**
 * What a service stages within its local transaction. The library turns this
 * into a durable {@link OutboxRecord} via {@link createOutboxRecord}, stamping
 * an id, the initial lifecycle state, and the active trace context.
 */
export interface OutboxMessage {
  /** The aggregate that produced the event, e.g. `'booking'` or `'hold'`. */
  aggregateType: string;
  /** Identifier of that aggregate, e.g. the booking id. Used for partitioning and lineage. */
  aggregateId: string;
  /** Domain event name, e.g. `'inventory.held'`. Becomes the broker destination/topic. */
  eventType: string;
  /** JSON-serialisable event body. */
  payload: unknown;
  /**
   * Pre-set broker headers to carry alongside the event. The active trace
   * context (`traceparent`/`tracestate`) is merged in on top of these, so a
   * caller can add their own headers without clobbering propagation.
   */
  headers?: BrokerHeaders;
}

/**
 * A persisted outbox record. Immutable in shape — the store produces a new
 * value on every transition rather than mutating in place, which keeps the
 * in-memory store honest about what a transactional update would do.
 */
export interface OutboxRecord {
  /** Stable unique id; also published as the broker `messaging.message.id`. */
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  /** Broker headers carrying the captured trace context, plus any caller headers. */
  readonly headers: BrokerHeaders;
  readonly status: OutboxStatus;
  /** Number of publish attempts that have failed so far. */
  readonly attempts: number;
  /** When the record was staged. */
  readonly createdAt: Date;
  /**
   * Earliest time the relay may claim this record. Set to `createdAt` on
   * staging, pushed forward by the lease while a relay holds it, and pushed
   * forward again by the retry back-off after a failed publish.
   */
  readonly availableAt: Date;
  /** When the event was handed to the broker; present only once `published`. */
  readonly publishedAt?: Date;
  /** Message from the most recent failed publish, retained for diagnostics. */
  readonly lastError?: string;
}

/** Injectable seams for {@link createOutboxRecord}, all defaulted for production use. */
export interface CreateOutboxRecordOptions {
  /** Id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for `createdAt`/`availableAt`; defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Trace context whose `traceparent` is captured into the record's headers.
   * Defaults to the active context, which is the saga step that produced the
   * event — exactly the lineage we want the published event to continue.
   */
  context?: Context;
}

/**
 * Build a durable {@link OutboxRecord} from a staged {@link OutboxMessage}.
 *
 * The record starts `pending` with zero attempts and is immediately available
 * to the relay (`availableAt === createdAt`). The active trace context is
 * injected into its headers so the publish hop later lands on the same trace.
 *
 * @param message - the event a service wants to publish.
 * @param options - injectable id/clock/context seams; all optional.
 * @returns a record ready to be handed to {@link OutboxStore.add} inside the
 *   caller's transaction.
 */
export function createOutboxRecord(
  message: OutboxMessage,
  options: CreateOutboxRecordOptions = {},
): OutboxRecord {
  const idFactory = options.idFactory ?? randomUUID;
  const clock = options.clock ?? (() => new Date());
  const ctx = options.context ?? otelContext.active();
  const now = clock();
  const headers = injectContext(ctx, { ...(message.headers ?? {}) });

  return {
    id: idFactory(),
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
    headers,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    availableAt: now,
  };
}
