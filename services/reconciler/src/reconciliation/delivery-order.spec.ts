import { BrokerPublisher, InMemoryBroker } from '@signalman/broker';
import {
  createOutboxRecord,
  InMemoryOutboxStore,
  OutboxRelay,
  type OutboxRecord,
  type Publisher,
} from '@signalman/outbox';
import { BrokerSourceOfTruthGateway } from './broker-gateway';
import { InMemoryDivergenceFindingRepository } from './finding-repository';
import { ReconcilerService } from './reconciler.service';

/**
 * The outbox relay is at-least-once and does not hold back later rows while an
 * earlier one waits out its retry back-off, so a source event can reach the
 * reconciler *after* an event its service staged later. These tests drive that
 * through the real relay and broker and check the reconciler still sees each
 * service's latest state, instead of whichever event happened to arrive last.
 */
describe('reconciler under out-of-order delivery', () => {
  const t0 = new Date('2026-10-06T09:00:00.000Z');
  const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1_000);

  /** Stage a source event for `bookingId` as its service would, at `stagedAt`. */
  function stage(eventType: string, bookingId: string, stagedAt: Date): OutboxRecord {
    return createOutboxRecord(
      { aggregateType: 'test', aggregateId: bookingId, eventType, payload: { bookingId } },
      { clock: () => stagedAt },
    );
  }

  /** A publisher that fails the first attempt of the given event types, then succeeds. */
  function flakyOnce(inner: Publisher, eventTypes: string[]): Publisher {
    const failed = new Set<string>();
    return {
      async publish(record: OutboxRecord): Promise<void> {
        if (eventTypes.includes(record.eventType) && !failed.has(record.id)) {
          failed.add(record.id);
          throw new Error('broker unavailable');
        }
        await inner.publish(record);
      },
    };
  }

  async function harness(records: OutboxRecord[], failFirst: string[]) {
    const broker = new InMemoryBroker();
    const gateway = new BrokerSourceOfTruthGateway({ settleGraceMs: 0 });
    broker.subscribe(['inventory.*', 'supplier.*', 'ledger.*'], gateway.handler());

    const store = new InMemoryOutboxStore();
    for (const record of records) {
      await store.add(record);
    }

    let now = at(10);
    const relay = new OutboxRelay({
      store,
      publisher: flakyOnce(new BrokerPublisher(broker), failFirst),
      backoff: () => 1_000,
      clock: () => now,
    });

    // First pass: the flaky events fail and are rescheduled, the rest publish.
    await relay.relayOnce();
    await broker.drain();
    // Second pass, after the back-off: the retried events publish, late.
    now = at(20);
    await relay.relayOnce();
    await broker.drain();

    const reconciler = new ReconcilerService({
      gateway,
      findings: new InMemoryDivergenceFindingRepository(),
    });
    return { gateway, reconciler };
  }

  it('does not let a retried supplier.confirmed undo the cancellation that followed it', async () => {
    // Capture failed after the supplier confirmed: the saga cancelled and released.
    const { gateway, reconciler } = await harness(
      [
        stage('inventory.held', 'bk_1', at(1)),
        stage('supplier.confirmed', 'bk_1', at(2)),
        stage('supplier.cancelled', 'bk_1', at(3)),
        stage('inventory.released', 'bk_1', at(4)),
      ],
      ['supplier.confirmed'],
    );

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot).toMatchObject({
      supplier: 'cancelled',
      inventory: 'released',
      ledger: 'absent',
    });

    const report = await reconciler.runOnce();
    expect(report.findingsCreated).toEqual([]);
  });

  it('does not report an orphaned hold when inventory.held arrives after its release', async () => {
    const { gateway, reconciler } = await harness(
      [stage('inventory.held', 'bk_1', at(1)), stage('inventory.released', 'bk_1', at(2))],
      ['inventory.held'],
    );

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot).toMatchObject({ inventory: 'released' });

    const report = await reconciler.runOnce();
    expect(report.findingsCreated).toEqual([]);
  });

  it('keeps a re-held booking held when the earlier release arrives late', async () => {
    // The same booking id retried after a failed saga: held, released, held again.
    const { gateway } = await harness(
      [
        stage('inventory.held', 'bk_1', at(1)),
        stage('inventory.released', 'bk_1', at(2)),
        stage('inventory.held', 'bk_1', at(3)),
      ],
      ['inventory.released'],
    );

    const [snapshot] = await gateway.collectSettled();
    expect(snapshot).toMatchObject({ inventory: 'held' });
  });

  it('still reports a real divergence delivered out of order', async () => {
    // Supplier confirmed and nothing compensated it; the ledger never committed.
    const { reconciler } = await harness(
      [stage('inventory.held', 'bk_1', at(1)), stage('supplier.confirmed', 'bk_1', at(2))],
      ['inventory.held'],
    );

    const report = await reconciler.runOnce();
    expect(report.findingsCreated.map((f) => f.kind)).toEqual([
      'supplier_confirmed_ledger_missing',
    ]);
  });
});
