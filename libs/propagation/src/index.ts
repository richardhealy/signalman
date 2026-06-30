/**
 * @packageDocumentation
 * W3C trace-context propagation for Signalman broker messages.
 *
 * {@link injectContext} serialises the active OpenTelemetry span into a
 * `traceparent` broker header; {@link extractContext} restores it on the
 * consumer side so the upstream and downstream spans share one trace.
 */
export { injectContext, extractContext, type BrokerHeaders } from './propagation';
