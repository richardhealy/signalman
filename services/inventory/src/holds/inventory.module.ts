/**
 * Wiring for the inventory leg of the saga.
 *
 * It binds the gRPC {@link InventoryController} to an {@link InventoryService}
 * backed by the in-memory hold repository and outbox store. Those in-memory
 * stores are the reference implementations the `@signalman/*` libraries ship;
 * the Postgres-backed stores (and the outbox relay that drains staged events to
 * the broker) land with the datastore and broker milestones, swapped in here
 * behind the same {@link HOLD_REPOSITORY}/{@link OUTBOX_STORE} tokens.
 */
import { Module } from '@nestjs/common';
import { InMemoryOutboxStore, type OutboxStore } from '@signalman/outbox';
import { InMemoryHoldRepository, type HoldRepository } from './hold-repository';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/** DI token for the {@link HoldRepository} the service persists holds through. */
export const HOLD_REPOSITORY = Symbol('HOLD_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/**
 * Demo availability catalogue. Real deployments seed this from the inventory
 * datastore; a fixed catalogue keeps the service self-contained until then.
 */
const DEMO_STOCK: Record<string, number> = {
  'seat-economy': 100,
  'seat-business': 20,
  'room-standard': 50,
};

@Module({
  controllers: [InventoryController],
  providers: [
    {
      provide: HOLD_REPOSITORY,
      useFactory: (): HoldRepository => new InMemoryHoldRepository({ stock: { ...DEMO_STOCK } }),
    },
    { provide: OUTBOX_STORE, useFactory: (): OutboxStore => new InMemoryOutboxStore() },
    {
      provide: InventoryService,
      useFactory: (holds: HoldRepository, outbox: OutboxStore): InventoryService =>
        new InventoryService({ holds, outbox }),
      inject: [HOLD_REPOSITORY, OUTBOX_STORE],
    },
  ],
})
export class InventoryModule {}
