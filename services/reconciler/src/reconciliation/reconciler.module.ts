/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} driving a {@link ReconcilerService},
 * backed by a {@link BrokerSourceOfTruthGateway} that subscribes to
 * `inventory.*`, `supplier.*`, and `ledger.*` events and builds a per-booking
 * projection from them. A {@link BrokerSubscriptionHost} establishes those
 * subscriptions when the application boots and tears them down on shutdown — the
 * broker is chosen by {@link createBrokerFromEnv} (in-memory reference by
 * default, NATS JetStream when `BROKER=nats`), so a single env var switches
 * between a self-contained unit run and the full docker-compose demo.
 *
 * A settle-grace window ({@link RECONCILER_SETTLE_GRACE_MS}) prevents the
 * reconciler from mistaking an in-flight booking for a divergence: only bookings
 * whose last event arrived more than that many milliseconds ago are passed to the
 * comparison engine.
 *
 * The {@link InMemoryDivergenceFindingRepository} is the reference findings store;
 * a Postgres-backed store swaps in behind the {@link FINDING_REPOSITORY} token
 * with the datastore milestone.
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
      useFactory: (): SourceOfTruthGateway =>
        new BrokerSourceOfTruthGateway({
          settleGraceMs: envInt('RECONCILER_SETTLE_GRACE_MS', 5_000),
        }),
    },
    {
      provide: BrokerSubscriptionHost,
      useFactory: (
        gateway: BrokerSourceOfTruthGateway,
        broker: BrokerFromEnvResult,
      ): BrokerSubscriptionHost =>
        new BrokerSubscriptionHost({
          broker: broker.broker,
          subscriptions: [
            {
              subjects: ['inventory.*', 'supplier.*', 'ledger.*'],
              handler: async (message) => gateway.handleMessage(message),
            },
          ],
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
