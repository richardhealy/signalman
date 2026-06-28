/**
 * The notifier service's source of truth: a **notification** sent to the customer
 * about a booking.
 *
 * The notifier is the async tail of the saga (`… -> capture + commit to ledger ->
 * notify`). It does not participate in the synchronous booking call; instead it
 * reacts to a booking's terminal event off the broker and tells the customer.
 * Recording what it sent — and keeping that record idempotent per booking — is
 * what makes a redelivered event a no-op rather than a second email, and gives the
 * reconciler a fourth source of truth to compare a booking against (was the
 * customer actually told?).
 */

/** Which transport the customer is reached on. */
export type NotificationChannelKind = 'email' | 'sms';

/**
 * What happened to the booking that the customer is being told about. Only
 * `booking_confirmed` exists in v1 (the saga's success tail); failure
 * notifications — telling the customer a booking could not be completed — are a
 * later increment, which is why this is a union rather than a bare literal.
 */
export type NotificationKind = 'booking_confirmed';

/**
 * A notification sent to the customer for a booking.
 *
 * One booking is notified at most once (per {@link NotificationKind}); the record
 * is the idempotency key the service dedups on, and `reference` carries the
 * provider's message id — the external handle proving the message actually left
 * our boundary. Immutable in shape, mirroring how a transactional row insert
 * behaves and keeping the in-memory repository honest about what Postgres would do.
 */
export interface Notification {
  /** Stable unique id for the notification record. */
  readonly id: string;
  /** The booking this notification is about. One booking is notified at most once. */
  readonly bookingId: string;
  /** What the customer was told. */
  readonly kind: NotificationKind;
  /** The transport the message was sent over. */
  readonly channel: NotificationChannelKind;
  /** The customer contact the message was sent to. */
  readonly recipient: string;
  /** The provider's message reference — the external truth handle for the send. */
  readonly reference: string;
  /** When the notification was sent. */
  readonly sentAt: Date;
}
