import { buildLogRecord, formatLogRecord, type LogRecordInput } from './log-record';

const at = new Date('2026-06-28T12:00:00.000Z');

function base(overrides: Partial<LogRecordInput> = {}): LogRecordInput {
  return {
    level: 'info',
    message: 'hold placed',
    service: 'inventory',
    timestamp: at,
    ...overrides,
  };
}

describe('buildLogRecord', () => {
  it('orders identity fields first and renders the timestamp as ISO', () => {
    const record = buildLogRecord(base());

    expect(Object.keys(record)).toEqual(['timestamp', 'level', 'service', 'message']);
    expect(record).toMatchObject({
      timestamp: '2026-06-28T12:00:00.000Z',
      level: 'info',
      service: 'inventory',
      message: 'hold placed',
    });
  });

  it('includes the context only when provided', () => {
    expect(buildLogRecord(base())).not.toHaveProperty('context');
    expect(buildLogRecord(base({ context: 'BookingSaga' }))).toMatchObject({
      context: 'BookingSaga',
    });
  });

  it('emits trace correlation fields when a trace context is present', () => {
    const record = buildLogRecord(
      base({ trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), trace_flags: '01' } }),
    );

    expect(record).toMatchObject({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      trace_flags: '01',
    });
  });

  it('merges caller fields but never lets them overwrite reserved keys', () => {
    const record = buildLogRecord(
      base({ fields: { booking_id: 'bk_1', service: 'spoofed', trace_id: 'spoofed' } }),
    );

    expect(record.booking_id).toBe('bk_1');
    expect(record.service).toBe('inventory');
    expect(record).not.toHaveProperty('trace_id');
  });

  it('drops undefined-valued fields', () => {
    const record = buildLogRecord(base({ fields: { kept: 1, skipped: undefined } }));

    expect(record).toHaveProperty('kept', 1);
    expect(record).not.toHaveProperty('skipped');
  });
});

describe('formatLogRecord', () => {
  it('produces a single-line JSON string with no trailing newline', () => {
    const line = formatLogRecord(base());

    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toMatchObject({ level: 'info', message: 'hold placed' });
  });

  it('serialises an Error field into name/message/stack', () => {
    const error = new Error('psp timeout');
    const line = formatLogRecord(base({ level: 'error', fields: { err: error } }));

    expect(JSON.parse(line).err).toMatchObject({
      name: 'Error',
      message: 'psp timeout',
      stack: expect.stringContaining('psp timeout'),
    });
  });

  it('stringifies bigint fields rather than throwing', () => {
    const line = formatLogRecord(base({ fields: { amount_cents: 10n } }));

    expect(JSON.parse(line).amount_cents).toBe('10');
  });

  it('replaces circular references with a marker instead of crashing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    const line = formatLogRecord(base({ fields: { cyclic } }));

    expect(JSON.parse(line).cyclic).toMatchObject({ name: 'loop', self: '[Circular]' });
  });
});
