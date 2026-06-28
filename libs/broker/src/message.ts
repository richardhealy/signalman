/**
 * The broker wire message and subject matching — the shapes and rules shared by
 * every {@link MessageBroker} implementation.
 *
 * A {@link BrokerMessage} is the minimal envelope that crosses the broker: the
 * dedup id, the subject it was published on, the event body, and the headers
 * carrying the publish span's trace context (so a consumer joins the same
 * booking trace). Subjects follow NATS naming — dot-delimited tokens — and
 * subscribers match them with {@link subjectMatches}.
 */
import { type BrokerHeaders } from '@signalman/propagation';

/**
 * A message as it crosses the broker, from publisher to subscriber. The outbox
 * relay produces one of these per row; the inbox consumer is handed one per
 * delivery.
 */
export interface BrokerMessage {
  /**
   * Stable unique id, mirrored from the outbox record id and surfaced to the
   * consumer as the inbox dedup key (`messaging.message.id`).
   */
  id: string;
  /**
   * The subject the message is published on — the domain event name, e.g.
   * `'ledger.committed'`. Subscribers match it with {@link subjectMatches}.
   */
  subject: string;
  /** JSON-serialisable event body. */
  payload: unknown;
  /**
   * Broker headers carrying the publish span's trace context (and any caller
   * headers), so the consume span continues the booking trace.
   */
  headers: BrokerHeaders;
}

/**
 * Whether a NATS-style subscription `pattern` matches a concrete `subject`.
 *
 * Both are dot-delimited token lists. In a pattern, `*` matches exactly one
 * token and `>` (only meaningful as the final token) matches one or more
 * trailing tokens; every other token must match literally. So `inventory.*`
 * matches `inventory.held` but not `inventory.held.eu`, while `inventory.>`
 * matches both — and neither matches the bare `inventory`.
 *
 * @param pattern - the subscription pattern, e.g. `'ledger.committed'` or `'inventory.>'`.
 * @param subject - the concrete subject a message was published on.
 * @returns `true` when the pattern matches the subject.
 */
export function subjectMatches(pattern: string, subject: string): boolean {
  const patternTokens = pattern.split('.');
  const subjectTokens = subject.split('.');

  for (let i = 0; i < patternTokens.length; i++) {
    const token = patternTokens[i];
    if (token === '>') {
      // The tail wildcard, valid only as the final token, matches one or more
      // remaining subject tokens — so it needs at least one token here.
      return i === patternTokens.length - 1 && i < subjectTokens.length;
    }
    if (i >= subjectTokens.length) {
      return false;
    }
    if (token === '*') {
      continue; // matches exactly this one token
    }
    if (token !== subjectTokens[i]) {
      return false;
    }
  }

  // Without a tail wildcard, the token counts must match exactly.
  return patternTokens.length === subjectTokens.length;
}
