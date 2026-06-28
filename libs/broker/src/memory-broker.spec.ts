import { InMemoryBroker } from './memory-broker';
import { type BrokerMessage } from './message';

function msg(subject: string, id = 'm1'): BrokerMessage {
  return { id, subject, payload: {}, headers: {} };
}

describe('InMemoryBroker', () => {
  it('delivers the full message — id, subject, payload, headers — to a subscriber', async () => {
    const broker = new InMemoryBroker();
    let received: BrokerMessage | undefined;
    broker.subscribe('ledger.committed', async (m) => {
      received = m;
    });

    await broker.publish({
      id: 'm1',
      subject: 'ledger.committed',
      payload: { amount: 42 },
      headers: { traceparent: 'tp' },
    });
    await broker.drain();

    expect(received).toEqual({
      id: 'm1',
      subject: 'ledger.committed',
      payload: { amount: 42 },
      headers: { traceparent: 'tp' },
    });
  });

  it('does not deliver to a subscription whose pattern does not match', async () => {
    const broker = new InMemoryBroker();
    const got: string[] = [];
    broker.subscribe('inventory.*', async (m) => void got.push(m.id));

    await broker.publish(msg('ledger.committed'));
    await broker.drain();

    expect(got).toEqual([]);
  });

  it('delivers messages on any of several subscribed subjects', async () => {
    const broker = new InMemoryBroker();
    const got: string[] = [];
    broker.subscribe(['inventory.held', 'supplier.confirmed'], async (m) => void got.push(m.subject));

    await broker.publish(msg('inventory.held', 'm1'));
    await broker.publish(msg('supplier.confirmed', 'm2'));
    await broker.publish(msg('ledger.committed', 'm3'));
    await broker.drain();

    expect(got.sort()).toEqual(['inventory.held', 'supplier.confirmed']);
  });

  it('fans a message out to every matching subscription', async () => {
    const broker = new InMemoryBroker();
    const a: string[] = [];
    const b: string[] = [];
    broker.subscribe('ledger.committed', async (m) => void a.push(m.id));
    broker.subscribe('ledger.>', async (m) => void b.push(m.id));

    await broker.publish(msg('ledger.committed', 'm1'));
    await broker.drain();

    expect(a).toEqual(['m1']);
    expect(b).toEqual(['m1']);
  });

  it('load-balances across members of a queue group instead of fanning out', async () => {
    const broker = new InMemoryBroker();
    const one: string[] = [];
    const two: string[] = [];
    broker.subscribe('inventory.held', async (m) => void one.push(m.id), { queue: 'workers' });
    broker.subscribe('inventory.held', async (m) => void two.push(m.id), { queue: 'workers' });

    await broker.publish(msg('inventory.held', 'm1'));
    await broker.publish(msg('inventory.held', 'm2'));
    await broker.drain();

    // Each member handles one of the two messages — load-balanced, not fanned out.
    expect([...one, ...two].sort()).toEqual(['m1', 'm2']);
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
  });

  it('redelivers a message when the handler throws, until it is acknowledged', async () => {
    const broker = new InMemoryBroker();
    let attempts = 0;
    broker.subscribe('ledger.committed', async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient');
      }
    });

    await broker.publish(msg('ledger.committed'));
    await broker.drain();

    expect(attempts).toBe(3);
  });

  it('dead-letters a message once it exhausts maxDeliver attempts', async () => {
    const deadLettered: Array<{ id: string; error: unknown }> = [];
    const broker = new InMemoryBroker({
      maxDeliver: 3,
      onDeadLetter: (m, error) => void deadLettered.push({ id: m.id, error }),
    });
    let attempts = 0;
    const boom = new Error('always down');
    broker.subscribe('ledger.committed', async () => {
      attempts += 1;
      throw boom;
    });

    await broker.publish(msg('ledger.committed', 'm1'));
    await broker.drain();

    expect(attempts).toBe(3);
    expect(deadLettered).toEqual([{ id: 'm1', error: boom }]);
  });

  it('stops delivering after unsubscribe', async () => {
    const broker = new InMemoryBroker();
    const got: string[] = [];
    const sub = broker.subscribe('ledger.committed', async (m) => void got.push(m.id));

    await broker.publish(msg('ledger.committed', 'm1'));
    await broker.drain();
    sub.unsubscribe();
    await broker.publish(msg('ledger.committed', 'm2'));
    await broker.drain();

    expect(got).toEqual(['m1']);
  });

  it('drain resolves immediately when there is nothing in flight', async () => {
    const broker = new InMemoryBroker();
    await expect(broker.drain()).resolves.toBeUndefined();
  });
});
