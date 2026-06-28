/**
 * The coordinator port — the gateway's view of the saga orchestrator.
 *
 * The gateway depends on this interface, not on gRPC, so the booking service is
 * unit-tested against an in-memory fake and wired to the live coordinator in
 * production (see {@link GrpcCoordinatorPort}). The request and reply mirror the
 * `Coordinator.Book` proto messages one-to-one (camelCase, as the proto loader
 * maps snake_case fields), so the gRPC adapter is a trivial pass-through and the
 * mapping logic lives in the service.
 */

/** A booking command — what the gateway asks the coordinator to do. */
export interface BookCommand {
  /** The booking's id; threaded to every leg as the idempotency key. */
  bookingId: string;
  /** The stock-keeping unit to book. */
  sku: string;
  /** How many units to book. */
  qty: number;
  /** Amount to take, in the currency's minor units (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code, e.g. `"USD"`. */
  currency: string;
}

/**
 * The coordinator's reply. On a booked outcome the reference fields carry each
 * leg's truth handle and the failure fields are empty; on a failure the
 * reference fields are empty and `failedStep`/`reason`/`compensated` describe
 * how the saga stopped. Proto3 zero values are meaningful here — the reply
 * always sets every field, so an empty string is "not applicable", never
 * "unknown".
 */
export interface BookResult {
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

/** The gateway's port onto the saga coordinator. */
export interface CoordinatorPort {
  /** Drive a booking to completion (or failure-with-compensation) over the saga. */
  book(command: BookCommand): Promise<BookResult>;
}

/** DI token for the {@link CoordinatorPort} the booking service drives. */
export const COORDINATOR_PORT = Symbol('COORDINATOR_PORT');
