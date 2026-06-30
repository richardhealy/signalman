/**
 * @packageDocumentation
 * Idempotent inbox for Signalman consumers.
 *
 * {@link IdempotentConsumer} wraps a broker handler so each message is
 * processed at most once per consumer, even under broker redelivery. The dedup
 * marker is committed in the **same transaction** as the handler's own writes
 * via {@link InboxStore.processOnce}, making the dedup race-free. The
 * {@link InMemoryInboxStore} is used in tests; {@link PostgresInboxStore}
 * is used in production.
 */
export { type InboxKey, type InboxRecord } from './record';
export {
  type InboxOutcome,
  type InboxStore,
  type ProcessOnceOptions,
} from './store';
export { InMemoryInboxStore } from './memory-store';
export { PostgresInboxStore } from './pg-store';
export {
  IdempotentConsumer,
  type ConsumeResult,
  type ConsumeStatus,
  type ConsumedMessage,
  type IdempotentConsumerOptions,
} from './consumer';
