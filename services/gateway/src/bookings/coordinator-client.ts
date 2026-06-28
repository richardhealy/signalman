/**
 * gRPC client adapter — the production implementation of the {@link CoordinatorPort}.
 *
 * This is the gateway → coordinator hop of "one booking is one connected trace".
 * The gateway's HTTP handler runs inside the SERVER (root) span the observability
 * interceptor opens; {@link callWithTrace} opens a CLIENT span under it and
 * injects the active W3C trace context into the request metadata, so the
 * coordinator's SERVER span continues the same trace instead of starting an
 * orphan. The whole booking — gateway, coordinator, and every leg below it — is
 * then one connected subtree rooted at the gateway request.
 *
 * The trace/inject/call seam mirrors the coordinator's own leg clients
 * (`services/coordinator/src/grpc/leg-clients.ts`); a future shared lib could
 * host both, but each service vendoring its own gRPC client keeps the contracts
 * and the compiled `dist/` layout self-contained, matching this repo's existing
 * convention.
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
import { COORDINATOR_GRPC_PACKAGE, COORDINATOR_GRPC_SERVICE, COORDINATOR_PROTO_PATH } from './proto';
import type { BookCommand, BookResult, CoordinatorPort } from './coordinator-port';

// The `rpc.*` keys live in the semantic-conventions *incubating* entry point,
// which classic `node` module resolution can't see; mirror the stable keys here,
// matching what `@signalman/interceptor` sets on the SERVER side of the hop and
// what the coordinator's leg clients set on theirs.
const ATTR_RPC_SYSTEM = 'rpc.system';
const ATTR_RPC_SERVICE = 'rpc.service';
const ATTR_RPC_METHOD = 'rpc.method';

/** Tracer used for the per-call CLIENT span when one is not supplied. */
const DEFAULT_TRACER_SCOPE = '@signalman/gateway';

/** A promise-returning view of the coordinator's unary methods. */
export type UnaryCall = <Reply>(method: string, request: object) => Promise<Reply>;

/** What {@link createCoordinatorCall} needs to reach the coordinator. */
export interface CoordinatorCallOptions {
  /** Where to dial the coordinator, e.g. `localhost:50050`. */
  url: string;
  /**
   * Tracer the per-call CLIENT span is opened on; defaults to the gateway's own
   * tracer. Injectable so a test can assert the emitted spans.
   */
  tracer?: Tracer;
}

/**
 * Inject the W3C trace context of `ctx` into gRPC request metadata, so the
 * coordinator can lift it and continue the booking trace. Only string carrier
 * values are copied — `traceparent`/`tracestate` are always strings — keeping
 * binary metadata keys out of the text carrier.
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
 * metadata, and a node-style callback. `@grpc/grpc-js`'s generated client
 * methods have this shape; a test passes a fake to exercise
 * {@link callWithTrace} without a live server.
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
  /** Fully-qualified RPC service, e.g. `signalman.coordinator.v1.Coordinator`. */
  rpcService: string;
  /** RPC method name as declared in the `.proto`, e.g. `Book`. */
  method: string;
  /** The request message. */
  request: object;
  /** The underlying gRPC call, invoked with the trace-carrying metadata. */
  invoke: RawUnaryInvoke<Reply>;
}

/**
 * Make one gRPC unary call inside a CLIENT span, injecting that span's trace
 * context into the outgoing metadata so the coordinator's SERVER span continues
 * the same booking trace. The span follows the OTel RPC semantic conventions
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
type ServiceClientClass = new (
  address: string,
  creds: ReturnType<typeof credentials.createInsecure>,
) => Client;

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
 * Build a traced {@link UnaryCall} for the coordinator: load its `.proto`,
 * construct an insecure gRPC client (connection is lazy, so the coordinator need
 * not be up yet), and return a function that invokes a unary method and resolves
 * with its reply, each call wrapped in a CLIENT span with the booking trace
 * injected.
 *
 * `longs: Number` decodes the `uint64 amount` field as a plain JS number,
 * matching how the coordinator serves it, so the gateway never sees a `Long`.
 */
export function createCoordinatorCall(options: CoordinatorCallOptions): UnaryCall {
  const definition = loadSync(COORDINATOR_PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = loadPackageDefinition(definition);
  const ServiceClass = resolveServiceClass(proto, COORDINATOR_GRPC_PACKAGE, COORDINATOR_GRPC_SERVICE);
  const client = new ServiceClass(options.url, credentials.createInsecure());
  const tracer = options.tracer ?? getTracer(DEFAULT_TRACER_SCOPE);
  const rpcService = `${COORDINATOR_GRPC_PACKAGE}.${COORDINATOR_GRPC_SERVICE}`;

  return <Reply>(method: string, request: object): Promise<Reply> => {
    const invoke = (client as unknown as Record<string, unknown>)[method];
    if (typeof invoke !== 'function') {
      return Promise.reject(
        new Error(`gRPC method ${method} not found on ${COORDINATOR_GRPC_SERVICE} client`),
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

/** Coordinator port over gRPC — maps {@link CoordinatorPort.book} onto the `Book` RPC. */
export class GrpcCoordinatorPort implements CoordinatorPort {
  constructor(private readonly call: UnaryCall) {}

  book(command: BookCommand): Promise<BookResult> {
    return this.call<BookResult>('Book', command);
  }
}
