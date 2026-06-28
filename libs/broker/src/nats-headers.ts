/**
 * The header codec between the broker's transport-agnostic {@link BrokerHeaders}
 * and NATS {@link MsgHdrs} — the pure mapping the {@link NatsBroker} uses on both
 * sides of the wire.
 *
 * The trace-carrying headers a publish stamps (`traceparent`/`tracestate`) are
 * plain text, which is exactly what NATS headers carry, so the round-trip is
 * lossless for the propagation case. The codec also tolerates the other carrier
 * shapes `BrokerHeaders` admits — a string array (NATS multi-value) and a
 * `Buffer` (the Kafka carrier shape) — so the same application headers survive
 * whichever broker is behind the boundary.
 */
import { headers as createNatsHeaders, type MsgHdrs } from 'nats';
import { type BrokerHeaders } from '@signalman/propagation';

/**
 * The header the adapter uses to carry a {@link BrokerMessage.id} across NATS,
 * so the inbox dedup key round-trips intact. It is adapter-internal: stripped
 * from the decoded application headers so it never leaks into a consumer's view.
 */
export const MESSAGE_ID_HEADER = 'Signalman-Msg-Id';

/**
 * Encode transport-agnostic {@link BrokerHeaders} into NATS {@link MsgHdrs}.
 *
 * `undefined` values are dropped, a string array becomes a multi-valued header
 * (one `append` per element), and a `Buffer` is written as its UTF-8 text (NATS
 * headers are textual). Pass an existing `target` to add to headers the caller
 * already holds; otherwise a fresh `MsgHdrs` is created.
 */
export function encodeNatsHeaders(
  source: BrokerHeaders,
  target: MsgHdrs = createNatsHeaders(),
): MsgHdrs {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const element of value) {
        target.append(key, element);
      }
    } else if (Buffer.isBuffer(value)) {
      target.set(key, value.toString('utf8'));
    } else {
      target.set(key, value);
    }
  }
  return target;
}

/**
 * Decode NATS {@link MsgHdrs} back into {@link BrokerHeaders}, keeping only
 * application headers: NATS-internal headers (`Nats-*`, e.g. the publish dedup
 * id and stream metadata) and the adapter's own {@link MESSAGE_ID_HEADER} are
 * dropped so a consumer sees just the trace context and any caller headers. A
 * single-valued header decodes to a string; a multi-valued one to a string array.
 */
export function decodeNatsHeaders(source: MsgHdrs | undefined): BrokerHeaders {
  const result: BrokerHeaders = {};
  if (source === undefined) {
    return result;
  }
  for (const key of source.keys()) {
    if (isInternalHeader(key)) {
      continue;
    }
    const values = source.values(key);
    result[key] = values.length > 1 ? values : values[0];
  }
  return result;
}

/** Whether a header is transport/adapter machinery rather than an application header. */
function isInternalHeader(key: string): boolean {
  return key === MESSAGE_ID_HEADER || key.toLowerCase().startsWith('nats-');
}
