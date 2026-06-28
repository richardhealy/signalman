/**
 * The supplier application service — the partner leg of the booking saga.
 *
 * It confirms and cancels bookings with the external partner, each operation
 * pairing a state change with an outbox event so the rest of the system learns
 * what happened without the dual-write problem. The properties that make it
 * saga-safe mirror the other legs:
 *
 * - **Idempotent confirmation.** A booking holds at most one live confirmation; a
 *   retried `confirm` returns the standing one rather than confirming the partner
 *   twice. The coordinator (and broker redeliveries) can retry freely.
 * - **Idempotent compensation.** `cancel` is a no-op once the confirmation is
 *   already cancelled (or was never obtained), so the compensation can fire more
 *   than once without double-cancelling.
 *
 * It draws a sharp line between a partner **rejection** (a business "no",
 * returned as data with a reason and changing no state) and a partner **outage**
 * (a thrown {@link SupplierUnavailableError}, propagated so the gRPC handler's
 * SERVER span is marked errored and the coordinator can retry the external hop).
 *
 * Both `commit` and the outbox `add` it accompanies belong in **one** transaction
 * in the Postgres-backed implementation; the in-memory collaborators used in
 * tests stand in until that lands, exactly as the other `@signalman/*` reference
 * stores do.
 */
import { createOutboxRecord, type OutboxStore } from '@signalman/outbox';
import { randomUUID } from 'node:crypto';
import { type Confirmation } from './confirmation';
import { type ConfirmationRepository } from './confirmation-repository';
import { type SupplierPartner } from './partner';

/** A request to confirm a booking with the partner. */
export interface ConfirmCommand {
  bookingId: string;
  sku: string;
  qty: number;
}

/** A request to cancel a booking's confirmation (the compensation). */
export interface CancelCommand {
  bookingId: string;
}

/**
 * The outcome of {@link SupplierService.confirm}. A discriminated union so
 * callers branch on `confirmed` and a rejection always carries a machine-readable
 * `reason`.
 */
export type ConfirmOutcome =
  | { confirmed: true; confirmationId: string }
  | { confirmed: false; reason: string };

/** The outcome of {@link SupplierService.cancel}. */
export interface CancelOutcome {
  cancelled: boolean;
  /** The cancelled partner confirmation reference, or `''` when there was nothing to cancel. */
  confirmationId: string;
}

/** Injectable collaborators and seams for {@link SupplierService}. */
export interface SupplierServiceOptions {
  confirmations: ConfirmationRepository;
  outbox: OutboxStore;
  partner: SupplierPartner;
  /** Confirmation-record-id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for confirmation timestamps; defaults to `() => new Date()`. */
  clock?: () => Date;
}

export class SupplierService {
  private readonly confirmations: ConfirmationRepository;
  private readonly outbox: OutboxStore;
  private readonly partner: SupplierPartner;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(options: SupplierServiceOptions) {
    this.confirmations = options.confirmations;
    this.outbox = options.outbox;
    this.partner = options.partner;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Confirm a booking with the partner.
   *
   * Idempotent per booking: a booking that already holds a live confirmation
   * returns it unchanged, without calling the partner again. Otherwise the
   * partner is asked — a rejection is returned as data and touches no state, an
   * outage propagates — and on acceptance the confirmation and a
   * `supplier.confirmed` event are committed together.
   */
  async confirm(command: ConfirmCommand): Promise<ConfirmOutcome> {
    const existing = await this.confirmations.findByBooking(command.bookingId);
    if (existing && existing.status === 'confirmed') {
      return { confirmed: true, confirmationId: existing.confirmationId };
    }

    const result = await this.partner.confirm({
      bookingId: command.bookingId,
      sku: command.sku,
      qty: command.qty,
    });
    if (!result.accepted) {
      return { confirmed: false, reason: result.rejectionReason };
    }

    const confirmation: Confirmation = {
      id: this.idFactory(),
      bookingId: command.bookingId,
      sku: command.sku,
      qty: command.qty,
      status: 'confirmed',
      confirmationId: result.confirmationId,
      createdAt: this.clock(),
    };

    await this.confirmations.commit(confirmation);
    await this.outbox.add(
      createOutboxRecord({
        aggregateType: 'confirmation',
        aggregateId: confirmation.id,
        eventType: 'supplier.confirmed',
        payload: {
          bookingId: confirmation.bookingId,
          sku: confirmation.sku,
          qty: confirmation.qty,
          confirmationId: confirmation.confirmationId,
        },
      }),
    );

    return { confirmed: true, confirmationId: confirmation.confirmationId };
  }

  /**
   * Cancel a booking's confirmation (the saga compensation).
   *
   * Idempotent: it targets the `confirmed -> cancelled` transition. A
   * confirmation that is already cancelled, or was never obtained, yields a
   * successful no-op so the compensation can fire more than once. A live cancel
   * calls the partner, then commits the cancelled confirmation and a
   * `supplier.cancelled` event together.
   */
  async cancel(command: CancelCommand): Promise<CancelOutcome> {
    const existing = await this.confirmations.findByBooking(command.bookingId);
    if (!existing || existing.status !== 'confirmed') {
      return { cancelled: true, confirmationId: existing?.confirmationId ?? '' };
    }

    await this.partner.cancel(existing.confirmationId);
    const cancelled: Confirmation = {
      ...existing,
      status: 'cancelled',
      cancelledAt: this.clock(),
    };

    await this.confirmations.commit(cancelled);
    await this.outbox.add(
      createOutboxRecord({
        aggregateType: 'confirmation',
        aggregateId: cancelled.id,
        eventType: 'supplier.cancelled',
        payload: {
          bookingId: cancelled.bookingId,
          sku: cancelled.sku,
          qty: cancelled.qty,
          confirmationId: cancelled.confirmationId,
        },
      }),
    );

    return { cancelled: true, confirmationId: cancelled.confirmationId };
  }
}
