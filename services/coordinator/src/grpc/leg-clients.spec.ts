import { Metadata } from '@grpc/grpc-js';
import {
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { resolveParentContext } from '@signalman/interceptor';
import { type ExecutionContext } from '@nestjs/common';
import { INVENTORY_GRPC_PACKAGE, INVENTORY_GRPC_SERVICE, INVENTORY_PROTO_PATH } from '../proto';
import {
  GrpcInventoryPort,
  GrpcLedgerPort,
  GrpcPaymentsPort,
  GrpcSupplierPort,
  callWithTrace,
  createUnaryCall,
  injectTraceMetadata,
  type UnaryCall,
} from './leg-clients';

/** A UnaryCall that records every invocation and returns a canned reply. */
function recordingCall(reply: unknown): {
  call: UnaryCall;
  invocations: Array<{ method: string; request: object }>;
} {
  const invocations: Array<{ method: string; request: object }> = [];
  const call: UnaryCall = <Reply>(method: string, request: object): Promise<Reply> => {
    invocations.push({ method, request });
    return Promise.resolve(reply as Reply);
  };
  return { call, invocations };
}

describe('gRPC leg ports', () => {
  it('maps inventory hold/release onto the Hold and Release RPCs', async () => {
    const { call, invocations } = recordingCall({ held: true, holdId: 'h1', reason: '', available: 9 });
    const port = new GrpcInventoryPort(call);

    await port.hold({ bookingId: 'bk_1', sku: 'seat-economy', qty: 2 });
    await port.release({ bookingId: 'bk_1' });

    expect(invocations).toEqual([
      { method: 'Hold', request: { bookingId: 'bk_1', sku: 'seat-economy', qty: 2 } },
      { method: 'Release', request: { bookingId: 'bk_1' } },
    ]);
  });

  it('maps payments authorize/capture/void onto their RPCs', async () => {
    const { call, invocations } = recordingCall({ authorized: true });
    const port = new GrpcPaymentsPort(call);

    await port.authorize({ bookingId: 'bk_1', amount: 4200, currency: 'USD' });
    await port.capture({ bookingId: 'bk_1' });
    await port.voidAuthorization({ bookingId: 'bk_1' });

    expect(invocations.map((i) => i.method)).toEqual(['Authorize', 'Capture', 'Void']);
  });

  it('maps supplier confirm/cancel onto their RPCs', async () => {
    const { call, invocations } = recordingCall({ confirmed: true });
    const port = new GrpcSupplierPort(call);

    await port.confirm({ bookingId: 'bk_1', sku: 'seat-economy', qty: 2 });
    await port.cancel({ bookingId: 'bk_1' });

    expect(invocations.map((i) => i.method)).toEqual(['Confirm', 'Cancel']);
  });

  it('maps ledger commit/reverse onto their RPCs', async () => {
    const { call, invocations } = recordingCall({ committed: true });
    const port = new GrpcLedgerPort(call);

    await port.commit({ bookingId: 'bk_1', amount: 4200, currency: 'USD', captureId: 'cap_1' });
    await port.reverse({ bookingId: 'bk_1' });

    expect(invocations.map((i) => i.method)).toEqual(['Commit', 'Reverse']);
  });

  it('returns the reply the underlying call resolves with', async () => {
    const reply = { held: false, holdId: '', reason: 'insufficient_stock', available: 0 };
    const { call } = recordingCall(reply);

    await expect(new GrpcInventoryPort(call).hold({ bookingId: 'bk_1', sku: 's', qty: 1 })).resolves.toEqual(
      reply,
    );
  });

  describe('createUnaryCall', () => {
    it('rejects when the RPC method is not on the client (no server needed)', async () => {
      const call = createUnaryCall({
        protoPath: INVENTORY_PROTO_PATH,
        package: INVENTORY_GRPC_PACKAGE,
        service: INVENTORY_GRPC_SERVICE,
        url: 'localhost:50051',
      });

      await expect(call('NotARealMethod', {})).rejects.toThrow(/NotARealMethod not found/);
    });

    it('throws when the proto package/service does not resolve', () => {
      expect(() =>
        createUnaryCall({
          protoPath: INVENTORY_PROTO_PATH,
          package: 'signalman.nonexistent.v1',
          service: 'Nope',
          url: 'localhost:50051',
        }),
      ).toThrow(/not found in proto definition/);
    });
  });
});

describe('gRPC client tracing', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let contextManager: AsyncLocalStorageContextManager;

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

  function finishedSpan(): ReadableSpan {
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    return spans[0];
  }

  describe('injectTraceMetadata', () => {
    it('writes the active span trace context into gRPC metadata', () => {
      const span = tracer.startSpan('client');
      const ctx = trace.setSpan(otelContext.active(), span);

      const metadata = injectTraceMetadata(ctx);
      span.end();

      const traceparent = metadata.get('traceparent')[0] as string;
      expect(traceparent).toContain(span.spanContext().traceId);
      expect(traceparent).toContain(span.spanContext().spanId);
    });

    it('injects nothing for a context with no recording span', () => {
      const metadata = injectTraceMetadata(otelContext.active());
      expect(metadata.get('traceparent')).toHaveLength(0);
    });
  });

  describe('callWithTrace', () => {
    it('opens a CLIENT span and carries its trace context in the call metadata', async () => {
      let seen: Metadata | undefined;
      const reply = { held: true, holdId: 'h1' };

      const result = await callWithTrace<typeof reply>({
        tracer,
        rpcService: 'signalman.inventory.v1.Inventory',
        method: 'Hold',
        request: { bookingId: 'bk_1' },
        invoke: (_request, metadata, callback) => {
          seen = metadata;
          callback(null, reply);
        },
      });

      expect(result).toBe(reply);
      const span = finishedSpan();
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.name).toBe('signalman.inventory.v1.Inventory/Hold');
      expect(span.attributes).toMatchObject({
        'rpc.system': 'grpc',
        'rpc.service': 'signalman.inventory.v1.Inventory',
        'rpc.method': 'Hold',
      });
      const traceparent = seen!.get('traceparent')[0] as string;
      expect(traceparent).toContain(span.spanContext().traceId);
      expect(traceparent).toContain(span.spanContext().spanId);
    });

    it('marks the CLIENT span errored and rejects on a transport failure', async () => {
      const boom = new Error('14 UNAVAILABLE');

      await expect(
        callWithTrace({
          tracer,
          rpcService: 'signalman.inventory.v1.Inventory',
          method: 'Hold',
          request: {},
          invoke: (_request, _metadata, callback) => callback(boom, undefined),
        }),
      ).rejects.toBe(boom);

      const span = finishedSpan();
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('14 UNAVAILABLE');
      expect(span.events.map((e) => e.name)).toContain('exception');
    });

    it('propagates the trace end to end: the leg SERVER parent is the CLIENT span', async () => {
      let metadata: Metadata | undefined;
      await callWithTrace({
        tracer,
        rpcService: 'signalman.inventory.v1.Inventory',
        method: 'Hold',
        request: {},
        invoke: (_request, carrier, callback) => {
          metadata = carrier;
          callback(null, {});
        },
      });
      const clientSpan = finishedSpan();

      // Feed the very metadata the client produced into the SERVER-side
      // extractor: the leg's parent must be this CLIENT span, in its trace.
      const inboundRpc = {
        getType: () => 'rpc',
        switchToRpc: () => ({ getContext: () => metadata }),
      } as unknown as ExecutionContext;
      const parent = trace.getSpanContext(resolveParentContext(inboundRpc));

      expect(parent?.traceId).toBe(clientSpan.spanContext().traceId);
      expect(parent?.spanId).toBe(clientSpan.spanContext().spanId);
      expect(parent?.isRemote).toBe(true);
    });
  });
});
