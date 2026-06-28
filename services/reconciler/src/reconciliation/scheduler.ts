/**
 * The periodic driver that turns the reconciler from a function into a running
 * process.
 *
 * The spec calls for a reconciler that *periodically* compares the sources of
 * truth. This scheduler is that cadence: it runs {@link ReconcilerService.runOnce}
 * on a fixed interval, logging a one-line summary of each pass and — importantly —
 * never letting a single failed pass kill the loop. A gateway hiccup is logged and
 * the next tick still fires, because reconciliation is a backstop that must keep
 * running precisely when something else is going wrong.
 *
 * The timer seam is injectable so a test can drive ticks deterministically; in
 * production it uses the global `setInterval`, whose handle also keeps the
 * application context's event loop alive (the reconciler has no transport holding
 * it open).
 */
import { Logger } from '@nestjs/common';
import { type ReconcilerService } from './reconciler.service';

/** A `setInterval`-shaped seam; returns an opaque handle passed back to {@link ClearInterval}. */
export type SetInterval = (handler: () => void, ms: number) => unknown;
/** A `clearInterval`-shaped seam. */
export type ClearInterval = (handle: unknown) => void;

/** Construction inputs for a {@link ReconciliationScheduler}. */
export interface ReconciliationSchedulerOptions {
  service: ReconcilerService;
  /** Pass interval in ms. Defaults to 30_000 (every 30s). */
  intervalMs?: number;
  /** `setInterval` seam; defaults to the global. Inject for deterministic tests. */
  setIntervalFn?: SetInterval;
  /** `clearInterval` seam; defaults to the global. */
  clearIntervalFn?: ClearInterval;
  /** Logger; defaults to a `ReconciliationScheduler`-scoped Nest logger. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
}

export class ReconciliationScheduler {
  private readonly service: ReconcilerService;
  private readonly intervalMs: number;
  private readonly setIntervalFn: SetInterval;
  private readonly clearIntervalFn: ClearInterval;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  private handle: unknown;

  constructor(options: ReconciliationSchedulerOptions) {
    this.service = options.service;
    this.intervalMs = options.intervalMs ?? 30_000;
    this.setIntervalFn = options.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as never));
    this.logger = options.logger ?? new Logger(ReconciliationScheduler.name);
  }

  /** Begin running reconciliation passes on the interval. Idempotent: a second call is a no-op. */
  start(): void {
    if (this.handle !== undefined) {
      return;
    }
    this.logger.log(`reconciliation scheduled every ${this.intervalMs}ms`);
    this.handle = this.setIntervalFn(() => void this.tick(), this.intervalMs);
  }

  /** Stop the scheduled passes. Idempotent: safe to call when not started. */
  stop(): void {
    if (this.handle === undefined) {
      return;
    }
    this.clearIntervalFn(this.handle);
    this.handle = undefined;
  }

  /**
   * Run a single reconciliation pass, catching and logging any error so the loop
   * survives it. Exposed so tests can drive a pass without a real timer; the
   * interval calls exactly this.
   */
  async tick(): Promise<void> {
    try {
      const report = await this.service.runOnce();
      if (report.findingsCreated.length > 0) {
        this.logger.warn(
          `reconciliation pass: ${report.findingsCreated.length} new divergence(s) across ` +
            `${report.bookingsScanned} booking(s) (${report.alreadyKnown} already known)`,
        );
      } else {
        this.logger.debug(
          `reconciliation pass: no new divergences across ${report.bookingsScanned} booking(s)`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`reconciliation pass failed: ${message}`);
    }
  }
}
