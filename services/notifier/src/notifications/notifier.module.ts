/**
 * Wiring for the notifier — the async tail of the saga.
 *
 * It binds a {@link BookingNotificationConsumer} (the inbox-dedup, trace-continuing
 * edge) to a {@link NotifierService} backed by the in-memory notification
 * repository, sending through a {@link SimulatedNotificationChannel} for the
 * external provider boundary. The in-memory stores are the reference
 * implementations the `@signalman/*` libraries ship; the Postgres-backed stores —
 * and the broker subscription that drives the consumer — land with the datastore
 * and broker milestones, swapped in here behind the same
 * {@link NOTIFICATION_REPOSITORY}/{@link INBOX_STORE} tokens.
 *
 * The provider's latency and failure rates are read from the environment so the
 * demo can make the notification hop slow or flaky without code changes; the
 * defaults keep it fast and reliable, since the notification is the saga's tail
 * rather than a divergence source.
 */
import { Module } from '@nestjs/common';
import { InMemoryInboxStore, type InboxStore } from '@signalman/inbox';
import {
  BookingNotificationConsumer,
  type BookingNotificationConsumerOptions,
} from './booking-event-consumer';
import { SimulatedNotificationChannel, type NotificationChannel } from './channel';
import {
  InMemoryNotificationRepository,
  type NotificationRepository,
} from './notification-repository';
import { NotifierService } from './notifier.service';

/** DI token for the {@link NotificationRepository} the service persists notifications through. */
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

/** DI token for the {@link NotificationChannel} the service sends through. */
export const NOTIFICATION_CHANNEL = Symbol('NOTIFICATION_CHANNEL');

/** DI token for the {@link InboxStore} the consumer dedups through. */
export const INBOX_STORE = Symbol('INBOX_STORE');

/** Read a 0–1 rate (or any number) from the environment, falling back when unset or invalid. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

@Module({
  providers: [
    {
      provide: NOTIFICATION_REPOSITORY,
      useFactory: (): NotificationRepository => new InMemoryNotificationRepository(),
    },
    {
      provide: NOTIFICATION_CHANNEL,
      useFactory: (): NotificationChannel =>
        new SimulatedNotificationChannel({
          latencyMs: envNumber('NOTIFIER_LATENCY_MS', 50),
          failureRate: envNumber('NOTIFIER_FAILURE_RATE', 0),
        }),
    },
    { provide: INBOX_STORE, useFactory: (): InboxStore => new InMemoryInboxStore() },
    {
      provide: NotifierService,
      useFactory: (notifications: NotificationRepository, channel: NotificationChannel): NotifierService =>
        new NotifierService({ notifications, channel }),
      inject: [NOTIFICATION_REPOSITORY, NOTIFICATION_CHANNEL],
    },
    {
      provide: BookingNotificationConsumer,
      useFactory: (notifier: NotifierService, store: InboxStore): BookingNotificationConsumer => {
        const options: BookingNotificationConsumerOptions = { notifier, store };
        if (process.env.NOTIFIER_MESSAGING_SYSTEM) {
          options.messagingSystem = process.env.NOTIFIER_MESSAGING_SYSTEM;
        }
        return new BookingNotificationConsumer(options);
      },
      inject: [NotifierService, INBOX_STORE],
    },
  ],
})
export class NotifierModule {}
