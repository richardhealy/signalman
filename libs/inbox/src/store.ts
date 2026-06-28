/**
 * The persistence contract for the idempotent inbox.
 *
 * A service implements this over its own Postgres, and the
 * {@link IdempotentConsumer} drives dedup through it. The interface is
 * deliberately broker- and database-agnostic so the consumer and its tests can
 * run against {@link InMemoryInboxStore} without a live datastore.
 *
 * The single primitive, {@link InboxStore.processOnce}, owns the transaction
 * because that is the only place the guarantee can be made: the dedup marker and
 * the handler's side effects must commit together. Splitting "have I seen this?"
 * from "do the work" into separate calls would reopen the very window the inbox
 * exists to close — a crash between them either drops the work (marker without
 * effects) or double-processes (effects without marker).
 */
import { type InboxKey } from './record';

/** Inputs for {@link InboxStore.processOnce}. */
export interface ProcessOnceOptions {
  /** The consumer's notion of "now"; recorded as the marker's `processedAt`. */
  now: Date;
}

/** Result of an {@link InboxStore.processOnce} call. */
export interface InboxOutcome<T> {
  /**
   * `true` when the key was already recorded — a duplicate redelivery whose
   * handler did **not** run this time. `false` when the message was processed
   * for the first time.
   */
  duplicate: boolean;
  /**
   * The handler's return value. Present only when `duplicate` is `false`; a
   * skipped duplicate never invokes the handler, so there is nothing to return.
   */
  result?: T;
}

/**
 * Storage operations the inbox needs.
 *
 * @typeParam Tx - the transaction/connection handle a store threads into the
 *   handler so the handler's writes share the marker's transaction. Defaults to
 *   `void` for stores (and tests) that don't need one.
 */
export interface InboxStore<Tx = void> {
  /**
   * Process `key` at most once. Implementations must, **atomically**:
   *
   * - if `key` is already recorded → resolve `{ duplicate: true }` *without*
   *   running `work`;
   * - otherwise run `work` (passing the transaction handle), record `key`, and
   *   commit both together → `{ duplicate: false, result }`.
   *
   * If `work` rejects, the marker must **not** persist (the transaction rolls
   * back), so a redelivery reprocesses the message. A production store expresses
   * this as `INSERT … ON CONFLICT DO NOTHING` plus the handler's writes inside
   * one transaction; the unique key on `(consumer, message_id)` makes the claim
   * race-free under concurrent redelivery.
   *
   * @param key - the (consumer, message) identity to dedup on.
   * @param work - the handler to run exactly once for `key`.
   * @param options - the clock for the recorded `processedAt`.
   */
  processOnce<T>(
    key: InboxKey,
    work: (tx: Tx) => Promise<T>,
    options: ProcessOnceOptions,
  ): Promise<InboxOutcome<T>>;

  /**
   * Whether `key` has already been recorded. For inspection and diagnostics —
   * dedup decisions go through {@link processOnce}, which keeps the check and the
   * claim atomic.
   */
  seen(key: InboxKey): Promise<boolean>;
}
