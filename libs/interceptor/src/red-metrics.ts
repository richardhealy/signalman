/**
 * The RED metrics for a server operation: **R**ate, **E**rrors, **D**uration.
 *
 * A single duration {@link Histogram} carries Rate (its observation count) and
 * Duration (its distribution); a companion error {@link Counter} makes the
 * error rate cheap to alert on without filtering the histogram. Both are tagged
 * with the same low-cardinality attribute set (the operation, its transport,
 * and the outcome) so a dashboard can pivot every signal by the same
 * dimensions. Per-step SLOs in the spec are computed from these series.
 */
import { type Attributes, type Counter, type Histogram, type Meter } from '@opentelemetry/api';

/** Metric name prefix used when a caller does not override it. */
export const DEFAULT_METRIC_PREFIX = 'signalman';

/** Terminal outcome of an operation, recorded as the `outcome` dimension. */
export type Outcome = 'success' | 'error';

/** Inputs for constructing a {@link RedMetrics} bundle. */
export interface RedMetricsOptions {
  /** Meter the instruments are created from, e.g. `getMeter('inventory')`. */
  meter: Meter;
  /** Metric name prefix; defaults to {@link DEFAULT_METRIC_PREFIX}. */
  prefix?: string;
}

/**
 * A bundle of the instruments that make up the RED method for one service.
 *
 * Construct it once per instrumentation scope and call {@link RedMetrics.record}
 * each time an operation finishes. The histogram is in **seconds**, matching the
 * OpenTelemetry convention for `*.duration` instruments.
 */
export class RedMetrics {
  /** Duration distribution; its count is the request rate. */
  private readonly duration: Histogram;
  /** Count of operations that ended in an error. */
  private readonly errors: Counter;

  constructor(options: RedMetricsOptions) {
    const prefix = options.prefix ?? DEFAULT_METRIC_PREFIX;
    this.duration = options.meter.createHistogram(`${prefix}.operation.duration`, {
      description:
        'Duration of a server operation in seconds (RED: rate via count, duration via distribution).',
      unit: 's',
    });
    this.errors = options.meter.createCounter(`${prefix}.operation.errors`, {
      description: 'Number of server operations that ended in an error (RED: errors).',
      unit: '{operation}',
    });
  }

  /**
   * Record one finished operation. Always observes the duration; additionally
   * increments the error counter when the outcome is an error. The `outcome`
   * attribute is added to both instruments so success and error series share a
   * single histogram.
   *
   * @param durationSeconds - wall-clock duration of the operation, in seconds.
   * @param outcome - whether the operation succeeded or errored.
   * @param attributes - low-cardinality dimensions (operation, transport, ...).
   */
  record(durationSeconds: number, outcome: Outcome, attributes: Attributes = {}): void {
    const tagged = { ...attributes, outcome };
    this.duration.record(durationSeconds, tagged);
    if (outcome === 'error') {
      this.errors.add(1, tagged);
    }
  }
}
