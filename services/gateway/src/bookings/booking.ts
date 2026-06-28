/**
 * The gateway's booking domain types — the inputs and the recorded outcome of a
 * booking attempt.
 *
 * The gateway is a thin entry point: it accepts a {@link BookingRequest}, drives
 * the saga through the coordinator, and records the result as a
 * {@link BookingRecord} so the thin status endpoint can answer "what happened to
 * this booking?" without re-running the saga. The record carries the trace id of
 * the request that produced it, so an operator reading a status can jump
 * straight to the booking's trace — the same "every outcome links back to its
 * trace" thread the reconciler's findings follow.
 */

/** What a client POSTs to start a booking. `bookingId` is optional — the gateway mints one when absent. */
export interface BookingRequest {
  /** Caller-supplied idempotency key; a fresh UUID is minted when omitted. */
  bookingId?: string;
  /** The stock-keeping unit to book. */
  sku: string;
  /** How many units to book. */
  qty: number;
  /** Amount to take, in the currency's minor units (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code, e.g. `"USD"`. */
  currency: string;
}

/** Whether the saga booked the request or stopped on a failure. */
export type BookingStatus = 'booked' | 'failed';

/**
 * The recorded outcome of a booking attempt — what the status endpoint returns.
 *
 * On a `booked` outcome the reference fields carry each leg's truth handle and
 * the failure fields are absent; on a `failed` outcome the references are absent
 * and `failedStep`/`reason`/`compensated` describe how the saga stopped. The
 * shape stays a flat, JSON-friendly summary of the saga's reply plus the
 * originating request and trace.
 */
export interface BookingRecord {
  bookingId: string;
  status: BookingStatus;
  /** The request that produced this outcome, echoed back for context. */
  request: {
    sku: string;
    qty: number;
    amount: number;
    currency: string;
  };
  /** Trace id of the request that produced this record; links the outcome to its booking trace. */
  traceId: string;
  /** ISO-8601 instant the outcome was recorded. */
  recordedAt: string;

  // Present on a `booked` outcome.
  holdId?: string;
  authorizationId?: string;
  confirmationId?: string;
  captureId?: string;
  entryId?: string;

  // Present on a `failed` outcome.
  failedStep?: string;
  reason?: string;
  /** Whether the completed steps were unwound by compensations. */
  compensated?: boolean;
}
