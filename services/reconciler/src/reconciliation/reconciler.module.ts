/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} that drives a {@link ReconcilerService}
 * over a {@link BrokerSourceOfTruthGateway} and the in-memory
 * {@link InMemoryDivergenceFindingRepository}, and runs a
 * {@link BrokerSubscriptionHost} that subscribes the gateway's event handler to
 * `inventory.*`, `supplier.*`, and `ledger.*` off the configured broker.
 *
 * The broker is chosen from the environment ({@link createBrokerFromEnv} — in-memory
 * by default, NATS when `BROKER=nats`), so the same wiring serves the unit suite and
 * the docker-compose stack. The settle-grace window is read from
 * `RECONCILER_SETTLE_GRACE_MS` (default 5 s) so a demo with a short interval can also
 * shorten the settle wait. The reconciler interval is read from
 * `RECONCILER_INTERVAL_MS` (default 30 s).
 *
 * The {@link InMemoryDivergenceFindingRepository} is the reference implementation
 * until the Postgres-backed store lands, swapped in behind the same
 * {@link FINDING_REPOSITORY} token.
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
import { BrokerSourceOfTruthGateway } from './broker-gateway';
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
    // The broker-backed gateway is registered as its own concrete class so the
    // subscription host can inject it directly (to call .handler()) while the
    // reconciler service depends on the SOURCE_OF_TRUTH_GATEWAY interface token.
    {
      provide: BrokerSourceOfTruthGateway,
      useFactory: (): BrokerSourceOfTruthGateway =>
        new BrokerSourceOfTruthGateway({
          settleGraceMs: envInt('RECONCILER_SETTLE_GRACE_MS', 5_000),
        }),
    },
    {
      provide: SOURCE_OF_TRUTH_GATEWAY,
      useFactory: (g: BrokerSourceOfTruthGateway): SourceOfTruthGateway => g,
      inject: [BrokerSourceOfTruthGateway],
    },
    {
      provide: FINDING_REPOSITORY,
      useFactory: (): DivergenceFindingRepository => new InMemoryDivergenceFindingRepository(),
    },
    { provide: MESSAGE_BROKER, useFactory: (): Promise<BrokerFromEnvResult> => createBrokerFromEnv() },
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
              handler: gateway.handler(),
            },
          ],
          close: broker.close,
        }),
      inject: [BrokerSourceOfTruthGateway, MESSAGE_BROKER],
    },
    {
      provide: ReconcilerService,
      useFactory: (
        gateway: SourceOfTruthGateway,
        findings: DivergenceFindingRepository,
      ): ReconcilerService => new ReconcilerService({ gateway, findings }),
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
