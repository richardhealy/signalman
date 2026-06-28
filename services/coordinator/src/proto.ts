/**
 * Coordinates and `.proto` locations for every gRPC contract the coordinator
 * touches: the `Coordinator` service it serves, and the four leg services it
 * calls as a client (inventory, payments, supplier, ledger).
 *
 * The leg `.proto` files are vendored client copies under this service's
 * `proto/` — the coordinator ships the contracts it depends on rather than
 * reaching into sibling services' source trees, which would not survive the
 * compiled `dist/` layout. The package and service names mirror each contract;
 * keeping them here stops the transport registration and the client factories
 * from drifting out of sync with the `.proto`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Locate a vendored `.proto` by walking up from this module's directory for the
 * nearest `proto/<filename>`.
 *
 * Why a search rather than a fixed `join(__dirname, …)`: nest-cli's monorepo
 * build nests a service that imports workspace libraries deeper than its source
 * layout (the lib sources widen tsc's `rootDir` to the repo root), so the
 * compiled module and the copied proto asset don't sit at the same relative
 * depth. The upward walk finds the proto whether the code runs from `src/`
 * (ts-jest/ts-node, proto alongside) or from a deeply-nested `dist/` (proto
 * copied to the service's output root by the `assets` glob).
 */
function resolveProtoPath(filename: string): string {
  let dir = __dirname;
  for (;;) {
    const candidate = join(dir, 'proto', filename);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root without a hit; fall back to the source
      // layout so the error names a sensible path.
      return join(__dirname, 'proto', filename);
    }
    dir = parent;
  }
}

/** The coordinator's own contract — the surface the gateway calls. */
export const COORDINATOR_GRPC_PACKAGE = 'signalman.coordinator.v1';
export const COORDINATOR_GRPC_SERVICE = 'Coordinator';
export const COORDINATOR_PROTO_PATH: string = resolveProtoPath('coordinator.proto');

/** The inventory leg contract — `Hold`/`Release`. */
export const INVENTORY_GRPC_PACKAGE = 'signalman.inventory.v1';
export const INVENTORY_GRPC_SERVICE = 'Inventory';
export const INVENTORY_PROTO_PATH: string = resolveProtoPath('inventory.proto');

/** The payments leg contract — `Authorize`/`Capture`/`Void`. */
export const PAYMENTS_GRPC_PACKAGE = 'signalman.payments.v1';
export const PAYMENTS_GRPC_SERVICE = 'Payments';
export const PAYMENTS_PROTO_PATH: string = resolveProtoPath('payments.proto');

/** The supplier leg contract — `Confirm`/`Cancel`. */
export const SUPPLIER_GRPC_PACKAGE = 'signalman.supplier.v1';
export const SUPPLIER_GRPC_SERVICE = 'Supplier';
export const SUPPLIER_PROTO_PATH: string = resolveProtoPath('supplier.proto');

/** The ledger leg contract — `Commit`/`Reverse`. */
export const LEDGER_GRPC_PACKAGE = 'signalman.ledger.v1';
export const LEDGER_GRPC_SERVICE = 'Ledger';
export const LEDGER_PROTO_PATH: string = resolveProtoPath('ledger.proto');
