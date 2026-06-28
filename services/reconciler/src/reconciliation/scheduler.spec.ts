import { ReconciliationScheduler } from './scheduler';
import { type ReconcileReport, type ReconcilerService } from './reconciler.service';

function report(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
  return { bookingsScanned: 0, divergencesFound: 0, findingsCreated: [], alreadyKnown: 0, ...overrides };
}

function fakeLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ReconciliationScheduler', () => {
  describe('tick', () => {
    it('runs a pass and warns when new divergences are found', async () => {
      const service = { runOnce: jest.fn().mockResolvedValue(report({ bookingsScanned: 2, findingsCreated: [{} as never], alreadyKnown: 1 })) };
      const logger = fakeLogger();
      const scheduler = new ReconciliationScheduler({ service: service as unknown as ReconcilerService, logger });

      await scheduler.tick();

      expect(service.runOnce).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]![0]).toContain('1 new divergence');
    });

    it('runs a pass and logs at debug when there is nothing new', async () => {
      const service = { runOnce: jest.fn().mockResolvedValue(report({ bookingsScanned: 3 })) };
      const logger = fakeLogger();
      const scheduler = new ReconciliationScheduler({ service: service as unknown as ReconcilerService, logger });

      await scheduler.tick();

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledTimes(1);
    });

    it('swallows a failed pass so the loop survives, logging the error', async () => {
      const service = { runOnce: jest.fn().mockRejectedValue(new Error('gateway down')) };
      const logger = fakeLogger();
      const scheduler = new ReconciliationScheduler({ service: service as unknown as ReconcilerService, logger });

      await expect(scheduler.tick()).resolves.toBeUndefined(); // does not throw
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error.mock.calls[0]![0]).toContain('gateway down');
    });
  });

  describe('start / stop', () => {
    it('schedules the pass on the configured interval, exactly once', () => {
      const service = { runOnce: jest.fn().mockResolvedValue(report()) };
      const setIntervalFn = jest.fn().mockReturnValue('handle-1');
      const scheduler = new ReconciliationScheduler({
        service: service as unknown as ReconcilerService,
        intervalMs: 5_000,
        setIntervalFn,
        logger: fakeLogger(),
      });

      scheduler.start();
      scheduler.start(); // idempotent

      expect(setIntervalFn).toHaveBeenCalledTimes(1);
      expect(setIntervalFn.mock.calls[0]![1]).toBe(5_000);
    });

    it('runs a pass when the interval fires', async () => {
      const service = { runOnce: jest.fn().mockResolvedValue(report()) };
      let fired: (() => void) | undefined;
      const setIntervalFn = jest.fn((handler: () => void) => {
        fired = handler;
        return 'handle-1';
      });
      const scheduler = new ReconciliationScheduler({
        service: service as unknown as ReconcilerService,
        setIntervalFn,
        logger: fakeLogger(),
      });

      scheduler.start();
      fired!();
      await flush();

      expect(service.runOnce).toHaveBeenCalledTimes(1);
    });

    it('clears the interval on stop and is idempotent', () => {
      const service = { runOnce: jest.fn().mockResolvedValue(report()) };
      const clearIntervalFn = jest.fn();
      const scheduler = new ReconciliationScheduler({
        service: service as unknown as ReconcilerService,
        setIntervalFn: jest.fn().mockReturnValue('handle-1'),
        clearIntervalFn,
        logger: fakeLogger(),
      });

      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // idempotent — no second clear

      expect(clearIntervalFn).toHaveBeenCalledTimes(1);
      expect(clearIntervalFn).toHaveBeenCalledWith('handle-1');
    });
  });
});
