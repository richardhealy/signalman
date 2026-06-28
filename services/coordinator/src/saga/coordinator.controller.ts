/**
 * The gRPC surface of the coordinator service — the single synchronous command
 * the gateway calls to make a booking.
 *
 * It is a thin adapter: it translates the `Coordinator` proto messages onto a
 * {@link BookingSaga.book} call and maps the saga's {@link BookOutcome} back onto
 * the proto reply, and does nothing else. The saga is where the orchestration
 * lives. Keeping the handler thin matters for the trace — the SERVER span the
 * observability interceptor opens around `Book` is the coordinator hop of the
 * booking trace, and every saga step and compensation span hangs off it, so the
 * whole booking is one connected subtree from this one entry point.
 *
 * Field names are camelCase because the proto loader maps snake_case proto fields
 * (`booking_id`) to camelCase (`bookingId`) by default. The reply sets every
 * field explicitly so a proto3 zero value is always intentional, never
 * accidental: a successful booking zeroes the failure fields, a failure zeroes
 * the reference fields.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { COORDINATOR_GRPC_SERVICE } from '../proto';
import { BookingSaga } from './booking-saga';

/** `Coordinator.Book` request — mirrors {@link BookCommand}. */
export interface BookRequest {
  bookingId: string;
  sku: string;
  qty: number;
  /** Amount to take, in the currency's minor units (e.g. cents). */
  amount: number;
  currency: string;
}

/**
 * `Coordinator.Book` reply. On success the reference fields carry each leg's
 * truth handle and the failure fields are empty; on failure the reference fields
 * are empty and `failedStep`/`reason`/`compensated` describe how the saga
 * stopped.
 */
export interface BookReply {
  booked: boolean;
  holdId: string;
  authorizationId: string;
  confirmationId: string;
  captureId: string;
  entryId: string;
  failedStep: string;
  reason: string;
  compensated: boolean;
}

@Controller()
export class CoordinatorController {
  constructor(private readonly saga: BookingSaga) {}

  @GrpcMethod(COORDINATOR_GRPC_SERVICE, 'Book')
  async book(request: BookRequest): Promise<BookReply> {
    const outcome = await this.saga.book({
      bookingId: request.bookingId,
      sku: request.sku,
      qty: request.qty,
      amount: request.amount,
      currency: request.currency,
    });

    if (outcome.booked) {
      return {
        booked: true,
        holdId: outcome.holdId,
        authorizationId: outcome.authorizationId,
        confirmationId: outcome.confirmationId,
        captureId: outcome.captureId,
        entryId: outcome.entryId,
        failedStep: '',
        reason: '',
        compensated: false,
      };
    }

    return {
      booked: false,
      holdId: '',
      authorizationId: '',
      confirmationId: '',
      captureId: '',
      entryId: '',
      failedStep: outcome.failedStep,
      reason: outcome.reason,
      compensated: outcome.compensated,
    };
  }
}
