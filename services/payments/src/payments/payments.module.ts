/**
 * Wiring for the payments leg of the saga.
 *
 * It binds the gRPC {@link PaymentsController} to a {@link PaymentsService}
 * backed by the in-memory payment repository and outbox store, calling a
 * {@link SimulatedPsp} for the external boundary. The in-memory stores are the
 * reference implementations the `@signalman/*` libraries ship; the
 * Postgres-backed stores (and the outbox relay that drains staged events to the
 * broker) land with the datastore and broker milestones, swapped in here behind
 * the same {@link PAYMENT_REPOSITORY}/{@link OUTBOX_STORE} tokens.
 *
 * The PSP's latency and failure rates are read from the environment so the demo
 * can dial divergence up or down without code changes; the defaults inject
 * enough slowness and flakiness to make the external hop interesting in a trace.
 */
import { Module } from '@nestjs/common';
import { InMemoryOutboxStore, type OutboxStore } from '@signalman/outbox';
import { InMemoryPaymentRepository, type PaymentRepository } from './payment-repository';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SimulatedPsp, type Psp } from './psp';

/** DI token for the {@link PaymentRepository} the service persists payments through. */
export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

/** DI token for the {@link OutboxStore} the service stages events into. */
export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

/** DI token for the {@link Psp} boundary the service authorizes/captures through. */
export const PSP = Symbol('PSP');

/** Read a 0–1 rate (or any number) from the environment, falling back when unset or invalid. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

@Module({
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENT_REPOSITORY,
      useFactory: (): PaymentRepository => new InMemoryPaymentRepository(),
    },
    { provide: OUTBOX_STORE, useFactory: (): OutboxStore => new InMemoryOutboxStore() },
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
      useFactory: (payments: PaymentRepository, outbox: OutboxStore, psp: Psp): PaymentsService =>
        new PaymentsService({ payments, outbox, psp }),
      inject: [PAYMENT_REPOSITORY, OUTBOX_STORE, PSP],
    },
  ],
})
export class PaymentsModule {}
