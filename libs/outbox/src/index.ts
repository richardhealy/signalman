/**
 * @packageDocumentation
 * Transactional outbox for Signalman services.
 *
 * Services stage outbox events with {@link OutboxStore.add} in the **same
 * transaction** as their business writes, eliminating the dual-write problem.
 * The {@link OutboxRelay} then polls pending records and publishes them to the
 * broker with at-least-once delivery. The {@link InMemoryOutboxStore} is used
 * in tests; {@link PostgresOutboxStore} is used in production.
 */
export {
  createOutboxRecord,
  type CreateOutboxRecordOptions,
  type OutboxMessage,
  type OutboxRecord,
  type OutboxStatus,
} from './record';
export {
  type ClaimOptions,
  type MarkFailedOptions,
  type OutboxStore,
} from './store';
export { InMemoryOutboxStore } from './memory-store';
export { runInTransaction, type DeferredWrite, type UnitOfWork } from './transaction';
export {
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  OutboxRelay,
  defaultBackoff,
  type OutboxRelayOptions,
  type Publisher,
  type RelayOutcome,
  type RelayResult,
} from './relay';
export { type PgUnitOfWork, runInPgTransaction } from './pg-transaction';
export { PostgresOutboxStore } from './pg-store';
