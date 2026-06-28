import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { BookingSaga, type BookCommand } from './booking-saga';
import type {
  InventoryPort,
  LedgerPort,
  PaymentsPort,
  SupplierPort,
} from './ports';

const ATTR_BOOKING_ID = 'signalman.booking.id';
const ATTR_SAGA_STEP = 'signalman.saga.step';
const ATTR_SAGA_COMPENSATION = 'signalman.saga.compensation';
const ATTR_SAGA_OUTCOME = 'signalman.saga.outcome';
const ATTR_SAGA_REASON = 'signalman.saga.reason';
const ATTR_ERROR_TYPE = 'error.type';

const COMMAND: BookCommand = {
  bookingId: 'bk_1',
  sku: 'seat-economy',
  qty: 2,
  amount: 4200,
  currency: 'USD',
};

/** An error with a stable `name`, so the saga's `error.type` is assertable. */
class PartnerUnavailableError extends Error {
  override readonly name = 'PartnerUnavailableError';
}

/**
 * Four recording in-memory legs on their happy path. Every call appends its step
 * name to `log`, so a test asserts both that the right legs ran and the order
 * they ran in — including compensations, which must unwind in reverse. Tests
 * reassign a single method to inject a rejection or an outage.
 */
function happyLegs(): {
  log: string[];
  inventory: InventoryPort;
  payments: PaymentsPort;
  supplier: SupplierPort;
  ledger: LedgerPort;
} {
  const log: string[] = [];
  const inventory: InventoryPort = {
    async hold() {
      log.push('inventory.hold');
      return { held: true, holdId: 'hold_1', reason: '', available: 9 };
    },
    async release() {
      log.push('inventory.release');
      return { released: true, holdId: 'hold_1' };
    },
  };
  const payments: PaymentsPort = {
    async authorize() {
      log.push('payments.authorize');
      return { authorized: true, paymentId: 'pay_1', authorizationId: 'auth_1', reason: '' };
    },
    async capture() {
      log.push('payments.capture');
      return { captured: true, paymentId: 'pay_1', captureId: 'cap_1', reason: '' };
    },
    async voidAuthorization() {
      log.push('payments.void');
      return { voided: true, paymentId: 'pay_1' };
    },
  };
  const supplier: SupplierPort = {
    async confirm() {
      log.push('supplier.confirm');
      return { confirmed: true, confirmationId: 'conf_1', reason: '' };
    },
    async cancel() {
      log.push('supplier.cancel');
      return { cancelled: true, confirmationId: 'conf_1' };
    },
  };
  const ledger: LedgerPort = {
    async commit() {
      log.push('ledger.commit');
      return { committed: true, entryId: 'entry_1', reason: '' };
    },
    async reverse() {
      log.push('ledger.reverse');
      return { reversed: true, entryId: 'entry_1' };
    },
  };
  return { log, inventory, payments, supplier, ledger };
}

describe('BookingSaga', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let contextManager: AsyncLocalStorageContextManager;

  beforeEach(() => {
    // The saga sets each step's span active so the leg call runs inside it; in a
    // real service the NodeSDK registers this manager, so we mirror that here.
    contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);

    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    tracer = provider.getTracer('test');
  });

  afterEach(async () => {
    otelContext.disable();
    await provider.shutdown();
  });

  function spanByName(name: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find((s) => s.name === name);
    if (!span) {
      throw new Error(`span ${name} was not recorded`);
    }
    return span;
  }

  describe('happy path', () => {
    it('drives the five legs in order and returns every truth handle', async () => {
      const legs = happyLegs();
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toEqual({
        booked: true,
        holdId: 'hold_1',
        authorizationId: 'auth_1',
        confirmationId: 'conf_1',
        captureId: 'cap_1',
        entryId: 'entry_1',
      });
      expect(legs.log).toEqual([
        'inventory.hold',
        'payments.authorize',
        'supplier.confirm',
        'payments.capture',
        'ledger.commit',
      ]);
    });

    it('records one INTERNAL span per step, tagged with the booking and step', async () => {
      const legs = happyLegs();
      const saga = new BookingSaga({ ...legs, tracer });

      await saga.book(COMMAND);

      const names = exporter.getFinishedSpans().map((s) => s.name);
      expect(names).toEqual([
        'inventory.hold',
        'payments.authorize',
        'supplier.confirm',
        'payments.capture',
        'ledger.commit',
      ]);
      const hold = spanByName('inventory.hold');
      expect(hold.kind).toBe(SpanKind.INTERNAL);
      expect(hold.attributes[ATTR_BOOKING_ID]).toBe('bk_1');
      expect(hold.attributes[ATTR_SAGA_STEP]).toBe('inventory.hold');
      expect(hold.attributes[ATTR_SAGA_COMPENSATION]).toBeUndefined();
      expect(hold.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('passes the capture id through to the ledger commit', async () => {
      const legs = happyLegs();
      const commit = jest.spyOn(legs.ledger, 'commit');
      const saga = new BookingSaga({ ...legs, tracer });

      await saga.book(COMMAND);

      expect(commit).toHaveBeenCalledWith({
        bookingId: 'bk_1',
        amount: 4200,
        currency: 'USD',
        captureId: 'cap_1',
      });
    });
  });

  describe('first-step rejection', () => {
    it('returns the failure with nothing to compensate', async () => {
      const legs = happyLegs();
      legs.inventory.hold = async () => {
        legs.log.push('inventory.hold');
        return { held: false, holdId: '', reason: 'insufficient_stock', available: 0 };
      };
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toEqual({
        booked: false,
        failedStep: 'inventory.hold',
        reason: 'insufficient_stock',
        compensated: false,
      });
      expect(legs.log).toEqual(['inventory.hold']);
    });

    it('annotates the rejected step span with the outcome and reason', async () => {
      const legs = happyLegs();
      legs.inventory.hold = async () => ({
        held: false,
        holdId: '',
        reason: 'insufficient_stock',
        available: 0,
      });
      const saga = new BookingSaga({ ...legs, tracer });

      await saga.book(COMMAND);

      const hold = spanByName('inventory.hold');
      expect(hold.attributes[ATTR_SAGA_OUTCOME]).toBe('rejected');
      expect(hold.attributes[ATTR_SAGA_REASON]).toBe('insufficient_stock');
      expect(hold.status.code).toBe(SpanStatusCode.UNSET);
    });

    it('falls back to a default reason when the leg gives none', async () => {
      const legs = happyLegs();
      legs.inventory.hold = async () => ({ held: false, holdId: '', reason: '', available: 0 });
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toMatchObject({ booked: false, reason: 'hold_rejected' });
    });
  });

  describe('mid-saga rejection', () => {
    it('unwinds the completed steps in reverse', async () => {
      const legs = happyLegs();
      legs.supplier.confirm = async () => {
        legs.log.push('supplier.confirm');
        return { confirmed: false, confirmationId: '', reason: 'partner_rejected' };
      };
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toEqual({
        booked: false,
        failedStep: 'supplier.confirm',
        reason: 'partner_rejected',
        compensated: true,
      });
      expect(legs.log).toEqual([
        'inventory.hold',
        'payments.authorize',
        'supplier.confirm',
        'payments.void',
        'inventory.release',
      ]);
    });

    it('flags compensation spans so the unwind is legible', async () => {
      const legs = happyLegs();
      legs.supplier.confirm = async () => ({
        confirmed: false,
        confirmationId: '',
        reason: 'partner_rejected',
      });
      const saga = new BookingSaga({ ...legs, tracer });

      await saga.book(COMMAND);

      const release = spanByName('inventory.release');
      expect(release.attributes[ATTR_SAGA_COMPENSATION]).toBe(true);
      expect(release.attributes[ATTR_BOOKING_ID]).toBe('bk_1');
      const voidSpan = spanByName('payments.void');
      expect(voidSpan.attributes[ATTR_SAGA_COMPENSATION]).toBe(true);
    });
  });

  describe('outage', () => {
    it('marks the step span errored and reports the error type as the reason', async () => {
      const legs = happyLegs();
      legs.payments.authorize = async () => {
        legs.log.push('payments.authorize');
        throw new PartnerUnavailableError('psp unreachable');
      };
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toEqual({
        booked: false,
        failedStep: 'payments.authorize',
        reason: 'PartnerUnavailableError',
        compensated: true,
      });
      // Only the hold preceded the outage, so only it unwinds.
      expect(legs.log).toEqual(['inventory.hold', 'payments.authorize', 'inventory.release']);

      const authorize = spanByName('payments.authorize');
      expect(authorize.status.code).toBe(SpanStatusCode.ERROR);
      expect(authorize.attributes[ATTR_ERROR_TYPE]).toBe('PartnerUnavailableError');
      expect(authorize.events.some((e) => e.name === 'exception')).toBe(true);
    });

    it('keeps unwinding when a compensation itself throws', async () => {
      const legs = happyLegs();
      legs.ledger.commit = async () => {
        legs.log.push('ledger.commit');
        throw new PartnerUnavailableError('ledger down');
      };
      legs.payments.voidAuthorization = async () => {
        legs.log.push('payments.void');
        throw new PartnerUnavailableError('void failed');
      };
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toMatchObject({ booked: false, failedStep: 'ledger.commit', compensated: true });
      // capture registers no compensation; the void throws but cancel + release
      // still run, because the unwind is best-effort over idempotent steps.
      expect(legs.log).toEqual([
        'inventory.hold',
        'payments.authorize',
        'supplier.confirm',
        'payments.capture',
        'ledger.commit',
        'supplier.cancel',
        'payments.void',
        'inventory.release',
      ]);
      const voidSpan = spanByName('payments.void');
      expect(voidSpan.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  describe('commit failure after capture', () => {
    it('unwinds confirm, auth, and hold but not the un-compensated capture', async () => {
      const legs = happyLegs();
      legs.ledger.commit = async () => {
        legs.log.push('ledger.commit');
        return { committed: false, entryId: '', reason: 'commit_rejected' };
      };
      const saga = new BookingSaga({ ...legs, tracer });

      const outcome = await saga.book(COMMAND);

      expect(outcome).toEqual({
        booked: false,
        failedStep: 'ledger.commit',
        reason: 'commit_rejected',
        compensated: true,
      });
      expect(legs.log).toEqual([
        'inventory.hold',
        'payments.authorize',
        'supplier.confirm',
        'payments.capture',
        'ledger.commit',
        'supplier.cancel',
        'payments.void',
        'inventory.release',
      ]);
    });
  });
});
