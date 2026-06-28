import {
  NotificationChannelUnavailableError,
  type NotificationChannel,
  type NotificationReceipt,
  type NotificationRequest,
} from './channel';
import { InMemoryNotificationRepository } from './notification-repository';
import { NotifierService } from './notifier.service';

/** A scripted {@link NotificationChannel} that records calls and returns canned receipts. */
class FakeChannel implements NotificationChannel {
  receipt: NotificationReceipt = { providerMessageId: 'msg_provider_1' };
  sendError?: Error;
  readonly sendCalls: NotificationRequest[] = [];

  async send(request: NotificationRequest): Promise<NotificationReceipt> {
    this.sendCalls.push(request);
    if (this.sendError) {
      throw this.sendError;
    }
    return this.receipt;
  }
}

function makeService() {
  const notifications = new InMemoryNotificationRepository();
  const channel = new FakeChannel();
  let seq = 0;
  const service = new NotifierService({
    notifications,
    channel,
    idFactory: () => `notif_${++seq}`,
    clock: () => new Date('2026-06-29T00:00:00Z'),
  });
  return { service, notifications, channel };
}

const command = { bookingId: 'bk_1', amount: 4200, currency: 'USD', entryId: 'entry_1' };

describe('NotifierService', () => {
  describe('notifyBookingConfirmed', () => {
    it('sends via the provider, records the notification, and reports the reference', async () => {
      const { service, notifications, channel } = makeService();

      const result = await service.notifyBookingConfirmed(command);

      expect(result).toEqual({
        notificationId: 'notif_1',
        reference: 'msg_provider_1',
        recipient: 'booking-bk_1@example.com',
      });
      expect(channel.sendCalls).toEqual([
        {
          bookingId: 'bk_1',
          recipient: 'booking-bk_1@example.com',
          channel: 'email',
          kind: 'booking_confirmed',
        },
      ]);
      await expect(notifications.findByBooking('bk_1')).resolves.toMatchObject({
        id: 'notif_1',
        bookingId: 'bk_1',
        kind: 'booking_confirmed',
        channel: 'email',
        recipient: 'booking-bk_1@example.com',
        reference: 'msg_provider_1',
        sentAt: new Date('2026-06-29T00:00:00Z'),
      });
    });

    it('is idempotent per booking: a repeat returns the standing record without sending again', async () => {
      const { service, channel } = makeService();

      const first = await service.notifyBookingConfirmed(command);
      const second = await service.notifyBookingConfirmed(command);

      expect(second).toEqual(first);
      expect(channel.sendCalls).toHaveLength(1); // provider hit once, not twice
    });

    it('propagates a provider outage without recording anything (so a redelivery can retry)', async () => {
      const { service, notifications, channel } = makeService();
      channel.sendError = new NotificationChannelUnavailableError('notification provider unreachable');

      await expect(service.notifyBookingConfirmed(command)).rejects.toBeInstanceOf(
        NotificationChannelUnavailableError,
      );
      await expect(notifications.findByBooking('bk_1')).resolves.toBeUndefined();
    });

    it('resolves the recipient through an injected lookup when provided', async () => {
      const notifications = new InMemoryNotificationRepository();
      const channel = new FakeChannel();
      const service = new NotifierService({
        notifications,
        channel,
        channelKind: 'sms',
        recipientFor: (bookingId) => `+1-555-${bookingId}`,
        idFactory: () => 'notif_1',
        clock: () => new Date('2026-06-29T00:00:00Z'),
      });

      const result = await service.notifyBookingConfirmed(command);

      expect(result.recipient).toBe('+1-555-bk_1');
      expect(channel.sendCalls[0]).toMatchObject({ recipient: '+1-555-bk_1', channel: 'sms' });
    });
  });
});
