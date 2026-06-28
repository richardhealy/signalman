/**
 * The gRPC surface of the supplier service — the synchronous commands the saga
 * coordinator calls over the wire.
 *
 * It is a thin adapter: it translates the `Supplier` proto messages onto
 * {@link SupplierService} calls and back, and does nothing else. Keeping it thin
 * matters for the trace — the SERVER span the observability interceptor opens
 * around each `@GrpcMethod` is the supplier hop of the booking trace; the
 * partner CLIENT span and the outbox events both hang off it, so the whole leg is
 * one connected trace.
 *
 * Field names are camelCase because the proto loader maps snake_case proto fields
 * (`booking_id`) to camelCase (`bookingId`) by default. Replies set every field
 * explicitly so a proto3 zero value is always intentional, never accidental.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { SUPPLIER_GRPC_SERVICE } from '../proto';
import { SupplierService } from './supplier.service';

/** `Supplier.Confirm` request. */
export interface ConfirmRequest {
  bookingId: string;
  sku: string;
  qty: number;
}

/** `Supplier.Confirm` reply. `reason` is populated only when `confirmed` is `false`. */
export interface ConfirmReply {
  confirmed: boolean;
  confirmationId: string;
  reason: string;
}

/** `Supplier.Cancel` request. */
export interface CancelRequest {
  bookingId: string;
}

/** `Supplier.Cancel` reply. */
export interface CancelReply {
  cancelled: boolean;
  confirmationId: string;
}

@Controller()
export class SupplierController {
  constructor(private readonly supplier: SupplierService) {}

  @GrpcMethod(SUPPLIER_GRPC_SERVICE, 'Confirm')
  async confirm(request: ConfirmRequest): Promise<ConfirmReply> {
    const outcome = await this.supplier.confirm({
      bookingId: request.bookingId,
      sku: request.sku,
      qty: request.qty,
    });
    return outcome.confirmed
      ? { confirmed: true, confirmationId: outcome.confirmationId, reason: '' }
      : { confirmed: false, confirmationId: '', reason: outcome.reason };
  }

  @GrpcMethod(SUPPLIER_GRPC_SERVICE, 'Cancel')
  async cancel(request: CancelRequest): Promise<CancelReply> {
    const outcome = await this.supplier.cancel({ bookingId: request.bookingId });
    return { cancelled: outcome.cancelled, confirmationId: outcome.confirmationId };
  }
}
