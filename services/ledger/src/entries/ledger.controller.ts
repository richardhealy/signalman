/**
 * The gRPC surface of the ledger service — the synchronous commands the saga
 * coordinator calls over the wire.
 *
 * It is a thin adapter: it translates the `Ledger` proto messages onto
 * {@link LedgerService} calls and back, and does nothing else. Keeping it thin
 * matters for the trace — the SERVER span the observability interceptor opens
 * around each `@GrpcMethod` is the ledger hop of the booking trace; the outbox
 * events hang off it, so the whole leg is one connected trace.
 *
 * Field names are camelCase because the proto loader maps snake_case proto fields
 * (`booking_id`) to camelCase (`bookingId`) by default. Replies set every field
 * explicitly so a proto3 zero value is always intentional, never accidental.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { LEDGER_GRPC_SERVICE } from '../proto';
import { LedgerService } from './ledger.service';

/** `Ledger.Commit` request. */
export interface CommitRequest {
  bookingId: string;
  amount: number;
  currency: string;
  captureId: string;
}

/** `Ledger.Commit` reply. `reason` is populated only when `committed` is `false`. */
export interface CommitReply {
  committed: boolean;
  entryId: string;
  reason: string;
}

/** `Ledger.Reverse` request. */
export interface ReverseRequest {
  bookingId: string;
}

/** `Ledger.Reverse` reply. */
export interface ReverseReply {
  reversed: boolean;
  entryId: string;
}

@Controller()
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @GrpcMethod(LEDGER_GRPC_SERVICE, 'Commit')
  async commit(request: CommitRequest): Promise<CommitReply> {
    const outcome = await this.ledger.commit({
      bookingId: request.bookingId,
      amount: request.amount,
      currency: request.currency,
      captureId: request.captureId,
    });
    return outcome.committed
      ? { committed: true, entryId: outcome.entryId, reason: '' }
      : { committed: false, entryId: '', reason: outcome.reason };
  }

  @GrpcMethod(LEDGER_GRPC_SERVICE, 'Reverse')
  async reverse(request: ReverseRequest): Promise<ReverseReply> {
    const outcome = await this.ledger.reverse({ bookingId: request.bookingId });
    return { reversed: outcome.reversed, entryId: outcome.entryId };
  }
}
