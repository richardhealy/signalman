import {
  context as otelContext,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

/**
 * Headers as they appear on broker messages. Different brokers model header
 * values differently — NATS exposes string arrays, Kafka uses `Buffer`s, and
 * most HTTP-style transports use plain strings — so the carrier accepts all
 * three shapes and the getter normalises them on read.
 */
export type BrokerHeaders = Record<string, string | string[] | Buffer | undefined>;

/**
 * The W3C Trace Context propagator. Held as a module-level singleton so the
 * helpers below work without a fully initialised OpenTelemetry SDK (handy in
 * unit tests and in services that only need cross-process trace continuity).
 */
const propagator = new W3CTraceContextPropagator();

const setter: TextMapSetter<BrokerHeaders> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<BrokerHeaders> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    const value = carrier[key];
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value[0];
    }
    if (Buffer.isBuffer(value)) {
      return value.toString('utf8');
    }
    return value;
  },
};

/**
 * Inject the `traceparent` (and `tracestate`, when present) of the given
 * context into broker message headers so a downstream consumer can join the
 * same trace instead of starting an orphan.
 *
 * @param ctx - the context to serialise; typically the active context at publish time.
 * @param headers - an existing headers object to extend; a new one is created when omitted.
 * @returns the same headers object, mutated in place, for convenient chaining.
 */
export function injectContext(ctx: Context, headers: BrokerHeaders = {}): BrokerHeaders {
  propagator.inject(ctx, headers, setter);
  return headers;
}

/**
 * Extract a remote trace context from broker message headers. The returned
 * context carries the upstream span context (marked remote), ready to be used
 * as the parent of the consumer span.
 *
 * @param headers - the incoming broker message headers.
 * @param baseContext - the context to layer the extracted values onto; defaults to the active context.
 * @returns a context containing the extracted remote span context, if any.
 */
export function extractContext(
  headers: BrokerHeaders,
  baseContext: Context = otelContext.active(),
): Context {
  return propagator.extract(baseContext, headers, getter);
}
