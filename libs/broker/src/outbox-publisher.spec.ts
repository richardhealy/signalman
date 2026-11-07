import { createOutboxRecord } from '@signalman/outbox';
import { InMemoryBroker } from './memory-broker';
import { type BrokerMessage } from './message';
import { BrokerPublisher, toBrokerMessage } from './outbox-publisher';

const record = createOutboxRecord(
  {
    aggregateType: 'booking',
    aggregateId: 'bk_1',
    eventType: 'ledger.committed',
    payload: { amount: 42 },
  },
  { idFactory: () => 'rec_1', clock: () => new Date('2026-10-06T09:00:00.000Z') },
);

describe('toBrokerMessage', () => {
  it('maps an outbox record onto a broker message', () => {
    expect(toBrokerMessage(record)).toEqual({
      id: 'rec_1',
      subject: 'ledger.committed',
      payload: { amount: 42 },
      headers: record.headers,
      occurredAt: '2026-10-06T09:00:00.000Z',
    });
  });

  it("carries the record's staging time, not the publish time, as occurredAt", () => {
    // A row retried after a failed publish goes out later than rows staged after
    // it; consumers order by occurredAt, so it must stay the staging time.
    const retried = { ...record, attempts: 3, availableAt: new Date('2026-10-06T09:05:00.000Z') };
    expect(toBrokerMessage(retried).occurredAt).toBe('2026-10-06T09:00:00.000Z');
  });
});

describe('BrokerPublisher', () => {
  it('publishes the mapped message onto the broker', async () => {
    const broker = new InMemoryBroker();
    const received: BrokerMessage[] = [];
    broker.subscribe('ledger.committed', async (m) => void received.push(m));

    await new BrokerPublisher(broker).publish(record);
    await broker.drain();

    expect(received).toEqual([toBrokerMessage(record)]);
  });
});
