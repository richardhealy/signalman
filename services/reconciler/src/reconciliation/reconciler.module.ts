/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} that drives a {@link ReconcilerService}
 * over a {@link BrokerSourceOfTruthGateway} and an in-memory
 * {@link DivergenceFindingRepository}. The gateway subscribes to
 * `inventory.*`, `supplier.*`, and `ledger.*` on the configured broker (in-memory
 * reference by default, NATS JetStream when `BROKER=nats`), builds per-booking
 * projections from arriving events, and applies a settle-grace window so the
 * reconciler never compares a mid-saga booking. A {@link BrokerSubscriptionHost}
 * owns the subscribe/unsubscribe lifecycle and is registered as a provider so
 * NestJS drives its `onApplicationBootstrap`/`onApplicationShutdown` hooks.
 *
 * Configurable via environment variables:
 * - `RECONCILER_INTERVAL_MS` — how often to run a reconciliation pass (default 30 s).
 * - `RECONCILER_SETTLE_GRACE_MS` — how long after the last source event a booking
 *   must be idle before it is considered settled (default 10 s).
 * - `BROKER` / `NATS_URL` — broker transport selection (see `createBrokerFromEnv`).
 */
import { Module } from '@nestjs/common';
import {
  BrokerSubscriptionHost,
  createBrokerFromEnv,
  type BrokerFromEnvResult,
} from '@signalman/broker';
import { BrokerSourceOfTruthGateway } from './broker-source-gateway';
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

/** DI token for the broker transport the gateway subscribes through. */
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
          settleGraceMs: envInt('RECONCILER_SETTLE_GRACE_MS', 10_000),
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
