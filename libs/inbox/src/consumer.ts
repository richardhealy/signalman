/**
 * The idempotent consumer: the wrapper a service puts around a broker handler so
 * each message is processed at most once, on the trace it was published under.
 *
 * For every delivered message it extracts the upstream trace context from the
 * broker headers and opens a CONSUMER span parented to it — so the consume span
 * joins the same booking trace as the producer's publish span instead of
 * orphaning — then dedups through an {@link InboxStore}. A first delivery runs
 * the handler under the active consume span (its own child spans and logs nest
 * in the trace) and records the marker atomically with the handler's side
 * effects; a redelivery is skipped and tagged on the span so the duplicate is
 * visible rather than silent.
 *
 * A handler failure is annotated on the span and rethrown, so the caller can
 * NACK and let the broker redeliver — at-least-once delivery plus this dedup is
 * the effectively-once processing the spec calls for.
 */
import {
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

  constructor(options: IdempotentConsumerOptions<Tx>) {
    this.store = options.store;
    this.consumer = options.consumer;
    this.tracer = options.tracer ?? getTracer('@signalman/inbox');
    this.messagingSystem = options.messagingSystem;
    this.clock = options.clock ?? (() => new Date());
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
    // Continue the publisher's trace: the captured `traceparent` becomes the
    // parent of the consume span (a no-op base context when absent).
    const parentContext = extractContext(message.headers, otelContext.active());
    const span = this.tracer.startSpan(
      `consume ${message.eventType}`,
      { kind: SpanKind.CONSUMER, attributes: this.spanAttributes(message) },
      parentContext,
    );
    const spanContext = trace.setSpan(parentContext, span);

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
