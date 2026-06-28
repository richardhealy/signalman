/**
 * The notifier application service — the async tail of the booking saga.
 *
 * When a booking reaches its financial terminal state (the ledger commits), the
 * customer is told. This service owns that step: it sends the notification through
 * the external {@link NotificationChannel} and records what it sent. The property
 * that makes it redelivery-safe mirrors the saga legs:
 *
 * - **Idempotent per booking.** A booking is notified at most once; a second
 *   delivery of the booking's terminal event (whatever its message id) finds the
 *   standing record and returns it without sending the customer a duplicate. This
 *   sits *underneath* the inbox's message-id dedup: the inbox stops the exact same
 *   message twice, while this stops two distinct messages about the same booking.
 *
 * Unlike the saga legs, the notifier is a **terminal** consumer — nothing
 * downstream reacts to a notification — so it keeps a source-of-truth record but
 * stages **no** outbox event. A provider **outage** (a thrown
 * {@link NotificationChannelUnavailableError}) propagates so the consumer NACKs and
 * the broker redelivers; nothing is recorded, so the redelivery genuinely retries.
 *
 * The notification write and the inbox dedup marker belong in **one** transaction
 * in the Postgres-backed implementation; the in-memory collaborators used in tests
 * stand in until that lands, exactly as the other `@signalman/*` reference stores
 * do.
 */
import { randomUUID } from 'node:crypto';
import { type NotificationChannel } from './channel';
import { type Notification, type NotificationChannelKind } from './notification';
import { type NotificationRepository } from './notification-repository';

/** The booking-confirmed event the notifier reacts to, as the service sees it. */
export interface NotifyBookingConfirmedCommand {
  bookingId: string;
  /** Amount committed, in the currency's minor units (carried for the message body / audit). */
  amount: number;
  currency: string;
  /** The ledger entry that confirmed the booking. */
  entryId: string;
}

/** The outcome of {@link NotifierService.notifyBookingConfirmed}. */
export interface NotifyResult {
  /** The notification record's id. */
  notificationId: string;
  /** The provider's message reference. */
  reference: string;
  /** The customer contact the message was sent to. */
  recipient: string;
}

/** Injectable collaborators and seams for {@link NotifierService}. */
export interface NotifierServiceOptions {
  notifications: NotificationRepository;
  channel: NotificationChannel;
  /** Which transport to reach the customer on. Defaults to `'email'`. */
  channelKind?: NotificationChannelKind;
  /**
   * Resolve a booking's customer contact. The booking's terminal event carries no
   * contact (the saga keys everything by `bookingId`), so v1 derives a synthetic
   * address; a real implementation injects a customer-directory lookup here.
   */
  recipientFor?: (bookingId: string) => string;
  /** Notification-record-id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for the notification timestamp; defaults to `() => new Date()`. */
  clock?: () => Date;
}

/** Default contact derivation: a synthetic address keyed by the booking. */
const defaultRecipientFor = (bookingId: string): string => `booking-${bookingId}@example.com`;

export class NotifierService {
  private readonly notifications: NotificationRepository;
  private readonly channel: NotificationChannel;
  private readonly channelKind: NotificationChannelKind;
  private readonly recipientFor: (bookingId: string) => string;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(options: NotifierServiceOptions) {
    this.notifications = options.notifications;
    this.channel = options.channel;
    this.channelKind = options.channelKind ?? 'email';
    this.recipientFor = options.recipientFor ?? defaultRecipientFor;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Tell the customer their booking is confirmed.
   *
   * Idempotent per booking: a booking that has already been notified returns its
   * standing record without sending again. Otherwise the customer's contact is
   * resolved, the provider is asked to send — an outage propagates, touching no
   * state — and on acceptance the notification is recorded with the provider's
   * reference.
   */
  async notifyBookingConfirmed(command: NotifyBookingConfirmedCommand): Promise<NotifyResult> {
    const existing = await this.notifications.findByBooking(command.bookingId);
    if (existing) {
      return {
        notificationId: existing.id,
        reference: existing.reference,
        recipient: existing.recipient,
      };
    }

    const recipient = this.recipientFor(command.bookingId);
    const receipt = await this.channel.send({
      bookingId: command.bookingId,
      recipient,
      channel: this.channelKind,
      kind: 'booking_confirmed',
    });

    const notification: Notification = {
      id: this.idFactory(),
      bookingId: command.bookingId,
      kind: 'booking_confirmed',
      channel: this.channelKind,
      recipient,
      reference: receipt.providerMessageId,
      sentAt: this.clock(),
    };
    await this.notifications.save(notification);

    return {
      notificationId: notification.id,
      reference: notification.reference,
      recipient,
    };
  }
}
