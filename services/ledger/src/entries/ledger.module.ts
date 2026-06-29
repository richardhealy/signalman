/**
 * Wiring for the ledger leg of the saga.
 *
 * It binds the gRPC {@link LedgerController} to a {@link LedgerService} backed by
 * the in-memory ledger repository and outbox store, and runs an
 * {@link OutboxRelayHost} that drains the staged `ledger.committed`/`.reversed`
 * events onto the configured broker. The broker is chosen from the environment
 * ({@link createBrokerFromEnv} — in-memory by default, NATS when `BROKER=nats`),
 * so the same wiring serves the unit suite and the docker-compose stack. The
 * in-memory stores are the reference implementations the `@signalman/*` libraries
 * ship; the Postgres-backed stores swap in here behind the same
 * {@link LEDGER_REPOSITORY}/{@link OUTBOX_STORE} tokens with the datastore milestone.
 */
import { Module } from '@nestjs/common';
import {
  createBrokerFromEnv,
  OutboxRelayHost,
  type BrokerFromEnvResult,
} from '@signalman/broker';
import { InMemoryOutboxStore, type OutboxStore } from '@signalman/outbox';
import { InMemoryLedgerRepository, type LedgerRepository } from './entry-repository';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

/** DI token for the {@link LedgerRepository} the service persists entries through. */
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/** DI token for the {@link BrokerFromEnvResult} the relay publishes onto. */
export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

@Module({
  controllers: [LedgerController],
  providers: [
    {
      provide: LEDGER_REPOSITORY,
      useFactory: (): LedgerRepository => new InMemoryLedgerRepository(),
    },
    { provide: OUTBOX_STORE, useFactory: (): OutboxStore => new InMemoryOutboxStore() },
    {
      provide: LedgerService,
      useFactory: (entries: LedgerRepository, outbox: OutboxStore): LedgerService =>
        new LedgerService({ entries, outbox }),
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
