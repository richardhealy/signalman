/**
 * Persistence for the notifier service's source of truth: the
 * {@link Notification} a booking has been sent.
 *
 * The contract is database-agnostic so the application service and its tests run
 * against {@link InMemoryNotificationRepository} without a live datastore. A
 * production implementation backs this with the notifier's own Postgres, and —
 * crucially — records the notification *in the same transaction* as the inbox
 * dedup marker, so "we told the customer" and "we have seen this message" commit
 * together. That is what closes the gap a crash between sending and recording
 * would otherwise open.
 */
import { type Notification } from './notification';

/** The persistence seam a notification write goes through. */
export interface NotificationRepository {
  /**
   * The booking's notification, if any. One booking is notified at most once, so
   * this is the idempotency key the application service dedups on.
   */
  findByBooking(bookingId: string): Promise<Notification | undefined>;

  /**
   * Persist a freshly-sent notification. Inserts on `bookingId` — a booking holds
   * exactly one notification record. Callers guard with {@link findByBooking}
   * first, so this is never asked to overwrite an existing record.
   */
  save(notification: Notification): Promise<void>;
}

/**
 * An in-memory {@link NotificationRepository}, the reference implementation used
 * as a fake in tests until the Postgres-backed store lands. Reads hand back copies
 * and writes store copies, so callers cannot observe or corrupt internal state —
 * the isolation a transactional row insert would give.
 */
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly byBooking = new Map<string, Notification>();

  async findByBooking(bookingId: string): Promise<Notification | undefined> {
    const notification = this.byBooking.get(bookingId);
    return notification ? { ...notification } : undefined;
  }

  async save(notification: Notification): Promise<void> {
    this.byBooking.set(notification.bookingId, { ...notification });
  }
}
