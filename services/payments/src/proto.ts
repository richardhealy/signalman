/**
 * Coordinates for the payments gRPC contract, shared by the microservice (which
 * serves it) and any client that calls it.
 *
 * The package and service names mirror `proto/payments.proto`; keeping them in
 * one place stops the controller's `@GrpcMethod` bindings and the transport
 * registration from drifting out of sync with the `.proto`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The proto `package`, as declared in `payments.proto`. */
export const PAYMENTS_GRPC_PACKAGE = 'signalman.payments.v1';

/** The proto `service` name the controller's handlers bind to. */
export const PAYMENTS_GRPC_SERVICE = 'Payments';

/**
 * Locate the payments `.proto` by walking up from this module's directory for
 * the nearest `proto/payments.proto`.
 *
 * Why a search rather than a fixed `join(__dirname, …)`: nest-cli's monorepo
 * build nests a service that imports workspace libraries deeper than its source
 * layout (the lib sources widen tsc's `rootDir` to the repo root), so the
 * compiled module and the copied proto asset don't sit at the same relative
 * depth. The upward walk finds the proto whether the code runs from `src/`
 * (ts-jest/ts-node, proto alongside) or from a deeply-nested `dist/` (proto
 * copied to the service's output root by the `assets` glob).
 */
function resolveProtoPath(): string {
  let dir = __dirname;
  for (;;) {
    const candidate = join(dir, 'proto', 'payments.proto');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached the filesystem root without a hit; fall back to the source
      // layout so the error names a sensible path.
      return join(__dirname, 'proto', 'payments.proto');
    }
    dir = parent;
  }
}

/** Absolute path to the payments `.proto`, resolved for both `src/` and `dist/`. */
export const PAYMENTS_PROTO_PATH: string = resolveProtoPath();
