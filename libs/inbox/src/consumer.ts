/**
 * The idempotent consumer: the wrapper a service puts around a broker handler so
 * each message is processed at most once, on the trace it was published under.
 *
 * For every delivered message it extracts the upstream trace context from the
 * broker headers and opens a CONSUMER span, then dedups through an
 * {@link InboxStore}. A first delivery runs the handler under the active consume
 * span (its own child spans and logs nest in the trace) and records the marker
 * atomically with the handler's side effects; a redelivery is skipped and tagged
 * on the span so the duplicate is visible rather than silent.
 *
 * **Trace mode** — controlled by {@link IdempotentConsumerOptions.fanOut}:
 * - `false` (default, pipeline): the CONSUMER span is a child of the PRODUCER
 *   span, so the consume hop joins the same booking trace end-to-end. Use when
 *   there is a single consumer for a message.
 * - `true` (fan-out): the CONSUMER span opens a new root trace and carries a
 *   {@link Link} back to the PRODUCER span. Use when multiple consumers each
 *   receive their own copy of the same message — this keeps each consumer's
 *   trace independent while still navigable to the source event.
 *
 * A handler failure is annotated on the span and rethrown, so the caller can
 * NACK and let the broker redeliver — at-least-once delivery plus this dedup is
 * the effectively-once processing the spec calls for.
 */
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { getTracer } from '@signalman/otel';
import { extractContext, type BrokerHeaders } from '@signalman/propagation';
import { type InboxStore } from './store';

// Messaging attribute keys from the OpenTelemetry semantic conventions, pinned
// as stable strings for the same reason the outbox relay pins them: the
// incubating subpath that exports them is hidden from `node` module resolution.
const ATTR_MESSAGING_OPERATION_NAME = 'messaging.operation.name';
const ATTR_MESSAGING_DESTINATION_NAME = 'messaging.destination.name';
const ATTR_MESSAGING_MESSAGE_ID = 'messaging.message.id';
const ATTR_MESSAGING_SYSTEM = 'messaging.system';
/** Marks a CONSUMER span that skipped a redelivered message. */
const ATTR_INBOX_DUPLICATE = 'signalman.inbox.duplicate';

/** A message as it arrives at a consumer, before the handler sees it. */
export interface ConsumedMessage {
  /**
   * Unique message id, matching the producer's `messaging.message.id` (the
   * outbox record id). The dedup key.
   */
  messageId: string;
  /** Domain event name / broker destination the message arrived on, e.g. `'inventory.held'`. */
  eventType: string;
  /** Broker headers carrying the upstream trace context to continue. */
  headers: BrokerHeaders;
}

/** Whether {@link IdempotentConsumer.consume} ran the handler or skipped a duplicate. */
export type ConsumeStatus = 'processed' | 'duplicate';

/** Outcome of an {@link IdempotentConsumer.consume} call. */
export interface ConsumeResult<T> {
  status: ConsumeStatus;
  /** The handler's return value; absent when the message was skipped as a duplicate. */
  result?: T;
}

/** Construction inputs for an {@link IdempotentConsumer}. */
export interface IdempotentConsumerOptions<Tx = void> {
  /** The inbox store that records which messages this consumer has handled. */
  store: InboxStore<Tx>;
  /**
   * This consumer's dedup namespace — the consuming service or handler name,
   * e.g. `'ledger'`. Fan-out consumers each construct their own so they don't
   * shadow each other's deliveries.
   */
  consumer: string;
  /** Tracer for consume spans; defaults to the `@signalman/inbox` tracer. */
  tracer?: Tracer;
  /** Value for the `messaging.system` span attribute (e.g. `'nats'`, `'kafka'`). */
  messagingSystem?: string;
  /** Clock for the recorded `processedAt`. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * When `true`, this consumer is one of several that each receive a copy of
   * the same message (fan-out). The CONSUMER span opens a new root trace and
   * carries a span {@link Link} back to the PRODUCER span, so each consumer's
   * trace is independent but still navigable to the source event.
   *
   * When `false` (default), the CONSUMER span is a direct child of the
   * PRODUCER span on the same trace — the right choice for a single-consumer
   * pipeline.
   */
  fanOut?: boolean;
}

/** The OTel `error.type` for an error value, by its constructor name. */
function errorType(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor?.name || 'Error';
  }
  return 'Error';
}

export class IdempotentConsumer<Tx = void> {
  private readonly store: InboxStore<Tx>;
  private readonly consumer: string;
  private readonly tracer: Tracer;
  private readonly messagingSystem?: string;
  private readonly clock: () => Date;
  private readonly fanOut: boolean;

  constructor(options: IdempotentConsumerOptions<Tx>) {
    this.store = options.store;
    this.consumer = options.consumer;
    this.tracer = options.tracer ?? getTracer('@signalman/inbox');
    this.messagingSystem = options.messagingSystem;
    this.clock = options.clock ?? (() => new Date());
    this.fanOut = options.fanOut ?? false;
  }

  /**
   * Process one delivered message exactly once, under a CONSUMER span that
   * continues the message's trace.
   *
   * On a first delivery the handler runs (with the span active and the store's
   * transaction handle) and its marker is committed atomically with its writes.
   * A redelivery is skipped — the handler is not called — and the span is tagged
   * `{@link ATTR_INBOX_DUPLICATE}`. A handler error is recorded on the span and
   * rethrown so the caller can NACK for redelivery.
   *
   * @param message - the delivered message (id, event type, trace headers).
   * @param handler - the work to run once for this message; receives the store's
   *   transaction handle so its writes share the dedup marker's transaction.
   * @returns whether the handler ran (`processed`, with its `result`) or the
   *   message was a `duplicate`.
   */
  async consume<T>(
    message: ConsumedMessage,
    handler: (tx: Tx) => Promise<T>,
  ): Promise<ConsumeResult<T>> {
    const extractedContext = extractContext(message.headers, otelContext.active());

    // Fan-out: each consumer opens a new root trace and links back to the
    // producer's publish span, so every consumer's trace is independent but
    // navigable to the source event via the span link.
    // Pipeline (default): the consume span is a child of the producer's span on
    // the same trace — the right shape for a single-consumer hop.
    const producerCtx = this.fanOut ? trace.getSpanContext(extractedContext) : undefined;
    const links = producerCtx ? [{ context: producerCtx }] : undefined;

    const span = this.tracer.startSpan(
      `consume ${message.eventType}`,
      { kind: SpanKind.CONSUMER, attributes: this.spanAttributes(message), links },
      this.fanOut ? ROOT_CONTEXT : extractedContext,
    );
    const spanContext = trace.setSpan(
      this.fanOut ? otelContext.active() : extractedContext,
      span,
    );

    try {
      // Keep the consume span active across dedup + handler, so any child span
      // or correlated log the handler emits joins this trace.
      const outcome = await otelContext.with(spanContext, () =>
        this.store.processOnce<T>(
          { consumer: this.consumer, messageId: message.messageId },
          handler,
          { now: this.clock() },
        ),
      );

      if (outcome.duplicate) {
        span.setAttribute(ATTR_INBOX_DUPLICATE, true);
        span.addEvent('messaging.duplicate.dropped');
        span.setStatus({ code: SpanStatusCode.OK });
        return { status: 'duplicate' };
      }

      span.setStatus({ code: SpanStatusCode.OK });
      return { status: 'processed', result: outcome.result };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      span.recordException(error instanceof Error ? error : { message: messageText });
      span.setStatus({ code: SpanStatusCode.ERROR, message: messageText });
      span.setAttribute(ATTR_ERROR_TYPE, errorType(error));
      throw error;
    } finally {
      span.end();
    }
  }

  /** Messaging-semconv attributes for a consume span. */
  private spanAttributes(message: ConsumedMessage): Record<string, string | number> {
    const attributes: Record<string, string | number> = {
      [ATTR_MESSAGING_OPERATION_NAME]: 'process',
      [ATTR_MESSAGING_DESTINATION_NAME]: message.eventType,
      [ATTR_MESSAGING_MESSAGE_ID]: message.messageId,
      'signalman.inbox.consumer': this.consumer,
    };
    if (this.messagingSystem) {
      attributes[ATTR_MESSAGING_SYSTEM] = this.messagingSystem;
    }
    return attributes;
  }
}
