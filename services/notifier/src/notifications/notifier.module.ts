/**
 * Wiring for the notifier — the async tail of the saga.
 *
 * It binds a {@link BookingNotificationConsumer} (the inbox-dedup, trace-continuing
 * edge) to a {@link NotifierService} backed by the in-memory notification
 * repository, sending through a {@link SimulatedNotificationChannel} for the
 * external provider boundary, and runs a {@link BrokerSubscriptionHost} that
 * subscribes that consumer to `ledger.committed` off the configured broker — so a
 * booking's terminal event actually drives the notification in a running service,
 * not just in unit tests. The broker is chosen from the environment
 * ({@link createBrokerFromEnv} — in-memory by default, NATS when `BROKER=nats`),
 * the consume-side mirror of the producing legs' {@link OutboxRelayHost}. The
 * in-memory stores are the reference implementations the `@signalman/*` libraries
 * ship; the Postgres-backed stores swap in here behind the same
 * {@link NOTIFICATION_REPOSITORY}/{@link INBOX_STORE} tokens with the datastore
 * milestone.
 *
 * The provider's latency and failure rates are read from the environment so the
 * demo can make the notification hop slow or flaky without code changes; the
 * defaults keep it fast and reliable, since the notification is the saga's tail
 * rather than a divergence source.
 */
import { Module } from '@nestjs/common';
import {
  BrokerSubscriptionHost,
  createBrokerFromEnv,
  type BrokerFromEnvResult,
} from '@signalman/broker';
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
import { LEDGER_COMMITTED_SUBJECT, ledgerCommittedHandler } from './subscription';

/** DI token for the {@link NotificationRepository} the service persists notifications through. */
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

/** DI token for the {@link NotificationChannel} the service sends through. */
export const NOTIFICATION_CHANNEL = Symbol('NOTIFICATION_CHANNEL');

/** DI token for the {@link InboxStore} the consumer dedups through. */
export const INBOX_STORE = Symbol('INBOX_STORE');

/** DI token for the {@link BrokerFromEnvResult} the subscription host consumes from. */
export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

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
        const messagingSystem = process.env.NOTIFIER_MESSAGING_SYSTEM;
        if (messagingSystem) {
          options.messagingSystem = messagingSystem;
        }
        return new BookingNotificationConsumer(options);
      },
      inject: [NotifierService, INBOX_STORE],
    },
    { provide: MESSAGE_BROKER, useFactory: (): Promise<BrokerFromEnvResult> => createBrokerFromEnv() },
    {
      provide: BrokerSubscriptionHost,
      useFactory: (
        consumer: BookingNotificationConsumer,
        broker: BrokerFromEnvResult,
      ): BrokerSubscriptionHost =>
        new BrokerSubscriptionHost({
          broker: broker.broker,
          subscriptions: [
            { subjects: LEDGER_COMMITTED_SUBJECT, handler: ledgerCommittedHandler(consumer) },
          ],
          close: broker.close,
        }),
      inject: [BookingNotificationConsumer, MESSAGE_BROKER],
    },
  ],
})
export class NotifierModule {}
