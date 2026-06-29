import { type BrokerMessage } from '@signalman/broker';
import { type BookingNotificationConsumer } from './booking-event-consumer';
import {
  LEDGER_COMMITTED_SUBJECT,
  ledgerCommittedHandler,
  toDeliveredLedgerCommitted,
} from './subscription';

/** A delivered `ledger.committed` broker message. */
function message(overrides: Partial<BrokerMessage> = {}): BrokerMessage {
  return {
    id: 'msg_1',
    subject: LEDGER_COMMITTED_SUBJECT,
    payload: { bookingId: 'bk_1', amount: 4200, currency: 'USD', entryId: 'led_1' },
    headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    ...overrides,
  };
}

describe('notifier subscription', () => {
  describe('toDeliveredLedgerCommitted', () => {
    it('maps a delivered broker message onto the consumer DeliveredEvent', () => {
      const delivered = toDeliveredLedgerCommitted(message());

      expect(delivered).toEqual({
        messageId: 'msg_1',
        eventType: 'ledger.committed',
        headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
        payload: { bookingId: 'bk_1', amount: 4200, currency: 'USD', entryId: 'led_1' },
      });
    });
  });

  describe('ledgerCommittedHandler', () => {
    it('routes each delivery through the consumer', async () => {
      const consume = jest.fn().mockResolvedValue({ status: 'processed' });
      const handler = ledgerCommittedHandler({ consume } as unknown as BookingNotificationConsumer);

      await handler(message());

      expect(consume).toHaveBeenCalledTimes(1);
      expect(consume).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg_1', eventType: 'ledger.committed' }),
      );
    });

    it('lets a consume rejection propagate so the broker NACKs the message', async () => {
      const consume = jest.fn().mockRejectedValue(new Error('provider outage'));
      const handler = ledgerCommittedHandler({ consume } as unknown as BookingNotificationConsumer);

      await expect(handler(message())).rejects.toThrow('provider outage');
    });
  });
});
