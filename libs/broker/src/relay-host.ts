/**
 * The per-service relay lifecycle — what turns "events are staged in the outbox"
 * into "events are published to the broker" inside a running service.
 *
 * A producing service stages its events transactionally (the outbox), but nothing
 * leaves the service until a relay drains those rows onto a broker. This host owns
 * that relay's lifecycle: it composes an {@link OutboxRelay} over the service's
 * {@link OutboxStore} and a {@link BrokerPublisher} on the configured broker, then
 * starts polling when the application boots and stops — flushing once and tearing
 * the transport down — when it shuts down.
 *
 * It deliberately depends on no web framework: the `onApplicationBootstrap` /
 * `onApplicationShutdown` methods *match* NestJS's `OnApplicationBootstrap` and
 * `OnApplicationShutdown` interfaces structurally (Nest invokes lifecycle hooks by
 * method name), so a service registers the host as a provider and Nest drives it,
 * while the library stays usable from a plain process and directly testable via
 * {@link start}/{@link stop}/{@link flush}.
 */
import {
  OutboxRelay,
  type OutboxRelayOptions,
  type OutboxStore,
} from '@signalman/outbox';
import { type MessageBroker } from './broker';
import { BrokerPublisher } from './outbox-publisher';

/** Default poll cadence (ms) for the relay — frequent enough to feel live, idle-cheap. */
export const DEFAULT_RELAY_POLL_MS = 250;

/** Construction inputs for an {@link OutboxRelayHost}. */
export interface OutboxRelayHostOptions {
  /** The outbox store the relay drains. */
  store: OutboxStore;
  /** The broker the relay publishes onto. */
  broker: MessageBroker;
  /** Value for the publish span's `messaging.system` attribute (e.g. `'nats'`). */
  messagingSystem?: string;
  /** Poll interval in ms. Defaults to {@link DEFAULT_RELAY_POLL_MS}. */
  pollIntervalMs?: number;
  /**
   * Optional transport teardown, run after the relay stops on shutdown — e.g. the
   * `close` from {@link createBrokerFromEnv}, which drains/closes the broker.
   */
  close?: () => Promise<void>;
  /** Extra relay tuning (batch size, lease, back-off, `onError`). */
  relayOptions?: Omit<OutboxRelayOptions, 'store' | 'publisher' | 'messagingSystem'>;
}

export class OutboxRelayHost {
  private readonly relay: OutboxRelay;
  private readonly pollIntervalMs: number;
  private readonly closeBroker?: () => Promise<void>;
  private started = false;

  constructor(options: OutboxRelayHostOptions) {
    this.relay = new OutboxRelay({
      store: options.store,
      publisher: new BrokerPublisher(options.broker),
      messagingSystem: options.messagingSystem,
      ...options.relayOptions,
    });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_RELAY_POLL_MS;
    this.closeBroker = options.close;
  }

  /** NestJS `OnApplicationBootstrap`: begin draining the outbox once wiring is up. */
  onApplicationBootstrap(): void {
    this.start();
  }

  /** Start the relay's polling scheduler. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.relay.start(this.pollIntervalMs);
  }

  /**
   * Run a single relay pass immediately, draining whatever is currently due.
   * Used on shutdown to flush, and as the deterministic hook in tests.
   */
  async flush(): Promise<void> {
    await this.relay.relayOnce();
  }

  /**
   * NestJS `OnApplicationShutdown`: stop polling, flush any staged-but-unpublished
   * rows one last time, and release the transport.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Stop the scheduler, flush once (best-effort — anything still unpublished stays
   * claimable for the next process), and tear the broker down. Idempotent.
   */
  async stop(): Promise<void> {
    this.relay.stop();
    this.started = false;

    try {
      await this.relay.relayOnce();
    } catch {
      // Shutdown is best-effort: a failed final flush leaves rows pending, which a
      // restarted relay re-claims. Never let it block teardown.
    }

    if (this.closeBroker) {
      await this.closeBroker();
    }
  }
}
