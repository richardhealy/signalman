import type { LoggerService } from '@nestjs/common';
import {
  LOG_LEVEL_SEVERITY,
  formatLogRecord,
  type LogFields,
  type LogLevel,
  type TraceContextFields,
} from './log-record';
import { activeTraceContext } from './trace-context';

/** Destination for a rendered log line. Defaults to stdout; overridable in tests. */
export type LogSink = (line: string) => void;

/** Construction options for a {@link StructuredLogger}. */
export interface StructuredLoggerOptions {
  /** `service.name` stamped on every line. Required — it identifies the source. */
  service: string;
  /** Default component/"context" for lines that do not override it. */
  context?: string;
  /** Minimum severity to emit; anything lower is dropped. Defaults to `info`. */
  level?: LogLevel;
  /** Fields merged into every line (e.g. a bound `booking_id`). */
  fields?: LogFields;
  /** Where rendered lines go. Defaults to a stdout writer. */
  sink?: LogSink;
  /** Clock for timestamps. Defaults to `() => new Date()`; injected in tests. */
  clock?: () => Date;
  /** Source of trace correlation. Defaults to {@link activeTraceContext}. */
  traceContext?: () => TraceContextFields | undefined;
}

/** Default sink: one JSON object per line on stdout. */
const stdoutSink: LogSink = (line) => process.stdout.write(`${line}\n`);

/**
 * The result of normalising a method's loose `(...optionalParams)` tail into the
 * structured shape the record builder wants.
 */
interface NormalizedArgs {
  context?: string;
  fields?: LogFields;
}

/**
 * A structured, trace-correlated JSON logger that doubles as a NestJS
 * {@link LoggerService}.
 *
 * Every line is a single JSON object carrying `timestamp`, `level`, `service`,
 * the active `trace_id`/`span_id`/`trace_flags`, and any caller fields — the
 * correlation that lets a log in Grafana jump to the exact span (and booking)
 * it was written under.
 *
 * Two call styles are supported and can be mixed freely:
 *
 * - **Structured** (preferred in service code): pass a fields object,
 *   `logger.info('hold placed', { booking_id, qty })`.
 * - **NestJS** (so it drops into `app.useLogger(logger)`): the framework's
 *   `(message, ...optionalParams)` calls are normalised — a trailing string is
 *   read as the logging `context`, an object is merged into `fields`, and an
 *   `Error` contributes its message and stack.
 *
 * `error`/`fatal` additionally follow Nest's `(message, stack, context)`
 * convention: a leading extra string is treated as a pre-formatted stack.
 */
export class StructuredLogger implements LoggerService {
  private readonly service: string;
  private readonly context?: string;
  private readonly minSeverity: number;
  private readonly boundFields?: LogFields;
  private readonly sink: LogSink;
  private readonly clock: () => Date;
  private readonly traceContext: () => TraceContextFields | undefined;

  constructor(options: StructuredLoggerOptions) {
    this.service = options.service;
    this.context = options.context;
    this.minSeverity = LOG_LEVEL_SEVERITY[options.level ?? 'info'];
    this.boundFields = options.fields;
    this.sink = options.sink ?? stdoutSink;
    this.clock = options.clock ?? (() => new Date());
    this.traceContext = options.traceContext ?? activeTraceContext;
  }

  /**
   * Derive a child logger that inherits this logger's sink, clock, trace source
   * and level, with an overridden context and/or additional bound fields. Use it
   * to pin correlation for a unit of work, e.g.
   * `const log = base.child({ context: 'BookingSaga', fields: { booking_id } })`.
   */
  child(bindings: { context?: string; fields?: LogFields }): StructuredLogger {
    return new StructuredLogger({
      service: this.service,
      context: bindings.context ?? this.context,
      level: this.levelName(this.minSeverity),
      fields: { ...this.boundFields, ...bindings.fields },
      sink: this.sink,
      clock: this.clock,
      traceContext: this.traceContext,
    });
  }

  /** Emit at `debug` severity. Suppressed unless the logger's level allows it. */
  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  /** Emit at `info` severity (structured API). */
  info(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  /** NestJS `log` — an alias for {@link info}. */
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  /** NestJS `verbose` — mapped to `debug`, the lowest severity we model. */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  /** Emit at `warn` severity. */
  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  /** Emit at `error` severity. Follows Nest's `(message, stack, context)` tail. */
  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams, { leadingStringIsStack: true });
  }

  /** NestJS `fatal` — mapped to `error`, the highest severity we model. */
  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams, { leadingStringIsStack: true });
  }

  private emit(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
    opts: { leadingStringIsStack?: boolean } = {},
  ): void {
    if (LOG_LEVEL_SEVERITY[level] < this.minSeverity) {
      return;
    }

    const { text, errorFields } = this.normalizeMessage(message);
    const { context, fields } = this.normalizeParams(optionalParams, opts);

    const merged: LogFields = { ...this.boundFields, ...errorFields, ...fields };

    this.sink(
      formatLogRecord({
        level,
        message: text,
        service: this.service,
        context: context ?? this.context,
        timestamp: this.clock(),
        trace: this.traceContext(),
        fields: Object.keys(merged).length > 0 ? merged : undefined,
      }),
    );
  }

  /** Turn the primary message argument into a string, lifting any `Error` detail. */
  private normalizeMessage(message: unknown): { text: string; errorFields?: LogFields } {
    if (message instanceof Error) {
      return { text: message.message, errorFields: { err: message } };
    }
    if (typeof message === 'string') {
      return { text: message };
    }
    return { text: String(message) };
  }

  /**
   * Collapse the loose `optionalParams` tail into `{ context, fields }`:
   * a trailing string becomes the `context`, objects are merged into `fields`,
   * an `Error` contributes an `err` field, and — for `error`/`fatal` — a leading
   * string is captured as a `stack` field per Nest's convention.
   */
  private normalizeParams(
    optionalParams: unknown[],
    opts: { leadingStringIsStack?: boolean },
  ): NormalizedArgs {
    const strings = optionalParams.filter((p): p is string => typeof p === 'string');
    let context: string | undefined;
    const fields: LogFields = {};

    if (opts.leadingStringIsStack && strings.length > 0) {
      fields.stack = strings[0];
      context = strings.length > 1 ? strings[strings.length - 1] : undefined;
    } else if (strings.length > 0) {
      context = strings[strings.length - 1];
    }

    for (const param of optionalParams) {
      if (param instanceof Error) {
        fields.err = param;
      } else if (param !== null && typeof param === 'object') {
        Object.assign(fields, param);
      }
    }

    return { context, fields: Object.keys(fields).length > 0 ? fields : undefined };
  }

  /** Inverse of {@link LOG_LEVEL_SEVERITY} lookup, for cloning a logger's level. */
  private levelName(severity: number): LogLevel {
    const found = (Object.keys(LOG_LEVEL_SEVERITY) as LogLevel[]).find(
      (level) => LOG_LEVEL_SEVERITY[level] === severity,
    );
    return found ?? 'info';
  }
}

/**
 * Convenience factory mirroring {@link StructuredLogger}'s constructor — reads
 * a touch better at call sites: `const logger = createLogger({ service })`.
 */
export function createLogger(options: StructuredLoggerOptions): StructuredLogger {
  return new StructuredLogger(options);
}
