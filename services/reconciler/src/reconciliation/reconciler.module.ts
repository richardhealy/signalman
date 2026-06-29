/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} that drives a {@link ReconcilerService}
 * over a {@link BrokerSourceOfTruthGateway} that subscribes to
 * `inventory.*`/`supplier.*`/`ledger.*` via a {@link BrokerSubscriptionHost} and
 * builds per-booking cross-source projections in real time. The broker is chosen
 * from the environment ({@link createBrokerFromEnv}): in-memory for tests and the
 * single-process demo, NATS JetStream when `BROKER=nats`. The interval and settle-grace
 * window are read from the environment so the demo can tune reconciliation aggressiveness
 * without code changes. The in-memory {@link InMemoryDivergenceFindingRepository}
 * holds findings for now; a Postgres-backed store swaps in behind the same
 * {@link FINDING_REPOSITORY} token with the datastore milestone.
 */
import { Module } from '@nestjs/common';
import {
  BrokerSubscriptionHost,
  createBrokerFromEnv,
  type BrokerFromEnvResult,
} from '@signalman/broker';
import {
  BrokerSourceOfTruthGateway,
  type BrokerSourceOfTruthGatewayOptions,
} from './broker-source-gateway';
import {
  InMemoryDivergenceFindingRepository,
  type DivergenceFindingRepository,
} from './finding-repository';
import { ReconcilerService } from './reconciler.service';
import { ReconciliationScheduler } from './scheduler';
import { type SourceOfTruthGateway } from './source-gateway';

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
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

@Module({
  providers: [
    { provide: MESSAGE_BROKER, useFactory: (): Promise<BrokerFromEnvResult> => createBrokerFromEnv() },
    {
      provide: SOURCE_OF_TRUTH_GATEWAY,
      useFactory: (): BrokerSourceOfTruthGateway => {
        const options: BrokerSourceOfTruthGatewayOptions = {
          settleGraceMs: envInt('RECONCILER_SETTLE_GRACE_MS', 5_000),
        };
        return new BrokerSourceOfTruthGateway(options);
      },
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
  exports: [ReconciliationScheduler, ReconcilerService],
})
export class ReconcilerModule {}
