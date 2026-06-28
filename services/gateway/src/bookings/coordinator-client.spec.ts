import { Metadata } from '@grpc/grpc-js';
import {
  ROOT_CONTEXT,
  SpanKind,
  context as otelContext,
  trace,
  TraceFlags,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  GrpcCoordinatorPort,
  callWithTrace,
  injectTraceMetadata,
  type RawUnaryInvoke,
  type UnaryCall,
} from './coordinator-client';
import { type BookCommand, type BookResult } from './coordinator-port';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const RPC_SERVICE = 'signalman.coordinator.v1.Coordinator';

function sampledContext() {
  const spanContext: SpanContext = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED };
  return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}

/** Read the parent span id off a 2.x (`parentSpanContext`) or older (`parentSpanId`) span. */
function parentSpanId(span: ReadableSpan): string | undefined {
  const s = span as unknown as {
    parentSpanContext?: { spanId: string };
    parentSpanId?: string;
  };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

const COMMAND: BookCommand = {
  bookingId: 'bk_1',
  sku: 'seat-economy',
  qty: 2,
  amount: 4200,
  currency: 'USD',
};

const REPLY: BookResult = {
  booked: true,
  holdId: 'hold_1',
  authorizationId: 'auth_1',
  confirmationId: 'conf_1',
  captureId: 'cap_1',
  entryId: 'entry_1',
  failedStep: '',
  reason: '',
  compensated: false,
};

describe('injectTraceMetadata', () => {
  it('writes the traceparent of the given context into gRPC metadata', () => {
    const metadata = injectTraceMetadata(sampledContext());

    expect(metadata.get('traceparent')).toEqual([`00-${TRACE_ID}-${SPAN_ID}-01`]);
  });

  it('writes nothing for a context without a valid span', () => {
    const metadata = injectTraceMetadata(ROOT_CONTEXT);

    expect(metadata.get('traceparent')).toEqual([]);
  });

  it('extends a provided metadata object', () => {
    const existing = new Metadata();
    existing.set('authorization', 'bearer t');

    const metadata = injectTraceMetadata(sampledContext(), existing);

    expect(metadata).toBe(existing);
    expect(metadata.get('authorization')).toEqual(['bearer t']);
    expect(metadata.get('traceparent')).toEqual([`00-${TRACE_ID}-${SPAN_ID}-01`]);
  });
});

describe('callWithTrace (mechanics)', () => {
  const tracer = trace.getTracer('test');

  it('passes the request and a metadata object to the invoke and resolves with the reply', async () => {
    let seen: { request: object; metadata: Metadata } | undefined;
    const invoke: RawUnaryInvoke<BookResult> = (request, metadata, callback) => {
      seen = { request, metadata };
      callback(null, REPLY);
    };

    const reply = await callWithTrace<BookResult>({
      tracer,
      rpcService: RPC_SERVICE,
      method: 'Book',
      request: COMMAND,
      invoke,
    });

    expect(reply).toBe(REPLY);
    expect(seen?.request).toBe(COMMAND);
    expect(seen?.metadata).toBeInstanceOf(Metadata);
  });

  it('rejects with the transport error when the invoke fails', async () => {
    const invoke: RawUnaryInvoke<BookResult> = (_request, _metadata, callback) => {
      callback(new Error('unavailable'), undefined as unknown as BookResult);
    };

    await expect(
      callWithTrace<BookResult>({
        tracer,
        rpcService: RPC_SERVICE,
        method: 'Book',
        request: COMMAND,
        invoke,
      }),
    ).rejects.toThrow('unavailable');
  });
});

describe('callWithTrace (trace continuity)', () => {
  let contextManager: AsyncLocalStorageContextManager;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    tracer = provider.getTracer('test');
  });

  afterEach(async () => {
    contextManager.disable();
    otelContext.disable();
    await provider.shutdown();
  });

  it('opens a CLIENT span under the active parent and injects that trace into the metadata', async () => {
    let carried: Metadata | undefined;
    const invoke: RawUnaryInvoke<BookResult> = (_request, metadata, callback) => {
      carried = metadata;
      callback(null, REPLY);
    };

    // The gateway's HTTP SERVER span is the active parent when the call is made.
    const parent = tracer.startSpan('POST /bookings');
    await otelContext.with(trace.setSpan(otelContext.active(), parent), () =>
      callWithTrace<BookResult>({ tracer, rpcService: RPC_SERVICE, method: 'Book', request: COMMAND, invoke }),
    );
    parent.end();

    // The injected traceparent continues the parent's trace.
    const traceparent = carried?.get('traceparent')?.[0] as string | undefined;
    expect(traceparent).toBeDefined();
    expect(traceparent).toContain(`00-${parent.spanContext().traceId}-`);

    // The CLIENT span is a child of the parent, with the RPC semconv attributes.
    const client = exporter.getFinishedSpans().find((s) => s.name === `${RPC_SERVICE}/Book`);
    expect(client).toBeDefined();
    expect(client!.kind).toBe(SpanKind.CLIENT);
    expect(client!.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(parentSpanId(client!)).toBe(parent.spanContext().spanId);
    expect(client!.attributes['rpc.system']).toBe('grpc');
    expect(client!.attributes['rpc.service']).toBe(RPC_SERVICE);
    expect(client!.attributes['rpc.method']).toBe('Book');
  });
});

describe('GrpcCoordinatorPort', () => {
  it('maps book onto the Book unary call and returns its reply', async () => {
    const calls: Array<{ method: string; request: object }> = [];
    const call: UnaryCall = async <Reply>(method: string, request: object): Promise<Reply> => {
      calls.push({ method, request });
      return REPLY as unknown as Reply;
    };

    const port = new GrpcCoordinatorPort(call);
    const reply = await port.book(COMMAND);

    expect(reply).toBe(REPLY);
    expect(calls).toEqual([{ method: 'Book', request: COMMAND }]);
  });
});
