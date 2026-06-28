/**
 * Construction of the OpenTelemetry {@link Resource} that identifies a service.
 *
 * Every span, metric, and log a service emits is stamped with these resource
 * attributes, so getting `service.name` and friends right is what lets a
 * backend like Tempo/Grafana group one booking's signals by the service that
 * produced them. All signalman services share a `service.namespace` so they
 * read as one system.
 */
import { type AttributeValue } from '@opentelemetry/api';
import {
  type Resource,
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// `service.namespace` and `deployment.environment.name` live in the semantic
// conventions *incubating* entry point, which TypeScript's classic `node`
// module resolution can't see (it ignores the package `exports` map). The keys
// are stable and widely used, so we mirror them here as constants.
const ATTR_SERVICE_NAMESPACE = 'service.namespace';
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';

/** Namespace shared by every signalman service, so a backend can group them. */
export const SERVICE_NAMESPACE = 'signalman';

/** Environment used when none is configured. */
export const DEFAULT_ENVIRONMENT = 'development';

/** Inputs describing the service a resource identifies. */
export interface ResourceOptions {
  /** Logical service name, e.g. `inventory` — becomes `service.name`. */
  serviceName: string;
  /** Build/release version — becomes `service.version` when provided. */
  serviceVersion?: string;
  /** Overrides the shared {@link SERVICE_NAMESPACE}. */
  serviceNamespace?: string;
  /** Deployment environment; falls back to env vars, then {@link DEFAULT_ENVIRONMENT}. */
  environment?: string;
  /** Extra resource attributes merged in last (they win on conflict). */
  attributes?: Record<string, AttributeValue>;
}

/**
 * Resolve the deployment environment from an explicit value, then the
 * `DEPLOYMENT_ENVIRONMENT` and `NODE_ENV` variables, then a development
 * default. Empty strings are treated as unset.
 */
function resolveEnvironment(explicit?: string): string {
  return (
    explicit?.trim() ||
    process.env.DEPLOYMENT_ENVIRONMENT?.trim() ||
    process.env.NODE_ENV?.trim() ||
    DEFAULT_ENVIRONMENT
  );
}

/**
 * Build the resource for a service, layering the requested attributes over the
 * SDK's default resource (which carries `telemetry.sdk.*` and host/process
 * detection). Caller-supplied attributes take precedence over the defaults.
 *
 * @param options - identity of the service being instrumented.
 * @returns a resource ready to hand to the Node SDK.
 */
export function buildResource(options: ResourceOptions): Resource {
  const attributes: Record<string, AttributeValue> = {
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_NAMESPACE]: options.serviceNamespace ?? SERVICE_NAMESPACE,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: resolveEnvironment(options.environment),
    ...(options.serviceVersion ? { [ATTR_SERVICE_VERSION]: options.serviceVersion } : {}),
    ...options.attributes,
  };

  return defaultResource().merge(resourceFromAttributes(attributes));
}
