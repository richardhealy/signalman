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
  { idFactory: () => 'rec_1' },
);

describe('toBrokerMessage', () => {
  it('maps an outbox record onto a broker message', () => {
    expect(toBrokerMessage(record)).toEqual({
      id: 'rec_1',
      subject: 'ledger.committed',
      payload: { amount: 42 },
      headers: record.headers,
    });
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
