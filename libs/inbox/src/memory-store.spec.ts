import { InMemoryInboxStore } from './memory-store';
import { type InboxKey } from './record';

const now = new Date('2026-06-28T10:00:00.000Z');
const key: InboxKey = { consumer: 'ledger', messageId: 'msg_1' };

describe('InMemoryInboxStore', () => {
  let store: InMemoryInboxStore;

  beforeEach(() => {
    store = new InMemoryInboxStore();
  });

  it('runs the handler on a first delivery and records the marker', async () => {
    const work = jest.fn().mockResolvedValue('done');

    const outcome = await store.processOnce(key, work, { now });

    expect(outcome).toEqual({ duplicate: false, result: 'done' });
    expect(work).toHaveBeenCalledTimes(1);
    expect(await store.seen(key)).toBe(true);
    expect(store.get(key)).toEqual({ consumer: 'ledger', messageId: 'msg_1', processedAt: now });
  });

  it('skips the handler on a redelivery of the same message', async () => {
    const first = jest.fn().mockResolvedValue('first');
    const second = jest.fn().mockResolvedValue('second');

    await store.processOnce(key, first, { now });
    const outcome = await store.processOnce(key, second, { now });

    expect(outcome).toEqual({ duplicate: true });
    expect(second).not.toHaveBeenCalled();
  });

  it('keeps a message unseen and re-runnable when the handler throws (rollback)', async () => {
    const boom = new Error('handler failed');
    const failing = jest.fn().mockRejectedValue(boom);

    await expect(store.processOnce(key, failing, { now })).rejects.toBe(boom);
    // The marker must not persist, or the redelivery would be wrongly skipped.
    expect(await store.seen(key)).toBe(false);

    const retry = jest.fn().mockResolvedValue('recovered');
    const outcome = await store.processOnce(key, retry, { now });
    expect(outcome).toEqual({ duplicate: false, result: 'recovered' });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('claims synchronously so interleaved redeliveries do not both run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = jest.fn().mockImplementation(() => gate.then(() => 'slow'));
    const fast = jest.fn().mockResolvedValue('fast');

    // Start the first (slow) handler, then a second delivery before it settles.
    const firstCall = store.processOnce(key, slow, { now });
    const secondCall = store.processOnce(key, fast, { now });
    release();

    expect(await firstCall).toEqual({ duplicate: false, result: 'slow' });
    expect(await secondCall).toEqual({ duplicate: true });
    expect(fast).not.toHaveBeenCalled();
  });

  it('dedups per consumer: fan-out consumers each process the message once', async () => {
    const ledgerKey: InboxKey = { consumer: 'ledger', messageId: 'msg_1' };
    const notifierKey: InboxKey = { consumer: 'notifier', messageId: 'msg_1' };

    await store.processOnce(ledgerKey, jest.fn().mockResolvedValue(undefined), { now });
    const notifierOutcome = await store.processOnce(
      notifierKey,
      jest.fn().mockResolvedValue(undefined),
      { now },
    );

    // The same message id is still fresh for a different consumer.
    expect(notifierOutcome.duplicate).toBe(false);
    expect(store.size).toBe(2);
    expect(store.processedBy('ledger').map((r) => r.messageId)).toEqual(['msg_1']);
    expect(store.processedBy('notifier').map((r) => r.messageId)).toEqual(['msg_1']);
  });

  it('returns defensive copies and reports unseen keys', async () => {
    await store.processOnce(key, jest.fn().mockResolvedValue(undefined), { now });

    const fetched = store.get(key)!;
    (fetched as { consumer: string }).consumer = 'tampered';
    expect(store.get(key)?.consumer).toBe('ledger');

    expect(store.get({ consumer: 'ledger', messageId: 'missing' })).toBeUndefined();
    expect(await store.seen({ consumer: 'ledger', messageId: 'missing' })).toBe(false);
  });

  it('does not let separator collisions merge distinct keys', async () => {
    // A naive `${consumer} ${messageId}` join would make these two keys collide;
    // they must stay distinct.
    const a: InboxKey = { consumer: 'a', messageId: 'b c' };
    const b: InboxKey = { consumer: 'a b', messageId: 'c' };

    await store.processOnce(a, jest.fn().mockResolvedValue(undefined), { now });
    const outcome = await store.processOnce(b, jest.fn().mockResolvedValue(undefined), { now });

    expect(outcome.duplicate).toBe(false);
    expect(store.size).toBe(2);
  });
});
