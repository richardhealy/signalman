/**
 * The gateway's booking HTTP surface — the system's public entry point.
 *
 * `POST /bookings` starts a booking: it validates the request, drives the saga
 * through the {@link BookingService}, and returns the recorded outcome. This is
 * where a booking's trace begins — the request runs inside the SERVER (root)
 * span the observability interceptor opens, and the booking service's
 * coordinator port continues that trace over gRPC, so the whole booking is one
 * connected trace rooted at this handler.
 *
 * `GET /bookings/:id` is the thin status endpoint: it reads back the recorded
 * outcome so a caller can learn a booking's fate (and, via the record's
 * `traceId`, jump to its trace) without re-running the saga.
 *
 * Validation is done by hand rather than with a pipe/DTO library to keep the
 * gateway dependency-light; a malformed body is a `400`, an unknown booking a
 * `404`, and a coordinator outage a `502` (the gateway is up, its downstream is
 * not).
 */
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { type BookingRecord, type BookingRequest } from './booking';
import { BookingService } from './booking.service';

/** Reject a value that is not a finite, positive integer (qty, amount). */
function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`${field} must be a positive integer`);
  }
  return value;
}

/** Reject a value that is not a non-empty string, trimming surrounding whitespace. */
function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validate and normalise a raw request body into a {@link BookingRequest}.
 * Exported so the validation is unit-testable on its own and reused by the
 * controller. Throws {@link BadRequestException} on the first invalid field.
 */
export function parseBookingRequest(body: unknown): BookingRequest {
  if (body === null || typeof body !== 'object') {
    throw new BadRequestException('request body must be a JSON object');
  }
  const raw = body as Record<string, unknown>;

  const request: BookingRequest = {
    sku: requireNonEmptyString(raw.sku, 'sku'),
    qty: requirePositiveInt(raw.qty, 'qty'),
    amount: requirePositiveInt(raw.amount, 'amount'),
    currency: requireNonEmptyString(raw.currency, 'currency'),
  };

  if (raw.bookingId !== undefined) {
    request.bookingId = requireNonEmptyString(raw.bookingId, 'bookingId');
  }

  return request;
}

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  /**
   * Start a booking. Returns the recorded outcome — `201` whether the saga
   * booked or stopped on a business failure, since either way the gateway has
   * created a durable record of the attempt; the record's `status` says which.
   * A coordinator transport failure surfaces as `502`.
   */
  @Post()
  async create(@Body() body: unknown): Promise<BookingRecord> {
    const request = parseBookingRequest(body);
    try {
      return await this.bookings.book(request);
    } catch (error) {
      // A validation/HTTP error from the saga path is already shaped; anything
      // else is the coordinator being unreachable or erroring — a bad gateway.
      if (error instanceof HttpException) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new BadGatewayException(`coordinator unavailable: ${reason}`);
    }
  }

  /** Read back a booking's recorded outcome, or `404` if the gateway has none. */
  @Get(':id')
  async status(@Param('id') id: string): Promise<BookingRecord> {
    const record = await this.bookings.getStatus(id);
    if (record === undefined) {
      throw new NotFoundException(`no booking recorded for id ${id}`);
    }
    return record;
  }
}
