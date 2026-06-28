/**
 * Wiring for the saga orchestrator — the coordinator's core.
 *
 * It binds the gRPC {@link CoordinatorController} to a {@link BookingSaga} whose
 * four legs are the real services reached over gRPC. Each leg port wraps a
 * {@link createUnaryCall} dialled at the service's address (env-overridable so
 * docker-compose can address services by name); connection is lazy, so the
 * coordinator boots even if a leg is not up yet and the first booking is what
 * forces the dial.
 *
 * The saga depends only on the {@link InventoryPort}-style interfaces, so a test
 * swaps these gRPC adapters for in-memory fakes behind the same
 * {@link BOOKING_SAGA} token; production wires the live legs here.
 */
import { Module } from '@nestjs/common';
import {
  GrpcInventoryPort,
  GrpcLedgerPort,
  GrpcPaymentsPort,
  GrpcSupplierPort,
  createUnaryCall,
} from '../grpc/leg-clients';
import {
  INVENTORY_GRPC_PACKAGE,
  INVENTORY_GRPC_SERVICE,
  INVENTORY_PROTO_PATH,
  LEDGER_GRPC_PACKAGE,
  LEDGER_GRPC_SERVICE,
  LEDGER_PROTO_PATH,
  PAYMENTS_GRPC_PACKAGE,
  PAYMENTS_GRPC_SERVICE,
  PAYMENTS_PROTO_PATH,
  SUPPLIER_GRPC_PACKAGE,
  SUPPLIER_GRPC_SERVICE,
  SUPPLIER_PROTO_PATH,
} from '../proto';
import { BookingSaga } from './booking-saga';
import { CoordinatorController } from './coordinator.controller';

/** Where each leg is dialled; env-overridable so compose can address by name. */
const INVENTORY_URL = process.env.INVENTORY_GRPC_URL ?? 'localhost:50051';
const PAYMENTS_URL = process.env.PAYMENTS_GRPC_URL ?? 'localhost:50052';
const SUPPLIER_URL = process.env.SUPPLIER_GRPC_URL ?? 'localhost:50053';
const LEDGER_URL = process.env.LEDGER_GRPC_URL ?? 'localhost:50054';

/** Build the saga with each leg wired to its live gRPC service. */
function createGrpcSaga(): BookingSaga {
  const inventory = new GrpcInventoryPort(
    createUnaryCall({
      protoPath: INVENTORY_PROTO_PATH,
      package: INVENTORY_GRPC_PACKAGE,
      service: INVENTORY_GRPC_SERVICE,
      url: INVENTORY_URL,
    }),
  );
  const payments = new GrpcPaymentsPort(
    createUnaryCall({
      protoPath: PAYMENTS_PROTO_PATH,
      package: PAYMENTS_GRPC_PACKAGE,
      service: PAYMENTS_GRPC_SERVICE,
      url: PAYMENTS_URL,
    }),
  );
  const supplier = new GrpcSupplierPort(
    createUnaryCall({
      protoPath: SUPPLIER_PROTO_PATH,
      package: SUPPLIER_GRPC_PACKAGE,
      service: SUPPLIER_GRPC_SERVICE,
      url: SUPPLIER_URL,
    }),
  );
  const ledger = new GrpcLedgerPort(
    createUnaryCall({
      protoPath: LEDGER_PROTO_PATH,
      package: LEDGER_GRPC_PACKAGE,
      service: LEDGER_GRPC_SERVICE,
      url: LEDGER_URL,
    }),
  );
  return new BookingSaga({ inventory, payments, supplier, ledger });
}

@Module({
  controllers: [CoordinatorController],
  providers: [{ provide: BookingSaga, useFactory: createGrpcSaga }],
})
export class SagaModule {}
