/**
 * The adapter that lets the transactional outbox publish through a
 * {@link MessageBroker}: a {@link Publisher} (the relay's broker boundary)
 * backed by the broker, plus the record→message mapping it uses.
 *
 * The outbox library stays transport-agnostic — it knows only the `Publisher`
 * contract — and this adapter is where "publish" becomes "publish on the broker
 * under the event's subject". The mapping preserves the record's headers, which
 * the relay has already stamped with the publish span's trace context, so the
 * eventual consume span continues the booking trace.
 */
import { type OutboxRecord, type Publisher } from '@signalman/outbox';
import { type BrokerMessage } from './message';
import { type MessageBroker } from './broker';

/**
 * Map a published outbox record onto a {@link BrokerMessage}: the record id
 * becomes the dedup id, its `eventType` becomes the broker subject, and the
 * payload and (trace-carrying) headers pass through unchanged.
 */
export function toBrokerMessage(record: OutboxRecord): BrokerMessage {
  return {
    id: record.id,
    subject: record.eventType,
    payload: record.payload,
    headers: record.headers,
  };
}

/** An outbox {@link Publisher} that publishes each record onto a {@link MessageBroker}. */
export class BrokerPublisher implements Publisher {
  constructor(private readonly broker: MessageBroker) {}

  async publish(record: OutboxRecord): Promise<void> {
    await this.broker.publish(toBrokerMessage(record));
  }
}
