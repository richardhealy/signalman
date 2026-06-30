/**
 * Wiring for the supplier leg of the saga.
 *
 * It binds the gRPC {@link SupplierController} to a {@link SupplierService}
 * backed by the configured confirmation repository and outbox store, calling a
 * {@link SimulatedSupplierPartner} for the external boundary, and runs an
 * {@link OutboxRelayHost} that drains the staged
 * `supplier.confirmed`/`.cancelled` events onto the configured broker. The broker
 * is chosen from the environment ({@link createBrokerFromEnv} — in-memory by
 * default, NATS when `BROKER=nats`), so the same wiring serves the unit suite and
 * the docker-compose stack.
 *
 * **Datastore selection** — driven by `POSTGRES_URL`:
 * - When set, a `Pool` connects to Postgres and the service uses
 *   {@link PostgresConfirmationRepository} and {@link PostgresOutboxStore} backed
 *   by the `supplier` schema. The tables are created (if absent) on bootstrap.
 * - When absent, the in-memory reference stores stand in, keeping the unit
 *   suite and a single-process demo free of any infrastructure dependency.
 *
 * The partner's latency and failure rates are read from the environment so the
 * demo can dial divergence up or down without code changes; the defaults inject
 * more slowness and flakiness than the PSP, matching the spec's "deliberately
 * slow and flaky" external partner — the hop most likely to drive divergence.
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
import {
  InMemoryConfirmationRepository,
  type ConfirmationRepository,
} from './confirmation-repository';
import { PostgresConfirmationRepository } from './pg-confirmation-repository';
import { SimulatedSupplierPartner, type SupplierPartner } from './partner';
import { SupplierController } from './supplier.controller';
import { SupplierService } from './supplier.service';

/** DI token for the {@link ConfirmationRepository} the service persists confirmations through. */
export const CONFIRMATION_REPOSITORY = Symbol('CONFIRMATION_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/** DI token for the {@link SupplierPartner} boundary the service confirms/cancels through. */
export const SUPPLIER_PARTNER = Symbol('SUPPLIER_PARTNER');

/** DI token for the {@link BrokerFromEnvResult} the relay publishes onto. */
export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

/** Read a 0–1 rate (or any number) from the environment, falling back when unset or invalid. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Returns the transaction runner to inject into {@link SupplierService}. */
function makeTransact(
  pool: Pool | undefined,
): (<T>(work: (tx: UnitOfWork) => Promise<T>) => Promise<T>) | undefined {
  if (!pool) return undefined;
  return <T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> =>
    runInPgTransaction(pool, (pgTx) => work(pgTx));
}

@Module({
  controllers: [SupplierController],
  providers: [
    {
      provide: CONFIRMATION_REPOSITORY,
      useFactory: async (): Promise<ConfirmationRepository> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const repo = new PostgresConfirmationRepository(pool, 'supplier');
          await repo.ensureSchema();
          return repo;
        }
        return new InMemoryConfirmationRepository();
      },
    },
    {
      provide: OUTBOX_STORE,
      useFactory: async (): Promise<OutboxStore> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const store = new PostgresOutboxStore(pool, 'supplier');
          await store.ensureSchema();
          return store;
        }
        return new InMemoryOutboxStore();
      },
    },
    {
      provide: SUPPLIER_PARTNER,
      useFactory: (): SupplierPartner =>
        new SimulatedSupplierPartner({
          latencyMs: envNumber('SUPPLIER_LATENCY_MS', 250),
          rejectRate: envNumber('SUPPLIER_REJECT_RATE', 0.1),
          failureRate: envNumber('SUPPLIER_FAILURE_RATE', 0.1),
        }),
    },
    {
      provide: SupplierService,
      useFactory: (
        confirmations: ConfirmationRepository,
        outbox: OutboxStore,
        partner: SupplierPartner,
      ): SupplierService => {
        const url = process.env.POSTGRES_URL;
        const pool = url ? new Pool({ connectionString: url }) : undefined;
        return new SupplierService({ confirmations, outbox, partner, transact: makeTransact(pool) });
      },
      inject: [CONFIRMATION_REPOSITORY, OUTBOX_STORE, SUPPLIER_PARTNER],
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
export class SupplierModule {}
