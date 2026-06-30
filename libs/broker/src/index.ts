/**
 * @packageDocumentation
 * Message broker abstraction for Signalman services.
 *
 * Defines the {@link MessageBroker} interface (publish / subscribe) with an
 * in-memory implementation ({@link InMemoryBroker}) for unit tests and a NATS
 * JetStream implementation ({@link NatsBroker}) for production. Also exports
 * the {@link OutboxRelayHost} NestJS lifecycle wrapper that drives the outbox
 * relay loop, and {@link BrokerSubscriptionHost} that manages consumer
 * subscriptions and inbox dedup.
 */
export { subjectMatches, type BrokerMessage } from './message';
export {
  type BrokerHandler,
  type MessageBroker,
  type SubscribeOptions,
  type Subscription,
} from './broker';
export {
  DEFAULT_MAX_DELIVER,
  InMemoryBroker,
  type InMemoryBrokerOptions,
} from './memory-broker';
export { BrokerPublisher, toBrokerMessage } from './outbox-publisher';
export { toConsumedMessage } from './bridge';
export {
  decodeNatsHeaders,
  encodeNatsHeaders,
  MESSAGE_ID_HEADER,
} from './nats-headers';
export {
  DEFAULT_ACK_WAIT_MS,
  DEFAULT_STREAM_NAME,
  DEFAULT_STREAM_SUBJECTS,
  deliverSubject,
  durableName,
  NatsBroker,
  type NatsBrokerOptions,
} from './nats-broker';
export {
  createBrokerFromEnv,
  resolveBrokerKind,
  type BrokerFromEnvResult,
  type BrokerKind,
} from './broker-env';
export {
  DEFAULT_RELAY_POLL_MS,
  OutboxRelayHost,
  type OutboxRelayHostOptions,
} from './relay-host';
export {
  BrokerSubscriptionHost,
  type BrokerSubscription,
  type BrokerSubscriptionHostOptions,
} from './subscription-host';
