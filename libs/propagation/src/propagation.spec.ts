import {
  ROOT_CONTEXT,
  trace,
  TraceFlags,
  type SpanContext,
} from '@opentelemetry/api';
import { extractContext, injectContext, type BrokerHeaders } from './propagation';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

function sampledSpanContext(): SpanContext {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceFlags: TraceFlags.SAMPLED,
  };
}

function contextWithSpan(spanContext: SpanContext) {
  return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}

describe('propagation', () => {
  describe('injectContext', () => {
    it('writes a W3C traceparent header for a sampled span context', () => {
      const headers = injectContext(contextWithSpan(sampledSpanContext()));

      expect(headers.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    });

    it('returns a fresh headers object when none is provided', () => {
      const headers = injectContext(contextWithSpan(sampledSpanContext()));

      expect(typeof headers).toBe('object');
      expect(headers).not.toBeNull();
    });

    it('mutates and returns the provided headers, preserving existing entries', () => {
      const existing: BrokerHeaders = { 'content-type': 'application/json' };

      const headers = injectContext(contextWithSpan(sampledSpanContext()), existing);

      expect(headers).toBe(existing);
      expect(headers['content-type']).toBe('application/json');
      expect(headers.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    });

    it('writes nothing for a context without a valid span context', () => {
      const headers = injectContext(ROOT_CONTEXT);

      expect(headers.traceparent).toBeUndefined();
    });
  });

  describe('extractContext', () => {
    it('recovers a remote span context from a traceparent header', () => {
      const headers: BrokerHeaders = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` };

      const extracted = extractContext(headers);
      const spanContext = trace.getSpanContext(extracted);

      expect(spanContext?.traceId).toBe(TRACE_ID);
      expect(spanContext?.spanId).toBe(SPAN_ID);
      expect(spanContext?.traceFlags).toBe(TraceFlags.SAMPLED);
      expect(spanContext?.isRemote).toBe(true);
    });

    it('yields no valid span context for empty headers', () => {
      const extracted = extractContext({});

      expect(trace.getSpanContext(extracted)).toBeUndefined();
    });

    it('reads Buffer-valued headers (Kafka-style carriers)', () => {
      const headers: BrokerHeaders = {
        traceparent: Buffer.from(`00-${TRACE_ID}-${SPAN_ID}-01`, 'utf8'),
      };

      const spanContext = trace.getSpanContext(extractContext(headers));

      expect(spanContext?.traceId).toBe(TRACE_ID);
      expect(spanContext?.spanId).toBe(SPAN_ID);
    });

    it('reads the first value of array-valued headers (NATS-style carriers)', () => {
      const headers: BrokerHeaders = {
        traceparent: [`00-${TRACE_ID}-${SPAN_ID}-01`],
      };

      const spanContext = trace.getSpanContext(extractContext(headers));

      expect(spanContext?.traceId).toBe(TRACE_ID);
      expect(spanContext?.spanId).toBe(SPAN_ID);
    });
  });

  describe('round trip', () => {
    it('injects then extracts the same trace and span ids across the broker boundary', () => {
      const headers = injectContext(contextWithSpan(sampledSpanContext()));

      const spanContext = trace.getSpanContext(extractContext(headers));

      expect(spanContext?.traceId).toBe(TRACE_ID);
      expect(spanContext?.spanId).toBe(SPAN_ID);
      expect(spanContext?.isRemote).toBe(true);
    });
  });
});
