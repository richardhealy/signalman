/**
 * Wiring for the payments leg of the saga.
 *
 * It binds the gRPC {@link PaymentsController} to a {@link PaymentsService}
 * backed by the configured payment repository and outbox store, calling a
 * {@link SimulatedPsp} for the external boundary, and runs an
 * {@link OutboxRelayHost} that drains the staged
 * `payment.authorized`/`.captured`/`.voided` events onto the configured broker.
 * The broker is chosen from the environment ({@link createBrokerFromEnv} —
 * in-memory by default, NATS when `BROKER=nats`), so the same wiring serves the
 * unit suite and the docker-compose stack.
 *
 * **Datastore selection** — driven by `POSTGRES_URL`:
 * - When set, a `Pool` connects to Postgres and the service uses
 *   {@link PostgresPaymentRepository} and {@link PostgresOutboxStore} backed by
 *   the `payments` schema. The tables are created (if absent) on bootstrap.
 * - When absent, the in-memory reference stores stand in, keeping the unit
 *   suite and a single-process demo free of any infrastructure dependency.
 *
 * The PSP's latency and failure rates are read from the environment so the demo
 * can dial divergence up or down without code changes; the defaults inject
 * enough slowness and flakiness to make the external hop interesting in a trace.
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
import { InMemoryPaymentRepository, type PaymentRepository } from './payment-repository';
import { PostgresPaymentRepository } from './pg-payment-repository';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SimulatedPsp, type Psp } from './psp';

/** DI token for the {@link PaymentRepository} the service persists payments through. */
export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/** DI token for the {@link Psp} boundary the service authorizes/captures through. */
export const PSP = Symbol('PSP');

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

/** Returns the transaction runner to inject into {@link PaymentsService}. */
function makeTransact(
  pool: Pool | undefined,
): (<T>(work: (tx: UnitOfWork) => Promise<T>) => Promise<T>) | undefined {
  if (!pool) return undefined;
  return <T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> =>
    runInPgTransaction(pool, (pgTx) => work(pgTx));
}

@Module({
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENT_REPOSITORY,
      useFactory: async (): Promise<PaymentRepository> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const repo = new PostgresPaymentRepository(pool, 'payments');
          await repo.ensureSchema();
          return repo;
        }
        return new InMemoryPaymentRepository();
      },
    },
    {
      provide: OUTBOX_STORE,
      useFactory: async (): Promise<OutboxStore> => {
        const url = process.env.POSTGRES_URL;
        if (url) {
          const pool = new Pool({ connectionString: url });
          const store = new PostgresOutboxStore(pool, 'payments');
          await store.ensureSchema();
          return store;
        }
        return new InMemoryOutboxStore();
      },
    },
    {
      provide: PSP,
      useFactory: (): Psp =>
        new SimulatedPsp({
          latencyMs: envNumber('PSP_LATENCY_MS', 150),
          declineRate: envNumber('PSP_DECLINE_RATE', 0.1),
          failureRate: envNumber('PSP_FAILURE_RATE', 0.05),
        }),
    },
    {
      provide: PaymentsService,
      useFactory: (payments: PaymentRepository, outbox: OutboxStore, psp: Psp): PaymentsService => {
        const url = process.env.POSTGRES_URL;
        const pool = url ? new Pool({ connectionString: url }) : undefined;
        return new PaymentsService({ payments, outbox, psp, transact: makeTransact(pool) });
      },
      inject: [PAYMENT_REPOSITORY, OUTBOX_STORE, PSP],
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
export class PaymentsModule {}
