/**
 * The broker boundary: the transport-agnostic contract the outbox relay
 * publishes to and a service's consumers subscribe through.
 *
 * Keeping this an interface lets the rest of the system depend on "a broker"
 * rather than NATS or Kafka: the {@link InMemoryBroker} reference backs the
 * tests (and a single-process demo), and a JetStream/Kafka adapter implements
 * the same surface behind the same DI token.
 */
import { type BrokerMessage } from './message';

/**
 * A subscription handler. Resolving acknowledges the message; throwing NACKs it,
 * so the broker redelivers (at-least-once) — pair with the idempotent inbox for
 * effectively-once processing.
 */
export type BrokerHandler = (message: BrokerMessage) => Promise<void>;

/** Per-subscription options. */
export interface SubscribeOptions {
  /**
   * Queue group name. Subscriptions sharing a queue group **load-balance** a
   * subject's messages across their members (one member handles each message)
   * instead of each receiving every message. Omit for fan-out delivery, where
   * every matching subscription gets its own copy.
   */
  queue?: string;
}

/** A live subscription; {@link Subscription.unsubscribe} stops further delivery. */
export interface Subscription {
  unsubscribe(): void;
}

/** The transport-agnostic broker surface. */
export interface MessageBroker {
  /**
   * Publish a message on its `subject`. Resolves once the broker has accepted
   * the message for delivery (not once consumers have processed it); rejecting
   * signals the publish failed, which the outbox relay retries.
   */
  publish(message: BrokerMessage): Promise<void>;
  /**
   * Subscribe `handler` to one or more subject patterns (see
   * {@link subjectMatches}). Returns a {@link Subscription} to stop delivery.
   */
  subscribe(
    subjects: string | string[],
    handler: BrokerHandler,
    options?: SubscribeOptions,
  ): Subscription;
}
