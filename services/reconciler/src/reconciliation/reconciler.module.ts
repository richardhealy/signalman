/**
 * Wiring for the reconciler — the periodic comparison of the sources of truth.
 *
 * It binds a {@link ReconciliationScheduler} that drives a {@link ReconcilerService}
 * over the in-memory {@link SourceOfTruthGateway} and {@link DivergenceFindingRepository}
 * reference implementations. The interval is read from the environment so the demo
 * can reconcile more or less aggressively without code changes. The
 * broker/Postgres-backed gateway and findings store land with the datastore and
 * broker milestones, swapped in behind the same {@link SOURCE_OF_TRUTH_GATEWAY} and
 * {@link FINDING_REPOSITORY} tokens.
 */
import { Module } from '@nestjs/common';
import {
  InMemoryDivergenceFindingRepository,
  type DivergenceFindingRepository,
} from './finding-repository';
import { ReconcilerService } from './reconciler.service';
import { ReconciliationScheduler } from './scheduler';
import { InMemorySourceOfTruthGateway, type SourceOfTruthGateway } from './source-gateway';

/** DI token for the {@link SourceOfTruthGateway} the reconciler reads settled bookings from. */
export const SOURCE_OF_TRUTH_GATEWAY = Symbol('SOURCE_OF_TRUTH_GATEWAY');

/** DI token for the {@link DivergenceFindingRepository} the reconciler records findings in. */
export const FINDING_REPOSITORY = Symbol('FINDING_REPOSITORY');

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
      provide: SOURCE_OF_TRUTH_GATEWAY,
      useFactory: (): SourceOfTruthGateway => new InMemorySourceOfTruthGateway(),
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
