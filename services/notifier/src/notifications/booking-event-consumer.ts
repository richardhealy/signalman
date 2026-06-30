/**
 * The broker-facing edge of the notifier: it turns a delivered booking event into
 * an at-most-once call to the {@link NotifierService}, on the trace the event was
 * published under.
 *
 * The notifier subscribes to a booking's terminal success event —
 * `ledger.committed`, the moment the financial record says the booking is real —
 * and tells the customer. This wrapper owns the two things every consumer needs
 * and the service should not: it continues the publisher's trace (via the
 * {@link IdempotentConsumer}'s CONSUMER span) and it dedups redeliveries through
 * the inbox, so the broker's at-least-once delivery becomes effectively-once
 * processing. The {@link NotifierService} stays a pure domain object that knows
 * nothing about brokers or trace headers.
 *
 * Its dedup namespace is `'notifier'` — distinct from any other consumer of the
 * same event, so fan-out (e.g. a future reconciler also reacting to
 * `ledger.committed`) does not let one consumer's marker hide the event from
 * another. The broker subscription that drives `consume` lands with the broker
 * milestone; until then this is exercised by handing it delivered events directly,
 * which is exactly the shape a real subscription will call it with.
 */
import { type Tracer } from '@opentelemetry/api';
import {
  IdempotentConsumer,
  type ConsumeResult,
  type InboxStore,
} from '@signalman/inbox';
import { type BrokerHeaders } from '@signalman/propagation';
import { type NotifierService, type NotifyResult } from './notifier.service';

/** This consumer's dedup namespace — keeps it independent of other consumers of the same event. */
export const NOTIFIER_CONSUMER = 'notifier';

/** The `ledger.committed` event payload the notifier reads. */
export interface LedgerCommittedPayload {
  bookingId: string;
  /** Amount committed, in the currency's minor units. */
  amount: number;
  currency: string;
  /** The committed ledger entry's id. */
  entryId: string;
  /** The payment capture reference recorded against the entry; optional. */
  captureId?: string;
}

/**
 * A message as the broker delivers it: the dedup identity and trace headers the
 * inbox needs, plus the decoded `payload` the handler acts on.
 */
export interface DeliveredEvent<P> {
  /** Unique message id (the producer's outbox record id) — the dedup key. */
  messageId: string;
  /** The event name / broker destination, e.g. `'ledger.committed'`. */
  eventType: string;
  /** Broker headers carrying the upstream trace context to continue. */
  headers: BrokerHeaders;
  /** The decoded message body. */
  payload: P;
}

/** Construction inputs for a {@link BookingNotificationConsumer}. */
export interface BookingNotificationConsumerOptions {
  notifier: NotifierService;
  /** The inbox store that records which messages this consumer has handled. */
  store: InboxStore;
  /** Tracer for consume spans; defaults to the `@signalman/inbox` tracer. */
  tracer?: Tracer;
  /** Value for the `messaging.system` span attribute (e.g. `'nats'`). */
  messagingSystem?: string;
  /** Clock for the recorded `processedAt`; defaults to `() => new Date()`. */
  clock?: () => Date;
}

export class BookingNotificationConsumer {
  private readonly notifier: NotifierService;
  private readonly consumer: IdempotentConsumer;

  constructor(options: BookingNotificationConsumerOptions) {
    this.notifier = options.notifier;
    this.consumer = new IdempotentConsumer({
      store: options.store,
      consumer: NOTIFIER_CONSUMER,
      tracer: options.tracer,
      messagingSystem: options.messagingSystem,
      clock: options.clock,
      // The reconciler also subscribes to ledger.* events, so this consumer
      // is one of several that receive each message (fan-out). Open a new root
      // trace and link back to the producer so the notifier's trace is
      // independent but still navigable to the originating booking trace.
      fanOut: true,
    });
  }

  /**
   * Handle a delivered `ledger.committed` event: notify the customer their booking
   * is confirmed, exactly once.
   *
   * The {@link IdempotentConsumer} continues the event's trace and dedups by
   * message id; a first delivery runs the notify under the CONSUMER span, a
   * redelivery is skipped. A provider outage rejects, so the marker rolls back and
   * the caller can NACK for redelivery.
   */
  async consume(event: DeliveredEvent<LedgerCommittedPayload>): Promise<ConsumeResult<NotifyResult>> {
    return this.consumer.consume(
      { messageId: event.messageId, eventType: event.eventType, headers: event.headers },
      () =>
        this.notifier.notifyBookingConfirmed({
          bookingId: event.payload.bookingId,
          amount: event.payload.amount,
          currency: event.payload.currency,
          entryId: event.payload.entryId,
        }),
    );
  }
}
