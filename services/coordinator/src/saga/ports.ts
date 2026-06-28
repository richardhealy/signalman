/**
 * The coordinator's view of the four synchronous saga legs.
 *
 * Each port mirrors one downstream service's gRPC command surface as a
 * promise-returning interface in the coordinator's own terms — the request and
 * reply shapes match the proto messages (camelCase, since the proto loader maps
 * `booking_id` to `bookingId`). The {@link BookingSaga} depends only on these
 * ports, so it can be unit-tested against in-memory fakes; the gRPC client
 * adapters in `../grpc/leg-clients` are the production implementations that call
 * the real services over the wire.
 *
 * Each leg exposes its forward command(s) and its idempotent compensation — the
 * operation the saga calls to unwind that step when a later step fails.
 */

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

/** `Inventory.Release` request — the hold compensation. */
export interface ReleaseRequest {
  bookingId: string;
}

/** `Inventory.Release` reply. */
export interface ReleaseReply {
  released: boolean;
  holdId: string;
}

/** The inventory leg: reserve stock, and release it on unwind. */
export interface InventoryPort {
  hold(request: HoldRequest): Promise<HoldReply>;
  release(request: ReleaseRequest): Promise<ReleaseReply>;
}

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

/** `Payments.Void` request — the authorization compensation. */
export interface VoidRequest {
  bookingId: string;
}

/** `Payments.Void` reply. */
export interface VoidReply {
  voided: boolean;
  paymentId: string;
}

/** The payments leg: authorize, capture, and void on unwind. */
export interface PaymentsPort {
  authorize(request: AuthorizeRequest): Promise<AuthorizeReply>;
  capture(request: CaptureRequest): Promise<CaptureReply>;
  voidAuthorization(request: VoidRequest): Promise<VoidReply>;
}

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

/** `Supplier.Cancel` request — the confirmation compensation. */
export interface CancelRequest {
  bookingId: string;
}

/** `Supplier.Cancel` reply. */
export interface CancelReply {
  cancelled: boolean;
  confirmationId: string;
}

/** The supplier leg: confirm with the partner, and cancel on unwind. */
export interface SupplierPort {
  confirm(request: ConfirmRequest): Promise<ConfirmReply>;
  cancel(request: CancelRequest): Promise<CancelReply>;
}

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

/** `Ledger.Reverse` request — the entry compensation. */
export interface ReverseRequest {
  bookingId: string;
}

/** `Ledger.Reverse` reply. */
export interface ReverseReply {
  reversed: boolean;
  entryId: string;
}

/** The ledger leg: commit the entry, and reverse it on unwind. */
export interface LedgerPort {
  commit(request: CommitRequest): Promise<CommitReply>;
  reverse(request: ReverseRequest): Promise<ReverseReply>;
}
