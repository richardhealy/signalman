/**
 * The gRPC surface of the payments service — the synchronous commands the saga
 * coordinator calls over the wire.
 *
 * It is a thin adapter: it translates the `Payments` proto messages onto
 * {@link PaymentsService} calls and back, and does nothing else. Keeping it thin
 * matters for the trace — the SERVER span the observability interceptor opens
 * around each `@GrpcMethod` is the payments hop of the booking trace; the PSP
 * CLIENT span and the outbox events both hang off it, so the whole leg is one
 * connected trace.
 *
 * Field names are camelCase because the proto loader maps snake_case proto fields
 * (`booking_id`) to camelCase (`bookingId`) by default. Replies set every field
 * explicitly so a proto3 zero value is always intentional, never accidental.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { PAYMENTS_GRPC_SERVICE } from '../proto';
import { PaymentsService } from './payments.service';

/** `Payments.Authorize` request. */
export interface AuthorizeRequest {
  bookingId: string;
  amount: number;
  currency: string;
}

/** `Payments.Authorize` reply. `reason` is populated only when `authorized` is `false`. */
export interface AuthorizeReply {
  authorized: boolean;
  paymentId: string;
  authorizationId: string;
  reason: string;
}

/** `Payments.Capture` request. */
export interface CaptureRequest {
  bookingId: string;
}

/** `Payments.Capture` reply. `reason` is populated only when `captured` is `false`. */
export interface CaptureReply {
  captured: boolean;
  paymentId: string;
  captureId: string;
  reason: string;
}

/** `Payments.Void` request. */
export interface VoidRequest {
  bookingId: string;
}

/** `Payments.Void` reply. */
export interface VoidReply {
  voided: boolean;
  paymentId: string;
}

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @GrpcMethod(PAYMENTS_GRPC_SERVICE, 'Authorize')
  async authorize(request: AuthorizeRequest): Promise<AuthorizeReply> {
    const outcome = await this.payments.authorize({
      bookingId: request.bookingId,
      amount: request.amount,
      currency: request.currency,
    });
    return outcome.authorized
      ? {
          authorized: true,
          paymentId: outcome.paymentId,
          authorizationId: outcome.authorizationId,
          reason: '',
        }
      : { authorized: false, paymentId: '', authorizationId: '', reason: outcome.reason };
  }

  @GrpcMethod(PAYMENTS_GRPC_SERVICE, 'Capture')
  async capture(request: CaptureRequest): Promise<CaptureReply> {
    const outcome = await this.payments.capture({ bookingId: request.bookingId });
    return outcome.captured
      ? { captured: true, paymentId: outcome.paymentId, captureId: outcome.captureId, reason: '' }
      : { captured: false, paymentId: '', captureId: '', reason: outcome.reason };
  }

  @GrpcMethod(PAYMENTS_GRPC_SERVICE, 'Void')
  async voidAuthorization(request: VoidRequest): Promise<VoidReply> {
    const outcome = await this.payments.voidAuthorization({ bookingId: request.bookingId });
    return { voided: outcome.voided, paymentId: outcome.paymentId };
  }
}
