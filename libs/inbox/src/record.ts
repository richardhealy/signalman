/**
 * The idempotent inbox: the dedup record a consumer writes so a redelivered
 * message is processed at most once.
 *
 * The outbox publishes at-least-once — a relay crash between handing a message
 * to the broker and marking it published leaves the row claimable, so the broker
 * may deliver the same event twice. The inbox is the other half of
 * effectively-once: each consumer records the ids of the messages it has already
 * handled, and skips a message whose id it has seen before. Writing that marker
 * *in the same local transaction* as the handler's side effects is what makes
 * the guarantee real — the work and the "I did this" commit together, so a crash
 * before commit rolls back both and the redelivery reprocesses cleanly.
 */

/**
 * Identifies one message for one consumer — the unique key the inbox dedups on.
 *
 * `messageId` alone is not enough under fan-out: a single event may be consumed
 * independently by several services (e.g. both `ledger` and `notifier` react to
 * `supplier.confirmed`), and each must process it once. `consumer` is that dedup
 * namespace, so the same message id can be processed once per consumer without
 * one consumer's marker hiding the event from another.
 */
export interface InboxKey {
  /**
   * The dedup namespace — typically the consuming service or handler name, e.g.
   * `'ledger'`. Fan-out consumers each use their own so they don't shadow each
   * other.
   */
  consumer: string;
  /**
   * The unique message id. Matches the outbox record id published as the broker
   * `messaging.message.id`, so the consumer dedups on exactly the identity the
   * producer stamped.
   */
  messageId: string;
}

/**
 * A persisted dedup marker: proof that `consumer` has already processed
 * `messageId`. Its presence is the entire signal — a second delivery of the same
 * message finds the marker and is skipped.
 */
export interface InboxRecord extends InboxKey {
  /** When the message was processed (and this marker committed). */
  readonly processedAt: Date;
}
