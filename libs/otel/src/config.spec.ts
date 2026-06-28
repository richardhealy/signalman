import {
  DEFAULT_OTLP_ENDPOINT,
  parseOtlpHeaders,
  resolveOtlpConfig,
} from './config';

describe('parseOtlpHeaders', () => {
  it('returns an empty map for undefined or empty input', () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders('')).toEqual({});
  });

  it('parses a comma-separated list of key=value pairs', () => {
    expect(parseOtlpHeaders('api-key=secret,x-tenant=acme')).toEqual({
      'api-key': 'secret',
      'x-tenant': 'acme',
    });
  });

  it('trims whitespace around keys and values', () => {
    expect(parseOtlpHeaders('  api-key = secret ,  x = y ')).toEqual({
      'api-key': 'secret',
      x: 'y',
    });
  });

  it('preserves = characters inside a value', () => {
    expect(parseOtlpHeaders('authorization=Bearer base64==')).toEqual({
      authorization: 'Bearer base64==',
    });
  });

  it('skips malformed entries with no key', () => {
    expect(parseOtlpHeaders('=orphan,good=value')).toEqual({ good: 'value' });
  });
});

describe('resolveOtlpConfig', () => {
  it('defaults to the local Collector with per-signal paths', () => {
    const config = resolveOtlpConfig({});

    expect(config.tracesUrl).toBe(`${DEFAULT_OTLP_ENDPOINT}/v1/traces`);
    expect(config.metricsUrl).toBe(`${DEFAULT_OTLP_ENDPOINT}/v1/metrics`);
    expect(config.headers).toEqual({});
  });

  it('appends signal paths to a shared base endpoint', () => {
    const config = resolveOtlpConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.internal:4318',
    });

    expect(config.tracesUrl).toBe('https://collector.internal:4318/v1/traces');
    expect(config.metricsUrl).toBe('https://collector.internal:4318/v1/metrics');
  });

  it('strips a trailing slash from the base endpoint before appending', () => {
    const config = resolveOtlpConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/',
    });

    expect(config.tracesUrl).toBe('http://collector:4318/v1/traces');
  });

  it('uses a signal-specific endpoint verbatim when set', () => {
    const config = resolveOtlpConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces.example/ingest',
    });

    expect(config.tracesUrl).toBe('http://traces.example/ingest');
    expect(config.metricsUrl).toBe('http://collector:4318/v1/metrics');
  });

  it('parses headers from the environment', () => {
    const config = resolveOtlpConfig({
      OTEL_EXPORTER_OTLP_HEADERS: 'api-key=secret',
    });

    expect(config.headers).toEqual({ 'api-key': 'secret' });
  });
});
