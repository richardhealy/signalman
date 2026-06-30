/**
 * Wiring for the ledger leg of the saga.
 *
 * It binds the gRPC {@link LedgerController} to a {@link LedgerService} backed by
 * the configured ledger repository and outbox store, and runs an
 * {@link OutboxRelayHost} that drains the staged `ledger.committed`/`.reversed`
 * events onto the configured broker. The broker is chosen from the environment
 * ({@link createBrokerFromEnv} — in-memory by default, NATS when `BROKER=nats`),
 * so the same wiring serves the unit suite and the docker-compose stack.
 *
 * **Datastore selection** — driven by `POSTGRES_URL`:
 * - When set, a `Pool` connects to Postgres and the service uses
 *   {@link PostgresLedgerRepository} and {@link PostgresOutboxStore} backed by
 *   the `ledger` schema. The tables are created (if absent) on bootstrap.
 * - When absent, the in-memory reference stores stand in, keeping the unit
 *   suite and a single-process demo free of any infrastructure dependency.
 */
import { Module } from '@nestjs/common';
import {
  createBrokerFromEnv,
  OutboxRelayHost,
  type BrokerFromEnvResult,
} from '@signalman/broker';
import {
  InMemoryOutboxStore,
  PostgresOutboxStore,
  runInPgTransaction,
  type OutboxStore,
  type UnitOfWork,
} from '@signalman/outbox';
import { Pool } from 'pg';
import { PostgresLedgerRepository } from './pg-entry-repository';
import { InMemoryLedgerRepository, type LedgerRepository } from './entry-repository';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

/** DI token for the {@link LedgerRepository} the service persists entries through. */
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/** DI token for the {@link BrokerFromEnvResult} the relay publishes onto. */
export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

/** Returns the transaction runner to inject into {@link LedgerService}. */
function makeTransact(
  pool: Pool | undefined,
): (<T>(work: (tx: UnitOfWork) => Promise<T>) => Promise<T>) | undefined {
  if (!pool) return undefined;
  return <T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> =>
    runInPgTransaction(pool, (pgTx) => work(pgTx));
}

@Module({
  controllers: [LedgerController],
  providers: [
    {
      provide: LEDGER_REPOSITORY,
      useFactory: async (): Promise<LedgerRepository> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const repo = new PostgresLedgerRepository(pool, 'ledger');
          await repo.ensureSchema();
          return repo;
        }
        return new InMemoryLedgerRepository();
      },
    },
    {
      provide: OUTBOX_STORE,
      useFactory: async (): Promise<OutboxStore> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const store = new PostgresOutboxStore(pool, 'ledger');
          await store.ensureSchema();
          return store;
        }
        return new InMemoryOutboxStore();
      },
    },
    {
      provide: LedgerService,
      useFactory: (entries: LedgerRepository, outbox: OutboxStore): LedgerService => {
        const url = process.env.POSTGRES_URL;
        const pool = url ? new Pool({ connectionString: url }) : undefined;
        return new LedgerService({ entries, outbox, transact: makeTransact(pool) });
      },
      inject: [LEDGER_REPOSITORY, OUTBOX_STORE],
    },
    { provide: MESSAGE_BROKER, useFactory: (): Promise<BrokerFromEnvResult> => createBrokerFromEnv() },
    {
      provide: OutboxRelayHost,
      useFactory: (outbox: OutboxStore, broker: BrokerFromEnvResult): OutboxRelayHost =>
        new OutboxRelayHost({
          store: outbox,
          broker: broker.broker,
          messagingSystem: broker.kind,
          close: broker.close,
        }),
      inject: [OUTBOX_STORE, MESSAGE_BROKER],
    },
  ],
})
export class LedgerModule {}
