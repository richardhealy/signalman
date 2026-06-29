/**
 * Env-driven broker selection — the seam that lets a service choose its transport
 * at boot without touching code.
 *
 * Every service depends only on the {@link MessageBroker} boundary, so which
 * implementation backs it is a deployment concern. {@link createBrokerFromEnv}
 * reads that choice from the environment: the in-memory reference by default (so
 * the unit suite and a single-process demo need no infrastructure), the NATS
 * JetStream transport when `BROKER=nats` (so the docker-compose stack wires the
 * real broker by setting one variable). The returned handle carries a `close` so
 * the owner can tear the transport down on shutdown — draining the in-memory
 * queue, or draining and closing the NATS connection.
 */
import { type ConnectionOptions } from 'nats';
import { type MessageBroker } from './broker';
import { InMemoryBroker } from './memory-broker';
import { NatsBroker } from './nats-broker';

/** The transports a service can be configured to use. */
export type BrokerKind = 'memory' | 'nats';

/**
 * A constructed broker plus the metadata and teardown its owner needs: the
 * concrete `kind` (also the `messaging.system` span attribute), and a `close`
 * that releases the transport on shutdown.
 */
export interface BrokerFromEnvResult {
  /** The constructed broker, behind the transport-agnostic boundary. */
  broker: MessageBroker;
  /** Which transport was selected — also the value for `messaging.system`. */
  kind: BrokerKind;
  /** Release the transport: drains the in-memory queue, or drains+closes NATS. */
  close(): Promise<void>;
}

/** Environment variables consulted for the broker choice, in precedence order. */
const KIND_ENV_KEYS = ['SIGNALMAN_BROKER', 'BROKER'] as const;

/** Environment variables consulted for the NATS server list, in precedence order. */
const NATS_URL_ENV_KEYS = ['NATS_URL', 'NATS_SERVERS'] as const;

/**
 * Resolve which transport a service should use from the environment.
 *
 * `SIGNALMAN_BROKER` takes precedence over the more generic `BROKER`; an unset or
 * blank value falls through to the next key and ultimately defaults to `memory`.
 * The value is case-insensitive and accepts a couple of friendly aliases
 * (`in-memory`, `jetstream`). An explicitly set but unrecognised value throws
 * rather than silently defaulting, so a typo in a deployment fails fast.
 *
 * @param env - the environment to read; defaults to `process.env`.
 */
export function resolveBrokerKind(env: NodeJS.ProcessEnv = process.env): BrokerKind {
  for (const key of KIND_ENV_KEYS) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    const value = raw.trim().toLowerCase();
    if (value === 'memory' || value === 'in-memory' || value === 'inmemory') {
      return 'memory';
    }
    if (value === 'nats' || value === 'jetstream') {
      return 'nats';
    }
    throw new Error(
      `Unknown broker kind "${raw}" in ${key}; expected "memory" or "nats".`,
    );
  }
  return 'memory';
}

/** Read the NATS server list from the environment (comma-separated), if set. */
function natsConnectionOptions(env: NodeJS.ProcessEnv): ConnectionOptions {
  for (const key of NATS_URL_ENV_KEYS) {
    const raw = env[key];
    if (raw !== undefined && raw.trim() !== '') {
      return { servers: raw.split(',').map((server) => server.trim()) };
    }
  }
  // No servers configured: the NATS client falls back to its own default
  // (`localhost:4222`), which is what the docker-compose stack exposes.
  return {};
}

/**
 * Construct the broker a service should use, chosen by {@link resolveBrokerKind}.
 *
 * For `memory` this is synchronous in spirit — a fresh {@link InMemoryBroker};
 * `close` drains its in-flight queue. For `nats` it connects to JetStream
 * (servers from `NATS_URL`/`NATS_SERVERS`, else the client default) and
 * provisions the stream, owning the connection so `close` drains and closes it.
 *
 * @param env - the environment to read; defaults to `process.env`.
 */
export async function createBrokerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrokerFromEnvResult> {
  const kind = resolveBrokerKind(env);

  if (kind === 'nats') {
    const broker = await NatsBroker.connect({ connection: natsConnectionOptions(env) });
    return { broker, kind, close: () => broker.close() };
  }

  const broker = new InMemoryBroker();
  return { broker, kind, close: () => broker.drain() };
}
