/**
 * Wiring for the inventory leg of the saga.
 *
 * It binds the gRPC {@link InventoryController} to an {@link InventoryService}
 * backed by the configured hold repository and outbox store, and runs an
 * {@link OutboxRelayHost} that drains the staged `inventory.held`/`.released`
 * events onto the configured broker. The broker is chosen from the environment
 * ({@link createBrokerFromEnv} — in-memory by default, NATS when `BROKER=nats`),
 * so the same wiring serves the unit suite and the docker-compose stack.
 *
 * **Datastore selection** — driven by `POSTGRES_URL`:
 * - When set, a `Pool` connects to Postgres and the service uses
 *   {@link PostgresHoldRepository} and {@link PostgresOutboxStore} backed by
 *   the `inventory` schema. The tables are created (if absent) on bootstrap.
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
import { PostgresHoldRepository } from './pg-hold-repository';
import { InMemoryHoldRepository, type HoldRepository } from './hold-repository';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/** DI token for the {@link HoldRepository} the service persists holds through. */
export const HOLD_REPOSITORY = Symbol('HOLD_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/** DI token for the {@link BrokerFromEnvResult} the relay publishes onto. */
export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

/**
 * Demo availability catalogue. Real deployments seed this from the inventory
 * datastore; a fixed catalogue keeps the service self-contained in in-memory
 * mode (when `POSTGRES_URL` is not set).
 */
const DEMO_STOCK: Record<string, number> = {
  'seat-economy': 100,
  'seat-business': 20,
  'room-standard': 50,
};

/** Returns the transaction runner to inject into {@link InventoryService}. */
function makeTransact(
  pool: Pool | undefined,
): (<T>(work: (tx: UnitOfWork) => Promise<T>) => Promise<T>) | undefined {
  if (!pool) return undefined;
  return <T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> =>
    runInPgTransaction(pool, (pgTx) => work(pgTx));
}

@Module({
  controllers: [InventoryController],
  providers: [
    {
      provide: HOLD_REPOSITORY,
      useFactory: async (): Promise<HoldRepository> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const repo = new PostgresHoldRepository(pool, 'inventory');
          await repo.ensureSchema(DEMO_STOCK);
          return repo;
        }
        return new InMemoryHoldRepository({ stock: { ...DEMO_STOCK } });
      },
    },
    {
      provide: OUTBOX_STORE,
      useFactory: async (): Promise<OutboxStore> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const store = new PostgresOutboxStore(pool, 'inventory');
          await store.ensureSchema();
          return store;
        }
        return new InMemoryOutboxStore();
      },
    },
    {
      provide: InventoryService,
      useFactory: (holds: HoldRepository, outbox: OutboxStore): InventoryService => {
        const url = process.env.POSTGRES_URL;
        const pool = url ? new Pool({ connectionString: url }) : undefined;
        return new InventoryService({ holds, outbox, transact: makeTransact(pool) });
      },
      inject: [HOLD_REPOSITORY, OUTBOX_STORE],
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
export class InventoryModule {}
