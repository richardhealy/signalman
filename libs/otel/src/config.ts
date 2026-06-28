/**
 * Resolution of OTLP exporter configuration from the environment.
 *
 * The OpenTelemetry Collector in this project accepts OTLP over HTTP on port
 * 4318. These helpers turn the standard `OTEL_EXPORTER_OTLP_*` environment
 * variables into concrete per-signal URLs and a header map, applying a
 * local-Collector default so a freshly cloned service exports out of the box.
 */

/** Default OTLP/HTTP base endpoint — the Collector's HTTP receiver. */
export const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318';

/** Resolved, per-signal OTLP/HTTP exporter configuration. */
export interface OtlpConfig {
  /** Full URL the trace exporter should POST spans to. */
  tracesUrl: string;
  /** Full URL the metric exporter should POST metrics to. */
  metricsUrl: string;
  /** Headers attached to every OTLP request (e.g. auth for a hosted backend). */
  headers: Record<string, string>;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Parse an `OTEL_EXPORTER_OTLP_HEADERS` value — a comma-separated list of
 * `key=value` pairs — into a header map. Whitespace around keys and values is
 * trimmed, `=` characters within a value are preserved, and malformed entries
 * (those with no key) are skipped rather than throwing.
 *
 * @param raw - the raw header string, or `undefined` when the variable is unset.
 */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) {
    return headers;
  }
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    headers[key] = pair.slice(eq + 1).trim();
  }
  return headers;
}

/**
 * Resolve OTLP/HTTP exporter configuration from environment variables.
 *
 * Precedence follows the OpenTelemetry specification: a signal-specific
 * endpoint (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`) is used verbatim when set; otherwise
 * the per-signal path (`/v1/traces`, `/v1/metrics`) is appended to the shared
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, which itself defaults to the local Collector.
 *
 * @param env - the environment to read; defaults to `process.env`.
 */
export function resolveOtlpConfig(env: NodeJS.ProcessEnv = process.env): OtlpConfig {
  const base = stripTrailingSlash(
    env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || DEFAULT_OTLP_ENDPOINT,
  );
  const tracesUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || `${base}/v1/traces`;
  const metricsUrl = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim() || `${base}/v1/metrics`;

  return {
    tracesUrl,
    metricsUrl,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
  };
}
