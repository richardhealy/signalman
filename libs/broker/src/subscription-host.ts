/**
 * The per-service subscription lifecycle — the consuming-side mirror of
 * {@link OutboxRelayHost}.
 *
 * Where the relay host turns "events are staged in the outbox" into "events are
 * published to the broker", this host turns "a broker is configured" into "this
 * service is consuming from it". It owns a set of subscriptions over a
 * {@link MessageBroker}: it establishes each one when the application boots and
 * drops them all — then tears the transport down — when it shuts down.
 *
 * Like the relay host it deliberately depends on no web framework: the
 * `onApplicationBootstrap` / `onApplicationShutdown` methods *match* NestJS's
 * `OnApplicationBootstrap` and `OnApplicationShutdown` interfaces structurally
 * (Nest invokes lifecycle hooks by method name), so a service registers the host as
 * a provider and Nest drives it, while the library stays usable from a plain
 * process and directly testable via {@link start}/{@link stop}.
 *
 * The host owns subscription *lifecycle*, not consume *semantics*: each handler is
 * an ordinary {@link BrokerHandler}, so a handler that throws NACKs its message and
 * the broker redelivers it (at-least-once). Route deliveries through the idempotent
 * inbox to turn that into effectively-once processing.
 */
import {
  type BrokerHandler,
  type MessageBroker,
  type SubscribeOptions,
  type Subscription,
} from './broker';

/** One subscription the host establishes: a handler bound to subject pattern(s). */
export interface BrokerSubscription {
  /** Subject pattern(s) to subscribe to (see {@link subjectMatches}). */
  subjects: string | string[];
  /** The handler each matching delivery is routed to; throwing NACKs the message. */
  handler: BrokerHandler;
  /** Per-subscription options, e.g. a queue group for load-balanced delivery. */
  options?: SubscribeOptions;
}

/** Construction inputs for a {@link BrokerSubscriptionHost}. */
export interface BrokerSubscriptionHostOptions {
  /** The broker the host subscribes through. */
  broker: MessageBroker;
  /** The subscriptions to establish on bootstrap. */
  subscriptions: BrokerSubscription[];
  /**
   * Optional transport teardown, run after the subscriptions are dropped on
   * shutdown — e.g. the `close` from {@link createBrokerFromEnv}, which drains and
   * closes the broker.
   */
  close?: () => Promise<void>;
}

export class BrokerSubscriptionHost {
  private readonly broker: MessageBroker;
  private readonly subscriptions: BrokerSubscription[];
  private readonly closeBroker?: () => Promise<void>;
  private active: Subscription[] = [];
  private started = false;

  constructor(options: BrokerSubscriptionHostOptions) {
    this.broker = options.broker;
    this.subscriptions = options.subscriptions;
    this.closeBroker = options.close;
  }

  /** NestJS `OnApplicationBootstrap`: begin consuming once the wiring is up. */
  onApplicationBootstrap(): void {
    this.start();
  }

  /** Establish every configured subscription. Idempotent. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.active = this.subscriptions.map((subscription) =>
      this.broker.subscribe(subscription.subjects, subscription.handler, subscription.options),
    );
  }

  /**
   * NestJS `OnApplicationShutdown`: stop consuming and release the transport.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Drop every subscription (no further deliveries) and tear the broker down.
   * Idempotent.
   */
  async stop(): Promise<void> {
    for (const subscription of this.active) {
      subscription.unsubscribe();
    }
    this.active = [];
    this.started = false;

    if (this.closeBroker) {
      await this.closeBroker();
    }
  }
}
