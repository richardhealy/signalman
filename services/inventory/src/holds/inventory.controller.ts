/**
 * The gRPC surface of the inventory service — the synchronous commands the saga
 * coordinator calls over the wire.
 *
 * It is a thin adapter: it translates the `Inventory` proto messages onto
 * {@link InventoryService} calls and back, and does nothing else. Keeping it thin
 * matters for the trace — the SERVER span the observability interceptor opens
 * around each `@GrpcMethod` is the inventory hop of the booking trace, and the
 * outbox events the service stages continue from it, so the whole leg hangs off
 * one connected trace.
 *
 * Field names are camelCase because the proto loader maps snake_case proto fields
 * (`booking_id`) to camelCase (`bookingId`) by default. Replies set every field
 * explicitly so a proto3 zero value is always intentional, never accidental.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { INVENTORY_GRPC_SERVICE } from '../proto';
import { InventoryService } from './inventory.service';

/** `Inventory.Hold` request. */
export interface HoldRequest {
  bookingId: string;
  sku: string;
  qty: number;
}

/** `Inventory.Hold` reply. `reason` is populated only when `held` is `false`. */
export interface HoldReply {
  held: boolean;
  holdId: string;
  reason: string;
  available: number;
}

/** `Inventory.Release` request. */
export interface ReleaseRequest {
  bookingId: string;
}

/** `Inventory.Release` reply. */
export interface ReleaseReply {
  released: boolean;
  holdId: string;
}

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @GrpcMethod(INVENTORY_GRPC_SERVICE, 'Hold')
  async hold(request: HoldRequest): Promise<HoldReply> {
    const outcome = await this.inventory.hold({
      bookingId: request.bookingId,
      sku: request.sku,
      qty: request.qty,
    });
    return outcome.held
      ? { held: true, holdId: outcome.holdId, reason: '', available: outcome.available }
      : { held: false, holdId: '', reason: outcome.reason, available: outcome.available };
  }

  @GrpcMethod(INVENTORY_GRPC_SERVICE, 'Release')
  async release(request: ReleaseRequest): Promise<ReleaseReply> {
    const outcome = await this.inventory.release({ bookingId: request.bookingId });
    return { released: outcome.released, holdId: outcome.holdId };
  }
}
