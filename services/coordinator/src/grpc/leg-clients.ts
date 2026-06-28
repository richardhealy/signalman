/**
 * gRPC client adapters — the production implementations of the saga ports.
 *
 * Each adapter wraps a {@link UnaryCall}, a thin promise-returning view of a gRPC
 * unary method, and maps the port's methods onto the leg service's RPCs. The
 * adapters carry no logic of their own (a port method is one RPC call), so the
 * mapping is trivially testable against a fake {@link UnaryCall}.
 *
 * The wire call itself is traced: {@link createUnaryCall} runs every RPC through
 * {@link callWithTrace}, which opens a CLIENT span and injects the active booking
 * trace context into the request metadata (via {@link injectTraceMetadata}), so
 * the leg's SERVER span continues the same trace rather than starting an orphan —
 * the coordinator → leg half of "one booking is one connected trace". The span
 * and injection are factored into helpers that a test can exercise with a fake
 * call; the residual untested seam is the `@grpc/grpc-js` client construction in
 * {@link createUnaryCall}, which needs a real connection.
 *
 * Splitting the network call ({@link UnaryCall}) from the port mapping keeps the
 * proto loading and client construction in one place and lets the saga's legs be
 * swapped for fakes wherever a test needs them.
 */
import { Metadata, credentials, loadPackageDefinition, type Client } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Context,
  type Tracer,
} from '@opentelemetry/api';
import { getTracer } from '@signalman/otel';
import { injectContext } from '@signalman/propagation';
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

// The `rpc.*` keys live in the semantic-conventions *incubating* entry point,
// which classic `node` module resolution can't see; mirror the stable keys here,
// matching what `@signalman/interceptor` sets on the SERVER side of the hop.
const ATTR_RPC_SYSTEM = 'rpc.system';
const ATTR_RPC_SERVICE = 'rpc.service';
const ATTR_RPC_METHOD = 'rpc.method';

/** Tracer used for the per-call CLIENT span when an adapter is not given one. */
const DEFAULT_TRACER_SCOPE = '@signalman/coordinator';

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
  /**
   * Tracer the per-call CLIENT span is opened on; defaults to the coordinator's
   * own tracer. Injectable so a test can assert the emitted spans.
   */
  tracer?: Tracer;
}

/**
 * Inject the W3C trace context of `ctx` into gRPC request metadata, so the leg
 * service can lift it and continue the booking trace. Only string carrier values
 * are copied — `traceparent`/`tracestate` are always strings — keeping binary
 * metadata keys out of the text carrier.
 *
 * @param ctx - the context to serialise; typically the active context carrying the CLIENT span.
 * @param metadata - an existing metadata object to extend; a new one is created when omitted.
 * @returns the metadata, mutated in place, for convenient chaining.
 */
export function injectTraceMetadata(ctx: Context, metadata: Metadata = new Metadata()): Metadata {
  const carrier = injectContext(ctx);
  for (const [key, value] of Object.entries(carrier)) {
    if (typeof value === 'string') {
      metadata.set(key, value);
    }
  }
  return metadata;
}

/**
 * The raw gRPC unary call: a method taking the request, the (trace-carrying)
 * metadata, and a node-style callback. `@grpc/grpc-js`'s generated client methods
 * have this shape; a test passes a fake to exercise {@link callWithTrace} without
 * a live server.
 */
export type RawUnaryInvoke<Reply> = (
  request: object,
  metadata: Metadata,
  callback: (error: unknown, reply: Reply) => void,
) => void;

/** What {@link callWithTrace} needs to make one traced unary call. */
export interface TracedCallOptions<Reply> {
  /** Tracer the CLIENT span is opened on. */
  tracer: Tracer;
  /** Fully-qualified RPC service, e.g. `signalman.inventory.v1.Inventory`. */
  rpcService: string;
  /** RPC method name as declared in the `.proto`, e.g. `Hold`. */
  method: string;
  /** The request message. */
  request: object;
  /** The underlying gRPC call, invoked with the trace-carrying metadata. */
  invoke: RawUnaryInvoke<Reply>;
}

/**
 * Make one gRPC unary call inside a CLIENT span, injecting that span's trace
 * context into the outgoing metadata so the leg's SERVER span continues the same
 * booking trace. The span follows the OTel RPC semantic conventions
 * (`rpc.system`/`rpc.service`/`rpc.method`), is marked errored on a transport
 * failure, and always ends.
 */
export function callWithTrace<Reply>(options: TracedCallOptions<Reply>): Promise<Reply> {
  const { tracer, rpcService, method, request, invoke } = options;
  const span = tracer.startSpan(`${rpcService}/${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      [ATTR_RPC_SYSTEM]: 'grpc',
      [ATTR_RPC_SERVICE]: rpcService,
      [ATTR_RPC_METHOD]: method,
    },
  });
  const ctx = trace.setSpan(otelContext.active(), span);
  const metadata = injectTraceMetadata(ctx);

  return new Promise<Reply>((resolve, reject) => {
    invoke(request, metadata, (error, reply) => {
      if (error) {
        span.recordException(error instanceof Error ? error : { message: String(error) });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.end();
        reject(error as Error);
      } else {
        span.end();
        resolve(reply);
      }
    });
  });
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
 * Every call is run through {@link callWithTrace}, so the RPC is wrapped in a
 * CLIENT span and the booking trace is injected into the request metadata.
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
  const tracer = options.tracer ?? getTracer(DEFAULT_TRACER_SCOPE);
  const rpcService = `${options.package}.${options.service}`;

  return <Reply>(method: string, request: object): Promise<Reply> => {
    const invoke = (client as unknown as Record<string, unknown>)[method];
    if (typeof invoke !== 'function') {
      return Promise.reject(
        new Error(`gRPC method ${method} not found on ${options.service} client`),
      );
    }
    return callWithTrace<Reply>({
      tracer,
      rpcService,
      method,
      request,
      invoke: (req, metadata, callback) =>
        (invoke as (...args: unknown[]) => void).call(client, req, metadata, callback),
    });
  };
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
