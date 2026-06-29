/**
 * The notifier's broker subscription: the subject it consumes and the handler that
 * routes each delivery through the idempotent {@link BookingNotificationConsumer}.
 *
 * This is the seam a {@link BrokerSubscriptionHost} drives — kept apart from the
 * module so the bridge (a delivered {@link BrokerMessage} → the consumer's
 * {@link DeliveredEvent}) and the NACK-on-outage contract are unit-testable on
 * their own, and so the module reads as wiring rather than logic.
 */
import { type BrokerHandler, type BrokerMessage } from '@signalman/broker';
import {
  type BookingNotificationConsumer,
  type DeliveredEvent,
  type LedgerCommittedPayload,
} from './booking-event-consumer';

/**
 * The booking's terminal success event the notifier reacts to — the moment the
 * financial record says the booking is real.
 */
export const LEDGER_COMMITTED_SUBJECT = 'ledger.committed';

/**
 * Map a delivered {@link BrokerMessage} onto the {@link DeliveredEvent} the
 * {@link BookingNotificationConsumer} consumes: the message id is the dedup key,
 * the subject is the event type, the trace-carrying headers pass through to
 * continue the booking trace, and the body is the `ledger.committed` payload.
 */
export function toDeliveredLedgerCommitted(
  message: BrokerMessage,
): DeliveredEvent<LedgerCommittedPayload> {
  return {
    messageId: message.id,
    eventType: message.subject,
    headers: message.headers,
    payload: message.payload as LedgerCommittedPayload,
  };
}

/**
 * The broker handler for `ledger.committed`: hand each delivery to the consumer,
 * which continues the booking trace and dedups by message id. A provider outage
 * rejects the consume; this lets the rejection propagate so the broker NACKs and
 * redelivers — nothing is recorded, so the redelivery genuinely retries.
 */
export function ledgerCommittedHandler(consumer: BookingNotificationConsumer): BrokerHandler {
  return async (message) => {
    await consumer.consume(toDeliveredLedgerCommitted(message));
  };
}
