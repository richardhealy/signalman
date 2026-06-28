/**
 * Resolution of a NestJS {@link ExecutionContext} into the naming and attributes
 * of a business span plus the low-cardinality dimensions for its RED metrics.
 *
 * The interceptor is transport-agnostic: the same code path instruments an HTTP
 * controller on the gateway and a gRPC handler on a downstream service. This
 * module is where that transport is read and projected onto the OpenTelemetry
 * RPC and HTTP semantic conventions, so spans line up with the conventions the
 * spec's quality checklist calls out.
 */
import { SpanKind, type Attributes } from '@opentelemetry/api';
import {
  ATTR_CODE_FUNCTION_NAME,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_ROUTE,
} from '@opentelemetry/semantic-conventions';
import { type ExecutionContext } from '@nestjs/common';

// The `rpc.*` keys live in the semantic-conventions *incubating* entry point,
// which TypeScript's classic `node` resolution can't see (it ignores the
// package `exports` map). The keys are stable, so we mirror them here — the
// same approach `@signalman/otel`'s resource builder takes for `service.*`.
const ATTR_RPC_SYSTEM = 'rpc.system';
const ATTR_RPC_SERVICE = 'rpc.service';
const ATTR_RPC_METHOD = 'rpc.method';

/** A resolved operation: how to name and tag its span and its metrics. */
export interface ResolvedOperation {
  /** Span name, e.g. `InventoryController/hold` or `POST /bookings`. */
  name: string;
  /** Span kind; SERVER for an inbound HTTP/RPC request, INTERNAL otherwise. */
  kind: SpanKind;
  /** Attributes set on the span (may include higher-cardinality detail). */
  attributes: Attributes;
  /**
   * The low-cardinality subset used to tag RED metrics. Kept deliberately
   * narrow — every dimension here multiplies the metric's time series.
   */
  metricAttributes: Attributes;
}

/** The fully-qualified handler name, e.g. `InventoryController.hold`. */
function codeFunctionName(context: ExecutionContext): string {
  const controller = context.getClass().name || 'Controller';
  const handler = context.getHandler().name || 'handler';
  return `${controller}.${handler}`;
}

/** Resolve an inbound gRPC handler to an RPC SERVER span. */
function resolveRpc(context: ExecutionContext): ResolvedOperation {
  const service = context.getClass().name || 'Service';
  const method = context.getHandler().name || 'handler';
  const rpc: Attributes = {
    [ATTR_RPC_SYSTEM]: 'grpc',
    [ATTR_RPC_SERVICE]: service,
    [ATTR_RPC_METHOD]: method,
  };
  return {
    name: `${service}/${method}`,
    kind: SpanKind.SERVER,
    attributes: { ...rpc, [ATTR_CODE_FUNCTION_NAME]: `${service}.${method}` },
    metricAttributes: { operation: `${service}/${method}`, ...rpc },
  };
}

/** Resolve an inbound HTTP request to an HTTP SERVER span. */
function resolveHttp(context: ExecutionContext): ResolvedOperation {
  const request: { method?: string; route?: { path?: string } } | undefined = context
    .switchToHttp()
    .getRequest();
  const method = request?.method;
  const route = request?.route?.path;
  const operation = codeFunctionName(context);

  const attributes: Attributes = { [ATTR_CODE_FUNCTION_NAME]: operation };
  const metricAttributes: Attributes = { operation };
  if (method) {
    attributes[ATTR_HTTP_REQUEST_METHOD] = method;
    metricAttributes[ATTR_HTTP_REQUEST_METHOD] = method;
  }
  if (route) {
    attributes[ATTR_HTTP_ROUTE] = route;
    metricAttributes[ATTR_HTTP_ROUTE] = route;
  }

  return {
    name: method && route ? `${method} ${route}` : operation,
    kind: SpanKind.SERVER,
    attributes,
    metricAttributes,
  };
}

/**
 * Resolve an execution context into its {@link ResolvedOperation}. Recognises
 * Nest's `rpc` and `http` context types; anything else (e.g. websockets, or a
 * directly-invoked provider) falls back to an INTERNAL span named after the
 * handler.
 *
 * @param context - the NestJS execution context for the intercepted handler.
 */
export function resolveOperation(context: ExecutionContext): ResolvedOperation {
  switch (context.getType()) {
    case 'rpc':
      return resolveRpc(context);
    case 'http':
      return resolveHttp(context);
    default: {
      const operation = codeFunctionName(context);
      return {
        name: operation,
        kind: SpanKind.INTERNAL,
        attributes: { [ATTR_CODE_FUNCTION_NAME]: operation },
        metricAttributes: { operation },
      };
    }
  }
}
