/**
 * The outbox relay: the background worker that turns durable outbox rows into
 * published broker events, on the trace they were born under.
 *
 * For each claimed record the relay opens a PRODUCER span — parented to the
 * trace context captured at stage time — re-injects *that* span's context into
 * the outgoing headers, and hands the event to a {@link Publisher}. The result
 * is the messaging chain the spec calls for: the saga step that staged the
 * event, the relay's publish span, and (once the consumer extracts the headers)
 * the consume span all hang off one connected booking trace, with no orphans.
 *
 * Delivery is at-least-once: a record is marked `published` only after the
 * broker accepts it, and a crash mid-publish leaves it claimable again once its
 * lease expires. Pair the relay with idempotent consumers (the inbox) for
 * effectively-once processing. Failed publishes are retried with capped
 * exponential back-off and dead-lettered after `maxAttempts`.
 */
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { getTracer } from '@signalman/otel';
import { extractContext, injectContext } from '@signalman/propagation';
import { type OutboxRecord } from './record';
import { type OutboxStore } from './store';

// Messaging attribute keys from the OpenTelemetry semantic conventions. These
// live in `@opentelemetry/semantic-conventions/incubating`, whose subpath the
// package's `exports` map hides from TypeScript's `node` module resolution, so
// we pin the stable string keys here rather than depend on the incubating entry.
const ATTR_MESSAGING_OPERATION_NAME = 'messaging.operation.name';
const ATTR_MESSAGING_DESTINATION_NAME = 'messaging.destination.name';
const ATTR_MESSAGING_MESSAGE_ID = 'messaging.message.id';
const ATTR_MESSAGING_SYSTEM = 'messaging.system';

/**
 * The broker boundary. The relay calls {@link Publisher.publish} with a record
 * whose `headers` already carry the publish span's trace context; throwing
 * signals a failed publish, which the relay retries or dead-letters.
 */
export interface Publisher {
  publish(record: OutboxRecord): Promise<void>;
}

/** Per-record outcome of a relay pass. */
export type RelayOutcome = 'published' | 'retried' | 'deadLettered';

/** Aggregate result of one {@link OutboxRelay.relayOnce} pass. */
export interface RelayResult {
  /** Records claimed and attempted in this pass. */
  claimed: number;
  /** Records published successfully. */
  published: number;
  /** Records that failed and were rescheduled for a later retry. */
  retried: number;
  /** Records that failed for the final time and were dead-lettered. */
  deadLettered: number;
}

/** Construction inputs for an {@link OutboxRelay}. */
export interface OutboxRelayOptions {
  /** The store to drain. */
  store: OutboxStore;
  /** The broker boundary events are handed to. */
  publisher: Publisher;
  /** Tracer for publish spans; defaults to the `@signalman/outbox` tracer. */
  tracer?: Tracer;
  /** Value for the `messaging.system` span attribute (e.g. `'nats'`, `'kafka'`). */
  messagingSystem?: string;
  /** Maximum records claimed per pass. Defaults to {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number;
  /** Claim lease duration in ms. Defaults to {@link DEFAULT_LEASE_MS}. */
  leaseMs?: number;
  /** Attempt budget before a record is dead-lettered. Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /**
   * Back-off schedule mapping a (1-based) attempt number to a delay in ms before
   * the next retry. Defaults to capped exponential back-off, {@link defaultBackoff}.
   */
  backoff?: (attempt: number) => number;
  /** Clock, injectable for tests. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Invoked with any error thrown by a scheduled {@link OutboxRelay.start} pass
   * (e.g. the store being unreachable). Per-record publish failures do not flow
   * here — they are handled as retries. Defaults to a no-op.
   */
  onError?: (error: unknown) => void;
}

/** Default maximum records claimed per relay pass. */
export const DEFAULT_BATCH_SIZE = 100;
/** Default claim lease: long enough to publish a batch, short enough to recover from a crash. */
export const DEFAULT_LEASE_MS = 30_000;
/** Default attempt budget before dead-lettering. */
export const DEFAULT_MAX_ATTEMPTS = 8;
/** Ceiling for the default back-off, so a stuck record retries at least this often. */
export const DEFAULT_BACKOFF_CAP_MS = 60_000;

/**
 * Capped exponential back-off: attempt 1 waits ~1s, then doubling each attempt
 * up to {@link DEFAULT_BACKOFF_CAP_MS}.
 *
 * @param attempt - 1-based count of failed attempts so far.
 */
export function defaultBackoff(attempt: number): number {
  const exponential = 1_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, DEFAULT_BACKOFF_CAP_MS);
}

/** The OTel `error.type` for an error value, by its constructor name. */
function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || 'Error';
  }
  return 'Error';
}

export class OutboxRelay {
  private readonly store: OutboxStore;
  private readonly publisher: Publisher;
  private readonly tracer: Tracer;
  private readonly messagingSystem?: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoff: (attempt: number) => number;
  private readonly clock: () => Date;
  private readonly onError: (error: unknown) => void;

  /** Handle for the {@link start} scheduler, if running. */
  private timer?: ReturnType<typeof setInterval>;
  /** Guards against a slow pass overlapping the next scheduled tick. */
  private running = false;

  constructor(options: OutboxRelayOptions) {
    this.store = options.store;
    this.publisher = options.publisher;
    this.tracer = options.tracer ?? getTracer('@signalman/outbox');
    this.messagingSystem = options.messagingSystem;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoff = options.backoff ?? defaultBackoff;
    this.clock = options.clock ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Claim one batch of due records and attempt to publish each, marking it
   * `published`, rescheduled, or dead-lettered. Safe to call concurrently with
   * other relays against the same store — leasing prevents double publication.
   *
   * @returns a tally of what happened in this pass.
   */
  async relayOnce(): Promise<RelayResult> {
    const now = this.clock();
    const batch = await this.store.claimBatch({
      batchSize: this.batchSize,
      now,
      leaseMs: this.leaseMs,
    });

    const result: RelayResult = {
      claimed: batch.length,
      published: 0,
      retried: 0,
      deadLettered: 0,
    };

    for (const record of batch) {
      const outcome = await this.publishRecord(record, now);
      if (outcome === 'published') {
        result.published += 1;
      } else if (outcome === 'retried') {
        result.retried += 1;
      } else {
        result.deadLettered += 1;
      }
    }

    return result;
  }

  /**
   * Start polling the store on an interval. Passes never overlap — if one is
   * still running when the timer fires, that tick is skipped. Errors from a pass
   * are routed to the `onError` callback rather than thrown. Idempotent.
   *
   * @param intervalMs - delay between the end of one pass and the next tick.
   */
  start(intervalMs: number): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }
      this.running = true;
      void this.relayOnce()
        .catch((error) => this.onError(error))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    // Do not keep the event loop alive solely for the relay.
    this.timer.unref?.();
  }

  /** Stop the {@link start} scheduler. Idempotent; in-flight passes finish on their own. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Publish one record under a PRODUCER span continuing its staged trace, and
   * record the result in the store.
   */
  private async publishRecord(record: OutboxRecord, now: Date): Promise<RelayOutcome> {
    // Continue the trace the event was staged on: the captured `traceparent`
    // becomes the parent of the publish span (a no-op base context when absent).
    const parentContext = extractContext(record.headers, otelContext.active());
    const span = this.tracer.startSpan(
      `publish ${record.eventType}`,
      { kind: SpanKind.PRODUCER, attributes: this.spanAttributes(record) },
      parentContext,
    );
    const spanContext = trace.setSpan(parentContext, span);
    // The broker message carries the *publish* span's context, so a consumer
    // joins under this span rather than orphaning or skipping the hop.
    const headers = injectContext(spanContext, { ...record.headers });

    try {
      await this.publisher.publish({ ...record, headers });
      await this.store.markPublished(record.id, now);
      span.setStatus({ code: SpanStatusCode.OK });
      return 'published';
    } catch (error) {
      return this.handleFailure(record, now, span, error);
    } finally {
      span.end();
    }
  }

  /** Reschedule or dead-letter a failed publish, annotating the span. */
  private async handleFailure(
    record: OutboxRecord,
    now: Date,
    span: Span,
    error: unknown,
  ): Promise<RelayOutcome> {
    const attempts = record.attempts + 1;
    const dead = attempts >= this.maxAttempts;
    const message = error instanceof Error ? error.message : String(error);

    span.recordException(error instanceof Error ? error : { message });
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    span.setAttribute(ATTR_ERROR_TYPE, errorType(error));

    await this.store.markFailed(record.id, {
      attempts,
      error: message,
      availableAt: dead ? undefined : new Date(now.getTime() + this.backoff(attempts)),
      dead,
    });

    return dead ? 'deadLettered' : 'retried';
  }

  /** Messaging-semconv attributes for a publish span. */
  private spanAttributes(record: OutboxRecord): Record<string, string | number> {
    const attributes: Record<string, string | number> = {
      [ATTR_MESSAGING_OPERATION_NAME]: 'publish',
      [ATTR_MESSAGING_DESTINATION_NAME]: record.eventType,
      [ATTR_MESSAGING_MESSAGE_ID]: record.id,
      'signalman.outbox.aggregate_type': record.aggregateType,
      'signalman.outbox.aggregate_id': record.aggregateId,
      'signalman.outbox.attempt': record.attempts + 1,
    };
    if (this.messagingSystem) {
      attributes[ATTR_MESSAGING_SYSTEM] = this.messagingSystem;
    }
    return attributes;
  }
}
