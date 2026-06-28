/**
 * Coordinate and `.proto` location for the one gRPC contract the gateway calls:
 * the saga `Coordinator` it drives to make a booking.
 *
 * The `.proto` is a vendored client copy under this service's `proto/` — the
 * gateway ships the contract it depends on rather than reaching into the
 * coordinator's source tree, which would not survive the compiled `dist/`
 * layout (the same convention the coordinator uses for its leg contracts).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Locate the vendored `.proto` by walking up from this module's directory for
 * the nearest `proto/<filename>`.
 *
 * Why a search rather than a fixed `join(__dirname, …)`: nest-cli's monorepo
 * build nests a service that imports workspace libraries deeper than its source
 * layout, so the compiled module and the copied proto asset don't sit at the
 * same relative depth. The upward walk finds the proto whether the code runs
 * from `src/` (ts-jest/ts-node, proto alongside) or from a deeply-nested
 * `dist/` (proto copied to the service's output root by the `assets` glob).
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

/** The coordinator contract — the surface the gateway calls to make a booking. */
export const COORDINATOR_GRPC_PACKAGE = 'signalman.coordinator.v1';
export const COORDINATOR_GRPC_SERVICE = 'Coordinator';
export const COORDINATOR_PROTO_PATH: string = resolveProtoPath('coordinator.proto');
