import { TraceFlags, trace, type SpanContext } from '@opentelemetry/api';
import { activeTraceContext, traceContextFields } from './trace-context';

const VALID: SpanContext = {
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  traceFlags: TraceFlags.SAMPLED,
  isRemote: false,
};

describe('traceContextFields', () => {
  it('projects a valid span context onto flat correlation fields', () => {
    expect(traceContextFields(VALID)).toEqual({
      trace_id: 'a'.repeat(32),
      span_id: 'b'.repeat(16),
      trace_flags: '01',
    });
  });

  it('formats unsampled trace flags as two hex digits', () => {
    expect(traceContextFields({ ...VALID, traceFlags: TraceFlags.NONE })?.trace_flags).toBe('00');
  });

  it('returns undefined for an undefined context', () => {
    expect(traceContextFields(undefined)).toBeUndefined();
  });

  it('returns undefined for the all-zero (invalid) context', () => {
    const invalid: SpanContext = {
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: TraceFlags.NONE,
    };
    expect(traceContextFields(invalid)).toBeUndefined();
  });
});

describe('activeTraceContext', () => {
  it('returns undefined when no span is active', () => {
    expect(activeTraceContext()).toBeUndefined();
  });

  it('reads correlation from the active span', () => {
    const span = trace.wrapSpanContext(VALID);
    const spy = jest.spyOn(trace, 'getActiveSpan').mockReturnValue(span);

    try {
      expect(activeTraceContext()).toEqual({
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        trace_flags: '01',
      });
    } finally {
      spy.mockRestore();
    }
  });
});
