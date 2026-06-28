/**
 * The four severities `signalman` services emit. They map onto a subset of the
 * OpenTelemetry log severity numbers so that a downstream Collector or backend
 * can order and filter records consistently with OTLP logs.
 *
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** OpenTelemetry severity numbers for each {@link LogLevel}, used for threshold filtering. */
export const LOG_LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 5, // DEBUG
  info: 9, // INFO
  warn: 13, // WARN
  error: 17, // ERROR
};

/**
 * Arbitrary structured context attached to a log line (booking id, attempt
 * number, an `Error`, ...). Values are serialised defensively so a rogue field
 * — a circular reference, a `bigint`, an `Error` — can never crash the logger.
 */
export type LogFields = Record<string, unknown>;

/**
 * The trace-correlation fields lifted from the active span. Emitting them on
 * every line is what lets a log in Grafana/Loki jump straight to the span (and
 * therefore the booking) it was written under.
 */
export interface TraceContextFields {
  trace_id: string;
  span_id: string;
  /** Two-hex-digit W3C trace flags, e.g. `01` when the trace is sampled. */
  trace_flags: string;
}

/** Everything needed to render one structured log line. */
export interface LogRecordInput {
  level: LogLevel;
  message: string;
  /** `service.name` of the emitting process. */
  service: string;
  /** Logical component within the service (the NestJS "context"), when set. */
  context?: string;
  /** When the record was created. */
  timestamp: Date;
  /** Active trace correlation, when the record was emitted inside a span. */
  trace?: TraceContextFields;
  /** Caller-supplied structured fields. */
  fields?: LogFields;
}

/**
 * Reserved top-level keys. A caller field that collides with one of these is
 * dropped rather than allowed to overwrite the record's own identity — better a
 * lost custom field than a corrupted `trace_id`.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'level',
  'service',
  'context',
  'message',
  'trace_id',
  'span_id',
  'trace_flags',
]);

/** Convert an `Error` into a plain, JSON-friendly shape that keeps the stack. */
function serializeError(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

/**
 * A `JSON.stringify` replacer that keeps a single bad field from taking down a
 * log line: `Error`s become readable objects, `bigint`s become strings, and
 * circular references are cut with a `"[Circular]"` marker.
 */
function safeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function replace(_key, value) {
    if (value instanceof Error) {
      return serializeError(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

/**
 * Assemble the ordered record object: identity fields first (timestamp, level,
 * service, context, message), then trace correlation, then any non-reserved
 * caller fields. Returned as a plain object so callers can inspect or re-route
 * it; {@link formatLogRecord} renders it to a line.
 */
export function buildLogRecord(input: LogRecordInput): Record<string, unknown> {
  const record: Record<string, unknown> = {
    timestamp: input.timestamp.toISOString(),
    level: input.level,
    service: input.service,
  };

  if (input.context) {
    record.context = input.context;
  }

  record.message = input.message;

  if (input.trace) {
    record.trace_id = input.trace.trace_id;
    record.span_id = input.trace.span_id;
    record.trace_flags = input.trace.trace_flags;
  }

  if (input.fields) {
    for (const [key, value] of Object.entries(input.fields)) {
      if (value !== undefined && !RESERVED_KEYS.has(key)) {
        record[key] = value;
      }
    }
  }

  return record;
}

/**
 * Render a record to a single-line JSON string (no trailing newline — the sink
 * owns line termination). Serialisation never throws: see {@link safeReplacer}.
 */
export function formatLogRecord(input: LogRecordInput): string {
  return JSON.stringify(buildLogRecord(input), safeReplacer());
}
