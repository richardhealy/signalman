import { type Attributes, type Meter } from '@opentelemetry/api';
import { DEFAULT_METRIC_PREFIX, RedMetrics } from './red-metrics';

interface Recorded {
  value: number;
  attributes?: Attributes;
}

/** A meter that records every instrument it creates and every observation. */
function fakeMeter() {
  const histograms: Record<string, Recorded[]> = {};
  const counters: Record<string, Recorded[]> = {};
  const created = { histograms: [] as string[], counters: [] as string[] };

  const meter = {
    createHistogram(name: string) {
      created.histograms.push(name);
      histograms[name] = [];
      return { record: (value: number, attributes?: Attributes) => histograms[name].push({ value, attributes }) };
    },
    createCounter(name: string) {
      created.counters.push(name);
      counters[name] = [];
      return { add: (value: number, attributes?: Attributes) => counters[name].push({ value, attributes }) };
    },
  } as unknown as Meter;

  return { meter, histograms, counters, created };
}

describe('RedMetrics', () => {
  it('creates a duration histogram and an error counter under the default prefix', () => {
    const { meter, created } = fakeMeter();

    new RedMetrics({ meter });

    expect(created.histograms).toEqual([`${DEFAULT_METRIC_PREFIX}.operation.duration`]);
    expect(created.counters).toEqual([`${DEFAULT_METRIC_PREFIX}.operation.errors`]);
  });

  it('honours a custom metric prefix', () => {
    const { meter, created } = fakeMeter();

    new RedMetrics({ meter, prefix: 'booking' });

    expect(created.histograms).toEqual(['booking.operation.duration']);
    expect(created.counters).toEqual(['booking.operation.errors']);
  });

  it('records duration tagged with the outcome on success without touching the error counter', () => {
    const { meter, histograms, counters } = fakeMeter();
    const red = new RedMetrics({ meter });

    red.record(0.25, 'success', { operation: 'InventoryController/hold' });

    expect(histograms[`${DEFAULT_METRIC_PREFIX}.operation.duration`]).toEqual([
      { value: 0.25, attributes: { operation: 'InventoryController/hold', outcome: 'success' } },
    ]);
    expect(counters[`${DEFAULT_METRIC_PREFIX}.operation.errors`]).toEqual([]);
  });

  it('records duration and increments the error counter on an error outcome', () => {
    const { meter, histograms, counters } = fakeMeter();
    const red = new RedMetrics({ meter });

    red.record(1.5, 'error', { operation: 'InventoryController/hold' });

    const tagged = { operation: 'InventoryController/hold', outcome: 'error' };
    expect(histograms[`${DEFAULT_METRIC_PREFIX}.operation.duration`]).toEqual([
      { value: 1.5, attributes: tagged },
    ]);
    expect(counters[`${DEFAULT_METRIC_PREFIX}.operation.errors`]).toEqual([
      { value: 1, attributes: tagged },
    ]);
  });
});
