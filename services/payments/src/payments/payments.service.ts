/**
 * The payments application service — the money leg of the booking saga.
 *
 * It authorizes, captures, and voids payments, each operation pairing a state
 * change with an outbox event so the rest of the system learns what happened
 * without the dual-write problem. The properties that make it saga-safe mirror
 * the inventory leg:
 *
 * - **Idempotent authorization.** A booking holds at most one live payment; a
 *   retried `authorize` returns the standing authorization rather than charging
 *   the PSP twice. The coordinator (and broker redeliveries) can retry freely.
 * - **Idempotent capture.** A retried `capture` returns the standing capture.
 * - **Idempotent compensation.** `voidAuthorization` is a no-op once the
 *   authorization is already voided (or was never obtained), so the compensation
 *   can fire more than once without double-voiding.
 *
 * It draws a sharp line between a PSP **decline** (a business "no", returned as
 * data with a reason and changing no state) and a PSP **outage** (a thrown
 * {@link PspUnavailableError}, propagated so the gRPC handler's SERVER span is
 * marked errored and the coordinator can retry the external hop).
 *
 * The PSP call is the one side effect that cannot roll back, so it runs **before**
 * the transaction; once it returns, the `commit` and the outbox `add` it
 * accompanies run in **one** transaction — `runInTransaction` threads a unit of
 * work through the payment write and the outbox staging so they commit together
 * (or not at all), defeating the dual-write problem. The in-memory collaborators
 * model that atomic commit; a Postgres-backed store swaps in behind the same
 * tokens and gets it from a real database transaction.
 */
import { createOutboxRecord, runInTransaction, type OutboxStore } from '@signalman/outbox';
import { randomUUID } from 'node:crypto';
import { type Payment, type PaymentStatus } from './payment';
import { type PaymentRepository } from './payment-repository';
import { type Psp } from './psp';

/** A request to authorize funds for a booking. */
export interface AuthorizeCommand {
  bookingId: string;
  /** Amount in the currency's minor units (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
}

/** A request to capture a booking's authorized payment. */
export interface CaptureCommand {
  bookingId: string;
}

/** A request to void a booking's authorization (the compensation). */
export interface VoidCommand {
  bookingId: string;
}

/**
 * The outcome of {@link PaymentsService.authorize}. A discriminated union so
 * callers branch on `authorized` and a decline always carries a machine-readable
 * `reason`.
 */
export type AuthorizeOutcome =
  | { authorized: true; paymentId: string; authorizationId: string; status: PaymentStatus }
  | { authorized: false; reason: string };

/**
 * The outcome of {@link PaymentsService.capture}. A capture that cannot proceed
 * (no authorization, or one already voided) carries a `reason`.
 */
export type CaptureOutcome =
  | { captured: true; paymentId: string; captureId: string }
  | { captured: false; reason: string };

/** The outcome of {@link PaymentsService.voidAuthorization}. */
export interface VoidOutcome {
  voided: boolean;
  /** The voided payment's id, or `''` when there was nothing to void. */
  paymentId: string;
}

/** Injectable collaborators and seams for {@link PaymentsService}. */
export interface PaymentsServiceOptions {
  payments: PaymentRepository;
  outbox: OutboxStore;
  psp: Psp;
  /** Payment-id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for payment timestamps; defaults to `() => new Date()`. */
  clock?: () => Date;
}

export class PaymentsService {
  private readonly payments: PaymentRepository;
  private readonly outbox: OutboxStore;
  private readonly psp: Psp;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(options: PaymentsServiceOptions) {
    this.payments = options.payments;
    this.outbox = options.outbox;
    this.psp = options.psp;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Authorize funds for a booking.
   *
   * Idempotent per booking: a booking that already holds a live (authorized or
   * captured) payment returns it unchanged, without calling the PSP again.
   * Otherwise the PSP is asked — a decline is returned as data and touches no
   * state, an outage propagates — and on approval the payment and a
   * `payment.authorized` event are committed together.
   */
  async authorize(command: AuthorizeCommand): Promise<AuthorizeOutcome> {
    const existing = await this.payments.findByBooking(command.bookingId);
    if (existing && existing.status !== 'voided') {
      return {
        authorized: true,
        paymentId: existing.id,
        authorizationId: existing.authorizationId,
        status: existing.status,
      };
    }

    const result = await this.psp.authorize({
      bookingId: command.bookingId,
      amount: command.amount,
      currency: command.currency,
    });
    if (!result.approved) {
      return { authorized: false, reason: result.declineReason };
    }

    const payment: Payment = {
      id: this.idFactory(),
      bookingId: command.bookingId,
      amount: command.amount,
      currency: command.currency,
      status: 'authorized',
      authorizationId: result.authorizationId,
      createdAt: this.clock(),
    };

    // One transaction: the payment and its event commit together or not at all.
    await runInTransaction(async (tx) => {
      await this.payments.commit(payment, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'payment',
          aggregateId: payment.id,
          eventType: 'payment.authorized',
          payload: {
            bookingId: payment.bookingId,
            amount: payment.amount,
            currency: payment.currency,
            authorizationId: payment.authorizationId,
          },
        }),
        tx,
      );
    });

    return {
      authorized: true,
      paymentId: payment.id,
      authorizationId: payment.authorizationId,
      status: 'authorized',
    };
  }

  /**
   * Capture a booking's authorized payment (the money-taking step).
   *
   * Idempotent: a payment already captured returns its standing capture without
   * calling the PSP again. A booking with no authorization, or one already
   * voided, is rejected with a reason rather than capturing. On success the
   * captured payment and a `payment.captured` event are committed together.
   */
  async capture(command: CaptureCommand): Promise<CaptureOutcome> {
    const existing = await this.payments.findByBooking(command.bookingId);
    if (!existing) {
      return { captured: false, reason: 'no_authorization' };
    }
    if (existing.status === 'captured') {
      return { captured: true, paymentId: existing.id, captureId: existing.captureId ?? '' };
    }
    if (existing.status === 'voided') {
      return { captured: false, reason: 'authorization_voided' };
    }

    const { captureId } = await this.psp.capture(existing.authorizationId);
    const captured: Payment = {
      ...existing,
      status: 'captured',
      captureId,
      capturedAt: this.clock(),
    };

    // One transaction: the capture and its event commit together or not at all.
    await runInTransaction(async (tx) => {
      await this.payments.commit(captured, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'payment',
          aggregateId: captured.id,
          eventType: 'payment.captured',
          payload: {
            bookingId: captured.bookingId,
            amount: captured.amount,
            currency: captured.currency,
            authorizationId: captured.authorizationId,
            captureId,
          },
        }),
        tx,
      );
    });

    return { captured: true, paymentId: captured.id, captureId };
  }

  /**
   * Void a booking's authorization (the saga compensation).
   *
   * Idempotent: it targets the `authorized -> voided` transition. A payment that
   * is already voided, already captured, or was never obtained yields a
   * successful no-op so the compensation can fire more than once. A live void
   * calls the PSP, then commits the voided payment and a `payment.voided` event
   * together.
   */
  async voidAuthorization(command: VoidCommand): Promise<VoidOutcome> {
    const existing = await this.payments.findByBooking(command.bookingId);
    if (!existing || existing.status !== 'authorized') {
      return { voided: true, paymentId: existing?.id ?? '' };
    }

    await this.psp.voidAuthorization(existing.authorizationId);
    const voided: Payment = { ...existing, status: 'voided', voidedAt: this.clock() };

    // One transaction: the void and its event commit together or not at all.
    await runInTransaction(async (tx) => {
      await this.payments.commit(voided, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'payment',
          aggregateId: voided.id,
          eventType: 'payment.voided',
          payload: {
            bookingId: voided.bookingId,
            amount: voided.amount,
            currency: voided.currency,
            authorizationId: voided.authorizationId,
          },
        }),
        tx,
      );
    });

    return { voided: true, paymentId: voided.id };
  }
}
