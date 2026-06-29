import { Test } from '@nestjs/testing';
import {
  BrokerSubscriptionHost,
  InMemoryBroker,
  type BrokerFromEnvResult,
  type BrokerMessage,
} from '@signalman/broker';
import {
  type NotificationChannel,
  type NotificationReceipt,
  type NotificationRequest,
} from './channel';
import { type NotificationRepository } from './notification-repository';
import {
  MESSAGE_BROKER,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_REPOSITORY,
  NotifierModule,
} from './notifier.module';
import { LEDGER_COMMITTED_SUBJECT } from './subscription';

/** A channel that records each accepted send, so the test can count provider hits. */
class CountingChannel implements NotificationChannel {
  readonly sends: NotificationRequest[] = [];

  async send(request: NotificationRequest): Promise<NotificationReceipt> {
    this.sends.push(request);
    return { providerMessageId: `prov_${this.sends.length}` };
  }
}

/** A delivered `ledger.committed` broker message for a booking. */
function ledgerCommitted(bookingId: string, id: string): BrokerMessage {
  return {
    id,
    subject: LEDGER_COMMITTED_SUBJECT,
    payload: { bookingId, amount: 4200, currency: 'USD', entryId: `led_${bookingId}` },
    headers: {},
  };
}

/**
 * Proves the per-service wiring, not the consumer mechanics (those live in
 * `booking-event-consumer.spec.ts`): that the {@link BrokerSubscriptionHost} the
 * module registers subscribes the notifier's consumer to `ledger.committed` on the
 * *same* broker the service is configured with, so a delivered terminal event
 * actually drives the notification. The `MESSAGE_BROKER` provider is overridden with
 * a shared in-memory broker the test publishes onto, and the channel with a counting
 * fake so the effectively-once guarantee is observable end to end.
 */
describe('notifier subscription wiring', () => {
  async function bootModule(channel: CountingChannel): Promise<{
    broker: InMemoryBroker;
    host: BrokerSubscriptionHost;
    notifications: NotificationRepository;
    close: () => Promise<void>;
  }> {
    const broker = new InMemoryBroker();
    const brokerResult: BrokerFromEnvResult = {
      broker,
      kind: 'memory',
      close: () => Promise.resolve(),
    };

    const moduleRef = await Test.createTestingModule({ imports: [NotifierModule] })
      .overrideProvider(MESSAGE_BROKER)
      .useValue(brokerResult)
      .overrideProvider(NOTIFICATION_CHANNEL)
      .useValue(channel)
      .compile();

    const host = moduleRef.get(BrokerSubscriptionHost);
    const notifications = moduleRef.get<NotificationRepository>(NOTIFICATION_REPOSITORY);
    host.start();

    return { broker, host, notifications, close: () => moduleRef.close() };
  }

  it('notifies the customer when a ledger.committed event is delivered off the broker', async () => {
    const channel = new CountingChannel();
    const { broker, notifications, close } = await bootModule(channel);

    await broker.publish(ledgerCommitted('bk_1', 'evt_1'));
    await broker.drain();

    const notification = await notifications.findByBooking('bk_1');
    expect(notification?.bookingId).toBe('bk_1');
    expect(channel.sends).toHaveLength(1);
    expect(channel.sends[0]).toMatchObject({ bookingId: 'bk_1', kind: 'booking_confirmed' });

    await close();
  });

  it('dedups a redelivered message — the customer is told exactly once', async () => {
    const channel = new CountingChannel();
    const { broker, notifications, close } = await bootModule(channel);

    // The same message id delivered twice (the at-least-once duplicate the inbox absorbs).
    await broker.publish(ledgerCommitted('bk_1', 'evt_1'));
    await broker.drain();
    await broker.publish(ledgerCommitted('bk_1', 'evt_1'));
    await broker.drain();

    expect(channel.sends).toHaveLength(1);
    expect(await notifications.findByBooking('bk_1')).toBeDefined();

    await close();
  });
});
