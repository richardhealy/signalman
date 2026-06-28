/**
 * Wiring for the ledger leg of the saga.
 *
 * It binds the gRPC {@link LedgerController} to a {@link LedgerService} backed by
 * the in-memory ledger repository and outbox store. Those in-memory stores are
 * the reference implementations the `@signalman/*` libraries ship; the
 * Postgres-backed stores (and the outbox relay that drains staged events to the
 * broker) land with the datastore and broker milestones, swapped in here behind
 * the same {@link LEDGER_REPOSITORY}/{@link OUTBOX_STORE} tokens.
 */
import { Module } from '@nestjs/common';
import { InMemoryOutboxStore, type OutboxStore } from '@signalman/outbox';
import { InMemoryLedgerRepository, type LedgerRepository } from './entry-repository';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';

/** DI token for the {@link LedgerRepository} the service persists entries through. */
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

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
  ],
})
export class LedgerModule {}
