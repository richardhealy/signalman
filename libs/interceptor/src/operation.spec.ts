import { SpanKind, trace } from '@opentelemetry/api';
import { type ExecutionContext } from '@nestjs/common';
import { resolveOperation, resolveParentContext } from './operation';

interface ContextParts {
  type?: 'http' | 'rpc' | 'ws';
  controllerName?: string;
  handlerName?: string;
  request?: unknown;
}

/** Build a minimal ExecutionContext stub for the bits resolveOperation reads. */
function makeContext({
  type = 'http',
  controllerName = 'InventoryController',
  handlerName = 'hold',
  request,
}: ContextParts): ExecutionContext {
  const controller = { name: controllerName };
  const handler = { name: handlerName };
  return {
    getType: () => type,
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('resolveOperation', () => {
  it('maps an HTTP request to a SERVER span named "<method> <route>"', () => {
    const op = resolveOperation(
      makeContext({ type: 'http', request: { method: 'POST', route: { path: '/bookings' } } }),
    );

    expect(op.kind).toBe(SpanKind.SERVER);
    expect(op.name).toBe('POST /bookings');
    expect(op.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/bookings',
      'code.function.name': 'InventoryController.hold',
    });
    expect(op.metricAttributes).toEqual({
      operation: 'InventoryController.hold',
      'http.request.method': 'POST',
      'http.route': '/bookings',
    });
  });

  it('falls back to the handler name when HTTP route metadata is absent', () => {
    const op = resolveOperation(makeContext({ type: 'http', request: undefined }));

    expect(op.name).toBe('InventoryController.hold');
    expect(op.attributes).toEqual({ 'code.function.name': 'InventoryController.hold' });
    expect(op.metricAttributes).toEqual({ operation: 'InventoryController.hold' });
  });

  it('maps a gRPC handler to an RPC SERVER span with rpc.* attributes', () => {
    const op = resolveOperation(
      makeContext({ type: 'rpc', controllerName: 'Inventory', handlerName: 'Hold' }),
    );

    expect(op.kind).toBe(SpanKind.SERVER);
    expect(op.name).toBe('Inventory/Hold');
    expect(op.attributes).toEqual({
      'rpc.system': 'grpc',
      'rpc.service': 'Inventory',
      'rpc.method': 'Hold',
      'code.function.name': 'Inventory.Hold',
    });
    expect(op.metricAttributes).toEqual({
      operation: 'Inventory/Hold',
      'rpc.system': 'grpc',
      'rpc.service': 'Inventory',
      'rpc.method': 'Hold',
    });
  });

  it('falls back to an INTERNAL span for unrecognised transports', () => {
    const op = resolveOperation(
      makeContext({ type: 'ws', controllerName: 'Gateway', handlerName: 'onEvent' }),
    );

    expect(op.kind).toBe(SpanKind.INTERNAL);
    expect(op.name).toBe('Gateway.onEvent');
    expect(op.metricAttributes).toEqual({ operation: 'Gateway.onEvent' });
  });
});

describe('resolveParentContext', () => {
  // A well-formed W3C traceparent (the example from the spec): version-traceid-spanid-flags.
  const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const SPAN_ID = 'b7ad6b7169203331';

  /** A gRPC ExecutionContext whose request metadata is the given header map. */
  function rpcContext(map: Record<string, string | Buffer>): ExecutionContext {
    return {
      getType: () => 'rpc',
      getClass: () => ({ name: 'Inventory' }),
      getHandler: () => ({ name: 'Hold' }),
      switchToRpc: () => ({ getContext: () => ({ getMap: () => map }) }),
    } as unknown as ExecutionContext;
  }

  it('lifts the upstream traceparent from gRPC metadata as the parent span context', () => {
    const ctx = resolveParentContext(rpcContext({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` }));

    const parent = trace.getSpanContext(ctx);
    expect(parent?.traceId).toBe(TRACE_ID);
    expect(parent?.spanId).toBe(SPAN_ID);
    // Marked remote so the SDK knows the parent lives in another process.
    expect(parent?.isRemote).toBe(true);
  });

  it('returns the active context (a root) for a gRPC call carrying no traceparent', () => {
    expect(trace.getSpanContext(resolveParentContext(rpcContext({})))).toBeUndefined();
  });

  it('returns the active context for a non-RPC (HTTP) handler — the gateway is the trace root', () => {
    const ctx = resolveParentContext(makeContext({ type: 'http', request: undefined }));
    expect(trace.getSpanContext(ctx)).toBeUndefined();
  });

  it('returns the active context when the RPC context exposes no metadata map', () => {
    const noMetadata = {
      getType: () => 'rpc',
      switchToRpc: () => ({ getContext: () => undefined }),
    } as unknown as ExecutionContext;
    expect(trace.getSpanContext(resolveParentContext(noMetadata))).toBeUndefined();
  });
});
