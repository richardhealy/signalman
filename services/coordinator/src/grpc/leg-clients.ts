/**
 * gRPC client adapters — the production implementations of the saga ports.
 *
 * Each adapter wraps a {@link UnaryCall}, a thin promise-returning view of a gRPC
 * unary method, and maps the port's methods onto the leg service's RPCs. The
 * adapters carry no logic of their own (a port method is one RPC call), so the
 * mapping is trivially testable against a fake {@link UnaryCall}; the only
 * untested seam is {@link createUnaryCall}, which is standard `@grpc/grpc-js`
 * wiring and cannot be exercised without a live server.
 *
 * Splitting the network call ({@link UnaryCall}) from the port mapping keeps the
 * proto loading and client construction in one place and lets the saga's legs be
 * swapped for fakes wherever a test needs them.
 */
import { credentials, loadPackageDefinition, type Client } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type {
  AuthorizeReply,
  AuthorizeRequest,
  CancelReply,
  CancelRequest,
  CaptureReply,
  CaptureRequest,
  CommitReply,
  CommitRequest,
  ConfirmReply,
  ConfirmRequest,
  HoldReply,
  HoldRequest,
  InventoryPort,
  LedgerPort,
  PaymentsPort,
  ReleaseReply,
  ReleaseRequest,
  ReverseReply,
  ReverseRequest,
  SupplierPort,
  VoidReply,
  VoidRequest,
} from '../saga/ports';

/**
 * A promise-returning view of a single gRPC service's unary methods. The
 * `method` is the RPC name as declared in the `.proto` (e.g. `Hold`).
 */
export type UnaryCall = <Reply>(method: string, request: object) => Promise<Reply>;

/** What {@link createUnaryCall} needs to reach one leg service. */
export interface UnaryCallOptions {
  /** Absolute path to the service's `.proto`. */
  protoPath: string;
  /** The proto package, e.g. `signalman.inventory.v1`. */
  package: string;
  /** The proto service name, e.g. `Inventory`. */
  service: string;
  /** Where to dial the service, e.g. `localhost:50051`. */
  url: string;
}

/** A constructor for a generated gRPC service client. */
type ServiceClientClass = new (address: string, creds: ReturnType<typeof credentials.createInsecure>) => Client;

/** Walk a dotted package path (`a.b.C`) to the generated client constructor. */
function resolveServiceClass(root: unknown, packageName: string, service: string): ServiceClientClass {
  const path = `${packageName}.${service}`.split('.');
  let node: unknown = root;
  for (const segment of path) {
    if (node == null || typeof node !== 'object') {
      throw new Error(`gRPC service ${packageName}.${service} not found in proto definition`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'function') {
    throw new Error(`gRPC service ${packageName}.${service} is not a client constructor`);
  }
  return node as ServiceClientClass;
}

/**
 * Build a {@link UnaryCall} for one leg service: load its `.proto`, construct an
 * insecure gRPC client (connection is lazy, so no server need be up yet), and
 * return a function that invokes a unary method and resolves with its reply.
 *
 * `longs: Number` decodes `uint64` fields (amounts) as plain JS numbers, matching
 * how the leg services serve them, so the saga never sees a `Long` object.
 */
export function createUnaryCall(options: UnaryCallOptions): UnaryCall {
  const definition = loadSync(options.protoPath, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = loadPackageDefinition(definition);
  const ServiceClass = resolveServiceClass(proto, options.package, options.service);
  const client = new ServiceClass(options.url, credentials.createInsecure());

  return <Reply>(method: string, request: object): Promise<Reply> =>
    new Promise<Reply>((resolve, reject) => {
      const invoke = (client as unknown as Record<string, unknown>)[method];
      if (typeof invoke !== 'function') {
        reject(new Error(`gRPC method ${method} not found on ${options.service} client`));
        return;
      }
      invoke.call(client, request, (error: unknown, reply: Reply) => {
        if (error) {
          reject(error as Error);
        } else {
          resolve(reply);
        }
      });
    });
}

/** Inventory port over gRPC. */
export class GrpcInventoryPort implements InventoryPort {
  constructor(private readonly call: UnaryCall) {}

  hold(request: HoldRequest): Promise<HoldReply> {
    return this.call<HoldReply>('Hold', request);
  }

  release(request: ReleaseRequest): Promise<ReleaseReply> {
    return this.call<ReleaseReply>('Release', request);
  }
}

/** Payments port over gRPC. */
export class GrpcPaymentsPort implements PaymentsPort {
  constructor(private readonly call: UnaryCall) {}

  authorize(request: AuthorizeRequest): Promise<AuthorizeReply> {
    return this.call<AuthorizeReply>('Authorize', request);
  }

  capture(request: CaptureRequest): Promise<CaptureReply> {
    return this.call<CaptureReply>('Capture', request);
  }

  voidAuthorization(request: VoidRequest): Promise<VoidReply> {
    return this.call<VoidReply>('Void', request);
  }
}

/** Supplier port over gRPC. */
export class GrpcSupplierPort implements SupplierPort {
  constructor(private readonly call: UnaryCall) {}

  confirm(request: ConfirmRequest): Promise<ConfirmReply> {
    return this.call<ConfirmReply>('Confirm', request);
  }

  cancel(request: CancelRequest): Promise<CancelReply> {
    return this.call<CancelReply>('Cancel', request);
  }
}

/** Ledger port over gRPC. */
export class GrpcLedgerPort implements LedgerPort {
  constructor(private readonly call: UnaryCall) {}

  commit(request: CommitRequest): Promise<CommitReply> {
    return this.call<CommitReply>('Commit', request);
  }

  reverse(request: ReverseRequest): Promise<ReverseReply> {
    return this.call<ReverseReply>('Reverse', request);
  }
}
