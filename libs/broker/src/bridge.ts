/**
 * The consume-side bridge: turn a {@link BrokerMessage} delivered by the broker
 * into the {@link ConsumedMessage} the idempotent inbox consumes.
 *
 * A service wires the two together in its subscription —
 * `broker.subscribe(subject, (m) => consumer.consume(toConsumedMessage(m), handler))`
 * — so the broker's at-least-once delivery and the inbox's dedup compose into
 * effectively-once processing, on the booking trace the headers carry.
 */
import { type ConsumedMessage } from '@signalman/inbox';
import { type BrokerMessage } from './message';

/**
 * Map a delivered {@link BrokerMessage} onto the inbox's {@link ConsumedMessage}:
 * the message id is the dedup key, the subject is the event type, and the
 * trace-carrying headers pass through for the consume span to continue.
 */
export function toConsumedMessage(message: BrokerMessage): ConsumedMessage {
  return {
    messageId: message.id,
    eventType: message.subject,
    headers: message.headers,
  };
}
