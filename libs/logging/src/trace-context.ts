import { isSpanContextValid, trace, type SpanContext } from '@opentelemetry/api';
import type { TraceContextFields } from './log-record';

/**
 * Project an OpenTelemetry {@link SpanContext} onto the flat trace-correlation
 * fields a log line carries. Returns `undefined` for a missing or invalid
 * context (e.g. the all-zero context of a non-recording span) so callers can
 * simply omit the fields rather than emit `00000…` ids.
 *
 * @param spanContext - the span context to read, or `undefined`.
 * @returns the `trace_id`/`span_id`/`trace_flags` fields, or `undefined`.
 */
export function traceContextFields(
  spanContext: SpanContext | undefined,
): TraceContextFields | undefined {
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return undefined;
  }
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags.toString(16).padStart(2, '0'),
  };
}

/**
 * Read trace correlation from the currently active span, if any. This is the
 * default source the {@link StructuredLogger} uses, so any log written inside a
 * saga step is automatically stamped with that step's `trace_id`/`span_id`.
 *
 * @returns the active span's correlation fields, or `undefined` when no span is active.
 */
export function activeTraceContext(): TraceContextFields | undefined {
  return traceContextFields(trace.getActiveSpan()?.spanContext());
}
