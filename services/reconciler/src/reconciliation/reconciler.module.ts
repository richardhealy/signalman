/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} that drives a {@link ReconcilerService}
 * over a {@link BrokerSourceOfTruthGateway} that projects real domain events from
 * the broker into per-booking snapshots. The gateway subscribes to `inventory.*`,
 * `supplier.*`, and `ledger.*` via a {@link BrokerSubscriptionHost}, so a running
 * reconciler compares the actual state each service reports rather than an empty
 * in-memory store. The broker transport is chosen from the environment
 * ({@link createBrokerFromEnv} — in-memory by default, NATS when `BROKER=nats`),
 * mirroring how the producing legs and the notifier select their transport.
 *
 * Intervals and settle grace are read from the environment so the demo can tune
 * reconciliation cadence without code changes. The Postgres-backed
 * {@link DivergenceFindingRepository} lands behind the same {@link FINDING_REPOSITORY}
 * token with the datastore milestone.
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
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';
import { ReconcilerService } from './reconciler.service';
import { ReconciliationScheduler } from './scheduler';
import { type SourceOfTruthGateway } from './source-gateway';

/** DI token for the {@link SourceOfTruthGateway} the reconciler reads settled bookings from. */
export const SOURCE_OF_TRUTH_GATEWAY = Symbol('SOURCE_OF_TRUTH_GATEWAY');

/** DI token for the {@link DivergenceFindingRepository} the reconciler records findings in. */
export const FINDING_REPOSITORY = Symbol('FINDING_REPOSITORY');

/** DI token for the {@link BrokerFromEnvResult} the subscription host consumes from. */
const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

/** DI token for the concrete {@link BrokerSourceOfTruthGateway} instance (for lifecycle wiring). */
const BROKER_GATEWAY = Symbol('BROKER_GATEWAY');

/** Read a positive integer from the environment, falling back when unset or invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

@Module({
  providers: [
    {
      provide: MESSAGE_BROKER,
      useFactory: (): Promise<BrokerFromEnvResult> => createBrokerFromEnv(),
    },
    {
      provide: BROKER_GATEWAY,
      useFactory: (): BrokerSourceOfTruthGateway =>
        new BrokerSourceOfTruthGateway({
          settleGraceMs: envInt('RECONCILER_SETTLE_GRACE_MS', 30_000),
        }),
    },
    {
      provide: SOURCE_OF_TRUTH_GATEWAY,
      useFactory: (g: BrokerSourceOfTruthGateway): SourceOfTruthGateway => g,
      inject: [BROKER_GATEWAY],
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
    {
      provide: BrokerSubscriptionHost,
      useFactory: (
        gateway: BrokerSourceOfTruthGateway,
        broker: BrokerFromEnvResult,
      ): BrokerSubscriptionHost =>
        new BrokerSubscriptionHost({
          broker: broker.broker,
          subscriptions: gateway.subscriptions(),
          close: broker.close,
        }),
      inject: [BROKER_GATEWAY, MESSAGE_BROKER],
    },
  ],
  exports: [ReconciliationScheduler, ReconcilerService],
})
export class ReconcilerModule {}
