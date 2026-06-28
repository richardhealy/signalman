/**
 * The transactional outbox proven under crash — the spec's quality-checklist
 * item "Transactional outbox proven under crash: no lost and no phantom events"
 * (M2), and definition-of-done #3.
 *
 * Each test pins down one half of the guarantee against a precise crash point:
 *
 * - **No phantom events.** A staging transaction that rolls back leaves no
 *   outbox row, so the relay never publishes an event for a state change that
 *   did not commit.
 * - **No lost events.** A row that committed is published even when the relay
 *   crashes mid-publish: its lease expires and a restarted relay re-claims it.
 * - **At-least-once across a crash.** A crash *between* the broker accepting the
 *   event and the relay recording it re-delivers the event rather than dropping
 *   it — the duplicate an idempotent consumer absorbs (proven against the broker
 *   in `@signalman/broker`).
 */
import { InMemoryOutboxStore } from './memory-store';
import { createOutboxRecord, type OutboxRecord } from './record';
import { OutboxRelay, type Publisher } from './relay';
import { type OutboxStore } from './store';
import { runInTransaction, type UnitOfWork } from './transaction';

/** A publisher that records what the broker accepted and never fails. */
function capturingPublisher(): Publisher & { sent: OutboxRecord[] } {
  const sent: OutboxRecord[] = [];
  return { sent, publish: async (record) => void sent.push(record) };
}

/**
 * A stand-in for a service's own source-of-truth store. Like the real per-service
 * repositories it can enlist its write into the surrounding unit of work, so the
 * business state and the outbox row commit together.
 */
class FakeBusinessStore {
  private readonly rows = new Map<string, unknown>();

  async save(id: string, value: unknown, tx?: UnitOfWork): Promise<void> {
    const write = (): void => void this.rows.set(id, value);
    if (tx) {
      tx.defer(write);
    } else {
      write();
    }
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  get size(): number {
    return this.rows.size;
  }
}

/**
 * Wrap a store so its first {@link OutboxStore.markPublished} throws — modelling a
 * process that dies after the broker accepted the event but before it recorded
 * the success. Every other call delegates to the underlying store.
 */
function crashOnFirstMark(store: InMemoryOutboxStore): OutboxStore {
  let crashed = false;
  return {
    add: (record, tx) => store.add(record, tx),
    claimBatch: (options) => store.claimBatch(options),
    markPublished: async (id, at) => {
      if (!crashed) {
        crashed = true;
        throw new Error('process died before recording publish');
      }
      return store.markPublished(id, at);
    },
    markFailed: (id, options) => store.markFailed(id, options),
  };
}

const t0 = new Date('2026-06-29T10:00:00.000Z');
const message = {
  aggregateType: 'booking',
  aggregateId: 'bk_1',
  eventType: 'ledger.committed',
  payload: { bookingId: 'bk_1', amount: 4200 },
} as const;

describe('transactional outbox durability', () => {
  let store: InMemoryOutboxStore;
  let business: FakeBusinessStore;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
    business = new FakeBusinessStore();
  });

  it('commits the business state and the outbox row together', async () => {
    await runInTransaction(async (tx) => {
      await business.save('bk_1', { posted: true }, tx);
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => t0 }), tx);
    });

    expect(business.has('bk_1')).toBe(true);
    expect(store.get('rec_1')).toMatchObject({ status: 'pending', eventType: 'ledger.committed' });
  });

  it('stages no event when the staging transaction rolls back — no phantom events', async () => {
    const publisher = capturingPublisher();

    // A booking is staged, then the transaction aborts (e.g. a constraint trips
    // on commit). Neither the business write nor the outbox row may survive.
    await expect(
      runInTransaction(async (tx) => {
        await business.save('bk_1', { posted: true }, tx);
        await store.add(
          createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => t0 }),
          tx,
        );
        throw new Error('booking rejected after staging');
      }),
    ).rejects.toThrow('booking rejected after staging');

    expect(business.size).toBe(0);
    expect(store.size).toBe(0);

    // The relay therefore has nothing to publish: no phantom event escapes.
    const relay = new OutboxRelay({ store, publisher, clock: () => t0 });
    expect(await relay.relayOnce()).toMatchObject({ claimed: 0, published: 0 });
    expect(publisher.sent).toHaveLength(0);
  });

  it('publishes a committed event after the relay crashes mid-publish — no lost events', async () => {
    const publisher = capturingPublisher();

    // The business transaction committed the state and the outbox row together.
    await runInTransaction(async (tx) => {
      await business.save('bk_1', { posted: true }, tx);
      await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => t0 }), tx);
    });

    // A relay claims the row — leasing it for 30s — then the process dies before
    // it can publish. The lease is what guards the row from a second relay.
    await store.claimBatch({ batchSize: 10, now: t0, leaseMs: 30_000 });

    // While the lease is live, a restarted relay sees nothing due: the event is
    // held safely, not lost and not double-published.
    const withinLease = new Date(t0.getTime() + 10_000);
    const eager = new OutboxRelay({ store, publisher, clock: () => withinLease });
    expect(await eager.relayOnce()).toMatchObject({ claimed: 0 });
    expect(publisher.sent).toHaveLength(0);

    // Once the lease expires the row becomes claimable again, and a relay
    // publishes it — the committed event is delivered, never lost.
    const afterLease = new Date(t0.getTime() + 30_001);
    const recovered = new OutboxRelay({ store, publisher, clock: () => afterLease });
    expect(await recovered.relayOnce()).toMatchObject({ claimed: 1, published: 1 });
    expect(publisher.sent.map((r) => r.id)).toEqual(['rec_1']);
    expect(store.get('rec_1')).toMatchObject({ status: 'published' });
  });

  it('re-delivers when the relay crashes between publish and recording it — at-least-once', async () => {
    const publisher = capturingPublisher();
    await store.add(createOutboxRecord(message, { idFactory: () => 'rec_1', clock: () => t0 }));

    // First pass: the broker accepts the event, but the process dies before the
    // store records the success. The relay treats it as a failed publish and
    // reschedules — the event was sent but is not yet marked published.
    const crashing = new OutboxRelay({
      store: crashOnFirstMark(store),
      publisher,
      clock: () => t0,
      backoff: () => 5_000,
    });
    expect(await crashing.relayOnce()).toMatchObject({ published: 0, retried: 1 });
    expect(publisher.sent).toHaveLength(1);
    expect(store.get('rec_1')).toMatchObject({ status: 'pending', attempts: 1 });

    // Second pass after the back-off: the restarted relay re-publishes (the
    // duplicate an idempotent consumer absorbs) and records it published. The
    // event is delivered at least once across the crash — never lost.
    const afterBackoff = new Date(t0.getTime() + 5_000);
    const recovered = new OutboxRelay({ store, publisher, clock: () => afterBackoff });
    expect(await recovered.relayOnce()).toMatchObject({ published: 1 });
    expect(publisher.sent.map((r) => r.id)).toEqual(['rec_1', 'rec_1']);
    expect(store.get('rec_1')).toMatchObject({ status: 'published' });
  });
});
