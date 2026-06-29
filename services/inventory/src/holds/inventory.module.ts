/**
 * Wiring for the inventory leg of the saga.
 *
 * It binds the gRPC {@link InventoryController} to an {@link InventoryService}
 * backed by the in-memory hold repository and outbox store, and runs an
 * {@link OutboxRelayHost} that drains the staged `inventory.held`/`.released`
 * events onto the configured broker. The broker is chosen from the environment
 * ({@link createBrokerFromEnv} — in-memory by default, NATS when `BROKER=nats`),
 * so the same wiring serves the unit suite and the docker-compose stack. The
 * in-memory stores are the reference implementations the `@signalman/*` libraries
 * ship; the Postgres-backed stores swap in here behind the same
 * {@link HOLD_REPOSITORY}/{@link OUTBOX_STORE} tokens with the datastore milestone.
 */
import { Module } from '@nestjs/common';
import {
  createBrokerFromEnv,
  OutboxRelayHost,
  type BrokerFromEnvResult,
} from '@signalman/broker';
import { InMemoryOutboxStore, type OutboxStore } from '@signalman/outbox';
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
