/**
 * The booking service — the gateway's application core.
 *
 * It turns a {@link BookingRequest} into a saga {@link BookCommand}, drives it
 * through the {@link CoordinatorPort}, folds the saga's reply into a flat
 * {@link BookingRecord}, persists that record, and returns it. The thin status
 * endpoint reads the same record back. The service knows nothing about gRPC or
 * HTTP — it depends only on the port and the store, so it is unit-tested against
 * fakes and the trace/transport concerns live in the adapters either side.
 *
 * Idempotency is the caller's to drive: a `bookingId` passed in is threaded
 * unchanged to the coordinator (and through to every leg), so a retried request
 * replays the same saga rather than booking twice. When the caller omits one,
 * the gateway mints a UUID — a one-shot booking gets a stable id to look up
 * later.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { type BookingRecord, type BookingRequest } from './booking';
import { type BookingStore } from './booking-store';
import { type BookCommand, type BookResult, type CoordinatorPort } from './coordinator-port';

/** Construction inputs for a {@link BookingService}. */
export interface BookingServiceOptions {
  coordinator: CoordinatorPort;
  store: BookingStore;
  /** Mints a booking id when the request omits one. Defaults to `randomUUID`. */
  newId?: () => string;
  /** Clock for the recorded `recordedAt`. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

@Injectable()
export class BookingService {
  private readonly coordinator: CoordinatorPort;
  private readonly store: BookingStore;
  private readonly newId: () => string;
  private readonly clock: () => Date;

  constructor(options: BookingServiceOptions) {
    this.coordinator = options.coordinator;
    this.store = options.store;
    this.newId = options.newId ?? (() => randomUUID());
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Drive a booking through the saga and record its outcome.
   *
   * Runs inside the gateway request's SERVER span: the coordinator port opens a
   * CLIENT child span and continues the trace downstream, and the active span's
   * trace id is stamped onto the record so the status links back to the booking
   * trace. Returns the recorded outcome (booked, or failed-with-compensation).
   */
  async book(request: BookingRequest): Promise<BookingRecord> {
    const bookingId = request.bookingId ?? this.newId();
    const command: BookCommand = {
      bookingId,
      sku: request.sku,
      qty: request.qty,
      amount: request.amount,
      currency: request.currency,
    };

    const reply = await this.coordinator.book(command);
    const record = this.toRecord(bookingId, request, reply);
    await this.store.save(record);
    return record;
  }

  /** The recorded outcome for a booking id, or `undefined` if the gateway has none. */
  async getStatus(bookingId: string): Promise<BookingRecord | undefined> {
    return this.store.get(bookingId);
  }

  /** Fold the saga reply, the request, and the active trace into a flat record. */
  private toRecord(
    bookingId: string,
    request: BookingRequest,
    reply: BookResult,
  ): BookingRecord {
    const base: BookingRecord = {
      bookingId,
      status: reply.booked ? 'booked' : 'failed',
      request: {
        sku: request.sku,
        qty: request.qty,
        amount: request.amount,
        currency: request.currency,
      },
      traceId: trace.getActiveSpan()?.spanContext().traceId ?? '',
      recordedAt: this.clock().toISOString(),
    };

    if (reply.booked) {
      return {
        ...base,
        holdId: reply.holdId,
        authorizationId: reply.authorizationId,
        confirmationId: reply.confirmationId,
        captureId: reply.captureId,
        entryId: reply.entryId,
      };
    }

    return {
      ...base,
      failedStep: reply.failedStep,
      reason: reply.reason,
      compensated: reply.compensated,
    };
  }
}
