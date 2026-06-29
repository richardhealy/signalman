import { InMemoryBroker } from './memory-broker';
import { type BrokerMessage } from './message';
import { BrokerSubscriptionHost } from './subscription-host';

/** A minimal broker message on a subject. */
function message(subject: string, id = 'm1'): BrokerMessage {
  return { id, subject, payload: { ok: true }, headers: {} };
}

describe('BrokerSubscriptionHost', () => {
  it('start() establishes the subscriptions so a published message is delivered', async () => {
    const broker = new InMemoryBroker();
    const received: string[] = [];
    const host = new BrokerSubscriptionHost({
      broker,
      subscriptions: [
        {
          subjects: 'ledger.committed',
          handler: (m) => {
            received.push(m.subject);
            return Promise.resolve();
          },
        },
      ],
    });

    host.start();
    await broker.publish(message('ledger.committed'));
    await broker.drain();

    expect(received).toEqual(['ledger.committed']);
  });

  it('onApplicationBootstrap() starts consuming without a manual start()', async () => {
    const broker = new InMemoryBroker();
    const received: string[] = [];
    const host = new BrokerSubscriptionHost({
      broker,
      subscriptions: [
        {
          subjects: 'ledger.>',
          handler: (m) => {
            received.push(m.subject);
            return Promise.resolve();
          },
        },
      ],
    });

    host.onApplicationBootstrap();
    await broker.publish(message('ledger.committed'));
    await broker.drain();

    expect(received).toEqual(['ledger.committed']);
  });

  it('establishes every configured subscription', async () => {
    const broker = new InMemoryBroker();
    const received: string[] = [];
    const host = new BrokerSubscriptionHost({
      broker,
      subscriptions: [
        {
          subjects: 'ledger.committed',
          handler: (m) => {
            received.push(m.subject);
            return Promise.resolve();
          },
        },
        {
          subjects: 'inventory.>',
          handler: (m) => {
            received.push(m.subject);
            return Promise.resolve();
          },
        },
      ],
    });

    host.start();
    await broker.publish(message('ledger.committed', 'm1'));
    await broker.publish(message('inventory.held', 'm2'));
    await broker.drain();

    expect(received.sort()).toEqual(['inventory.held', 'ledger.committed']);
  });

  it('onApplicationShutdown() drops the subscriptions and tears the broker down', async () => {
    const broker = new InMemoryBroker();
    const received: string[] = [];
    let closed = false;
    const host = new BrokerSubscriptionHost({
      broker,
      subscriptions: [
        {
          subjects: 'ledger.>',
          handler: (m) => {
            received.push(m.subject);
            return Promise.resolve();
          },
        },
      ],
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });

    host.start();
    await host.onApplicationShutdown();

    // close ran...
    expect(closed).toBe(true);

    // ...and the subscription is gone: a message published after shutdown is not delivered.
    await broker.publish(message('ledger.committed'));
    await broker.drain();
    expect(received).toEqual([]);
  });

  it('start() is idempotent — one delivery per message, not one per call', async () => {
    const broker = new InMemoryBroker();
    const received: string[] = [];
    const host = new BrokerSubscriptionHost({
      broker,
      subscriptions: [
        {
          subjects: 'ledger.committed',
          handler: (m) => {
            received.push(m.subject);
            return Promise.resolve();
          },
        },
      ],
    });

    host.start();
    host.start();
    await broker.publish(message('ledger.committed'));
    await broker.drain();

    expect(received).toEqual(['ledger.committed']);
  });

  it('a throwing handler NACKs and the broker redelivers (at-least-once)', async () => {
    const broker = new InMemoryBroker();
    let attempts = 0;
    const host = new BrokerSubscriptionHost({
      broker,
      subscriptions: [
        {
          subjects: 'ledger.committed',
          handler: () => {
            attempts += 1;
            if (attempts < 3) {
              return Promise.reject(new Error('provider outage'));
            }
            return Promise.resolve();
          },
        },
      ],
    });

    host.start();
    await broker.publish(message('ledger.committed'));
    await broker.drain();

    // Two NACKs then success — the host does not swallow the rejection.
    expect(attempts).toBe(3);
  });
});
