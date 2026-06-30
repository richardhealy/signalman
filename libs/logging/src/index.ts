/**
 * @packageDocumentation
 * Structured JSON logging for Signalman services.
 *
 * Every log record carries the active W3C trace context fields
 * (`trace_id`, `span_id`, `trace_flags`) so log lines are
 * correlatable with their OpenTelemetry spans in Grafana.
 * Use {@link createLogger} to obtain a {@link StructuredLogger} instance.
 */
export {
  LOG_LEVEL_SEVERITY,
  buildLogRecord,
  formatLogRecord,
  type LogFields,
  type LogLevel,
  type LogRecordInput,
  type TraceContextFields,
} from './log-record';
export { activeTraceContext, traceContextFields } from './trace-context';
export {
  StructuredLogger,
  createLogger,
  type LogSink,
  type StructuredLoggerOptions,
} from './structured-logger';
