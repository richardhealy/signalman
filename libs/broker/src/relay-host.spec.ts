import { createOutboxRecord, InMemoryOutboxStore } from '@signalman/outbox';
import { InMemoryBroker } from './memory-broker';
import { OutboxRelayHost } from './relay-host';

/** Stage one pending event into a fresh store, returning both. */
async function stagedStore(eventType: string): Promise<InMemoryOutboxStore> {
  const store = new InMemoryOutboxStore();
  await store.add(
    createOutboxRecord({
      aggregateType: 'booking',
      aggregateId: 'bk_1',
      eventType,
      payload: { bookingId: 'bk_1' },
    }),
  );
  return store;
}

/** Collect every message delivered to a subject pattern. */
function collect(broker: InMemoryBroker, pattern: string): string[] {
  const subjects: string[] = [];
  broker.subscribe(pattern, (message) => {
    subjects.push(message.subject);
    return Promise.resolve();
  });
  return subjects;
}

describe('OutboxRelayHost', () => {
  it('flush() drains the outbox onto the broker in a single pass', async () => {
    const store = await stagedStore('ledger.committed');
    const broker = new InMemoryBroker();
    const delivered = collect(broker, 'ledger.>');
    const host = new OutboxRelayHost({ store, broker, messagingSystem: 'memory' });

    await host.flush();
    await broker.drain();

    expect(delivered).toEqual(['ledger.committed']);
  });

  it('onApplicationBootstrap() starts polling so a staged event is delivered without a manual flush', async () => {
    const store = await stagedStore('inventory.held');
    const broker = new InMemoryBroker();
    const delivered = collect(broker, 'inventory.>');
    const host = new OutboxRelayHost({
      store,
      broker,
      messagingSystem: 'memory',
      pollIntervalMs: 5,
    });

    host.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await broker.drain();
    await host.onApplicationShutdown();

    expect(delivered).toEqual(['inventory.held']);
  });

  it('onApplicationShutdown() stops the scheduler and tears the broker down', async () => {
    const store = await stagedStore('supplier.confirmed');
    const broker = new InMemoryBroker();
    const delivered = collect(broker, 'supplier.>');
    let closed = false;
    const host = new OutboxRelayHost({
      store,
      broker,
      messagingSystem: 'memory',
      pollIntervalMs: 5,
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });

    host.start();
    await host.onApplicationShutdown();

    // close ran...
    expect(closed).toBe(true);

    // ...and the scheduler is stopped: an event staged after shutdown is not delivered.
    await store.add(
      createOutboxRecord({
        aggregateType: 'booking',
        aggregateId: 'bk_2',
        eventType: 'supplier.confirmed',
        payload: { bookingId: 'bk_2' },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await broker.drain();

    // Only the first booking's event (flushed during shutdown) was delivered.
    expect(delivered).toEqual(['supplier.confirmed']);
  });

  it('start() is idempotent', async () => {
    const store = await stagedStore('payment.captured');
    const broker = new InMemoryBroker();
    const delivered = collect(broker, 'payment.>');
    const host = new OutboxRelayHost({ store, broker, pollIntervalMs: 5 });

    host.start();
    host.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await broker.drain();
    await host.stop();

    expect(delivered).toEqual(['payment.captured']);
  });
});
