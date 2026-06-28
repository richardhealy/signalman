import { INVENTORY_GRPC_PACKAGE, INVENTORY_GRPC_SERVICE, INVENTORY_PROTO_PATH } from '../proto';
import {
  GrpcInventoryPort,
  GrpcLedgerPort,
  GrpcPaymentsPort,
  GrpcSupplierPort,
  createUnaryCall,
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
