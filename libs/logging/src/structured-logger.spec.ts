import { StructuredLogger, createLogger, type StructuredLoggerOptions } from './structured-logger';
import type { TraceContextFields } from './log-record';

const at = new Date('2026-06-28T12:00:00.000Z');

const TRACE: TraceContextFields = {
  trace_id: 'a'.repeat(32),
  span_id: 'b'.repeat(16),
  trace_flags: '01',
};

interface Harness {
  logger: StructuredLogger;
  lines: () => Record<string, unknown>[];
}

function makeLogger(overrides: Partial<StructuredLoggerOptions> = {}): Harness {
  const captured: string[] = [];
  const logger = createLogger({
    service: 'coordinator',
    clock: () => at,
    sink: (line) => captured.push(line),
    traceContext: () => undefined,
    ...overrides,
  });
  return { logger, lines: () => captured.map((line) => JSON.parse(line)) };
}

describe('StructuredLogger — levels and thresholds', () => {
  it('emits info with service and timestamp by default', () => {
    const { logger, lines } = makeLogger();

    logger.info('coordinating booking');

    expect(lines()).toEqual([
      {
        timestamp: '2026-06-28T12:00:00.000Z',
        level: 'info',
        service: 'coordinator',
        message: 'coordinating booking',
      },
    ]);
  });

  it('suppresses debug at the default info level', () => {
    const { logger, lines } = makeLogger();

    logger.debug('verbose detail');

    expect(lines()).toHaveLength(0);
  });

  it('emits debug once the level is lowered', () => {
    const { logger, lines } = makeLogger({ level: 'debug' });

    logger.debug('verbose detail');

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: 'debug', message: 'verbose detail' });
  });

  it('still emits errors when the threshold is raised to error', () => {
    const { logger, lines } = makeLogger({ level: 'error' });

    logger.warn('a warning');
    logger.error('a failure');

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ level: 'error', message: 'a failure' });
  });
});

describe('StructuredLogger — structured fields', () => {
  it('merges a fields object into the line', () => {
    const { logger, lines } = makeLogger();

    logger.info('hold placed', { booking_id: 'bk_1', qty: 2 });

    expect(lines()[0]).toMatchObject({ booking_id: 'bk_1', qty: 2 });
  });

  it('stamps bound fields and context on every line', () => {
    const { logger, lines } = makeLogger({ context: 'BookingSaga', fields: { region: 'eu' } });

    logger.info('step done');

    expect(lines()[0]).toMatchObject({ context: 'BookingSaga', region: 'eu' });
  });
});

describe('StructuredLogger — trace correlation', () => {
  it('stamps trace ids when a span is active', () => {
    const { logger, lines } = makeLogger({ traceContext: () => TRACE });

    logger.info('inside a span');

    expect(lines()[0]).toMatchObject(TRACE);
  });

  it('omits trace ids when no span is active', () => {
    const { logger, lines } = makeLogger();

    logger.info('outside any span');

    expect(lines()[0]).not.toHaveProperty('trace_id');
  });
});

describe('StructuredLogger — child loggers', () => {
  it('inherits sink/clock/level and merges context and fields', () => {
    const { logger, lines } = makeLogger({ fields: { region: 'eu' } });

    const child = logger.child({ context: 'Payments', fields: { booking_id: 'bk_2' } });
    child.info('authorized');

    expect(lines()[0]).toMatchObject({
      context: 'Payments',
      region: 'eu',
      booking_id: 'bk_2',
      message: 'authorized',
    });
  });

  it('does not leak child fields back to the parent', () => {
    const { logger, lines } = makeLogger();

    logger.child({ fields: { booking_id: 'bk_3' } });
    logger.info('parent line');

    expect(lines()[0]).not.toHaveProperty('booking_id');
  });
});

describe('StructuredLogger — NestJS LoggerService compatibility', () => {
  it('maps log() to info and verbose() to debug', () => {
    const { logger, lines } = makeLogger({ level: 'debug' });

    logger.log('via log');
    logger.verbose('via verbose');

    expect(lines()[0]).toMatchObject({ level: 'info', message: 'via log' });
    expect(lines()[1]).toMatchObject({ level: 'debug', message: 'via verbose' });
  });

  it('reads a trailing string param as the context', () => {
    const { logger, lines } = makeLogger();

    logger.log('booting', 'Bootstrap');

    expect(lines()[0]).toMatchObject({ message: 'booting', context: 'Bootstrap' });
  });

  it('lifts an Error message and stack onto the record', () => {
    const { logger, lines } = makeLogger();

    logger.error(new Error('psp timeout'));

    expect(lines()[0]).toMatchObject({ level: 'error', message: 'psp timeout' });
    expect((lines()[0].err as Record<string, unknown>).message).toBe('psp timeout');
  });

  it('follows Nest (message, stack, context) for error()', () => {
    const { logger, lines } = makeLogger();

    logger.error('booking failed', 'Error: boom\n  at x', 'BookingSaga');

    expect(lines()[0]).toMatchObject({
      level: 'error',
      message: 'booking failed',
      context: 'BookingSaga',
      stack: 'Error: boom\n  at x',
    });
  });
});
