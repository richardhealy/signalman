import { SpanKind } from '@opentelemetry/api';
import { type ExecutionContext } from '@nestjs/common';
import { resolveOperation } from './operation';

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
