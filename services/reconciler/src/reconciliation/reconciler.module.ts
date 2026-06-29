/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} that drives a {@link ReconcilerService}
 * over the {@link BrokerSourceOfTruthGateway} (the broker-backed source of truth,
 * subscribing to `inventory.*`, `supplier.*`, and `ledger.*` events) and the
 * in-memory {@link DivergenceFindingRepository} reference implementation. The
 * interval and settle-grace window are read from the environment so the demo can
 * reconcile more or less aggressively without code changes. The Postgres-backed
 * findings store swaps in behind the {@link FINDING_REPOSITORY} token with the
 * datastore milestone.
 *
 * A {@link BrokerSubscriptionHost} subscribes the gateway's handler to
 * `['inventory.*', 'supplier.*', 'ledger.*']` on the configured broker, chosen
 * via {@link createBrokerFromEnv} — in-memory by default, NATS JetStream when
 * `BROKER=nats`. This is the consuming-side mirror of the producing legs'
 * {@link OutboxRelayHost}.
 */
import { Module } from '@nestjs/common';
import {
  BrokerSubscriptionHost,
  createBrokerFromEnv,
  type BrokerFromEnvResult,
} from '@signalman/broker';
import {
  InMemoryDivergenceFindingRepository,
  type DivergenceFindingRepository,
} from './finding-repository';
import { ReconcilerService } from './reconciler.service';
import { ReconciliationScheduler } from './scheduler';
import { type SourceOfTruthGateway } from './source-gateway';
import {
  BrokerSourceOfTruthGateway,
  DEFAULT_SETTLE_GRACE_MS,
  SOURCE_EVENT_SUBJECTS,
  sourceEventHandler,
} from './broker-source-gateway';

/** DI token for the {@link SourceOfTruthGateway} the reconciler reads settled bookings from. */
export const SOURCE_OF_TRUTH_GATEWAY = Symbol('SOURCE_OF_TRUTH_GATEWAY');

/** DI token for the {@link DivergenceFindingRepository} the reconciler records findings in. */
export const FINDING_REPOSITORY = Symbol('FINDING_REPOSITORY');

/** DI token for the {@link BrokerFromEnvResult} the subscription host consumes from. */
export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

/** Read a positive integer from the environment, falling back when unset or invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

@Module({
  providers: [
    {
      provide: MESSAGE_BROKER,
      useFactory: (): Promise<BrokerFromEnvResult> => createBrokerFromEnv(),
    },
    {
      provide: SOURCE_OF_TRUTH_GATEWAY,
      useFactory: (): BrokerSourceOfTruthGateway =>
        new BrokerSourceOfTruthGateway({
          settleGraceMs: envInt('RECONCILER_SETTLE_GRACE_MS', DEFAULT_SETTLE_GRACE_MS),
        }),
    },
    {
      provide: BrokerSubscriptionHost,
      useFactory: (
        gateway: BrokerSourceOfTruthGateway,
        brokerResult: BrokerFromEnvResult,
      ): BrokerSubscriptionHost =>
        new BrokerSubscriptionHost({
          broker: brokerResult.broker,
          subscriptions: [
            {
              subjects: [...SOURCE_EVENT_SUBJECTS],
              handler: sourceEventHandler(gateway),
            },
          ],
          close: brokerResult.close,
        }),
      inject: [SOURCE_OF_TRUTH_GATEWAY, MESSAGE_BROKER],
    },
    {
      provide: FINDING_REPOSITORY,
      useFactory: (): DivergenceFindingRepository => new InMemoryDivergenceFindingRepository(),
    },
    {
      provide: ReconcilerService,
      useFactory: (gateway: SourceOfTruthGateway, findings: DivergenceFindingRepository): ReconcilerService =>
        new ReconcilerService({ gateway, findings }),
      inject: [SOURCE_OF_TRUTH_GATEWAY, FINDING_REPOSITORY],
    },
    {
      provide: ReconciliationScheduler,
      useFactory: (service: ReconcilerService): ReconciliationScheduler =>
        new ReconciliationScheduler({
          service,
          intervalMs: envInt('RECONCILER_INTERVAL_MS', 30_000),
        }),
      inject: [ReconcilerService],
    },
  ],
  exports: [ReconciliationScheduler, ReconcilerService, BrokerSubscriptionHost],
})
export class ReconcilerModule {}
