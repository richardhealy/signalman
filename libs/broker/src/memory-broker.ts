/**
 * The in-memory reference broker — an in-process pub/sub that implements the
 * full {@link MessageBroker} contract so the async-event hop runs end to end
 * without external infrastructure (in tests, and in a single-process demo).
 *
 * It models the semantics a real broker gives the rest of the system:
 *
 * - **Subject matching** with NATS wildcards (see {@link subjectMatches}).
 * - **Fan-out**: every matching subscription gets its own copy of a message;
 *   a **queue group** instead load-balances a subject across its members.
 * - **At-least-once delivery**: a handler that throws (NACK) is redelivered,
 *   up to `maxDeliver` attempts, after which the message is dead-lettered. Pair
 *   with the idempotent inbox for effectively-once processing.
 *
 * Delivery is asynchronous and decoupled from {@link publish}: a publish returns
 * once the message is enqueued, and {@link drain} awaits quiescence so tests (and
 * graceful shutdown) can wait for all deliveries — including redeliveries — to
 * settle.
 */
import { subjectMatches, type BrokerMessage } from './message';
import {
  type BrokerHandler,
  type MessageBroker,
  type SubscribeOptions,
  type Subscription,
} from './broker';

/** Default attempt budget per delivery before a message is dead-lettered. */
export const DEFAULT_MAX_DELIVER = 5;

/** Construction inputs for an {@link InMemoryBroker}. */
export interface InMemoryBrokerOptions {
  /**
   * Maximum delivery attempts for a single (message, subscription) pair before
   * it is dead-lettered. Defaults to {@link DEFAULT_MAX_DELIVER}.
   */
  maxDeliver?: number;
  /**
   * Invoked when a delivery exhausts `maxDeliver` without the handler
   * acknowledging. Defaults to a no-op. Real brokers route these to a
   * dead-letter subject; here it is an observability seam.
   */
  onDeadLetter?: (message: BrokerMessage, error: unknown) => void;
}

/** A registered subscription. */
interface Registration {
  patterns: string[];
  handler: BrokerHandler;
  queue?: string;
  active: boolean;
}

/** A queued delivery attempt for one (message, subscription) pair. */
interface Delivery {
  message: BrokerMessage;
  registration: Registration;
  attempt: number;
}

export class InMemoryBroker implements MessageBroker {
  private readonly maxDeliver: number;
  private readonly onDeadLetter: (message: BrokerMessage, error: unknown) => void;

  private readonly registrations = new Set<Registration>();
  /** Round-robin cursor per queue group, for load-balanced delivery. */
  private readonly queueCursors = new Map<string, number>();

  private readonly queue: Delivery[] = [];
  private pumping = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: InMemoryBrokerOptions = {}) {
    this.maxDeliver = options.maxDeliver ?? DEFAULT_MAX_DELIVER;
    this.onDeadLetter = options.onDeadLetter ?? (() => {});
  }

  subscribe(
    subjects: string | string[],
    handler: BrokerHandler,
    options: SubscribeOptions = {},
  ): Subscription {
    const registration: Registration = {
      patterns: Array.isArray(subjects) ? subjects : [subjects],
      handler,
      queue: options.queue,
      active: true,
    };
    this.registrations.add(registration);
    return {
      unsubscribe: () => {
        registration.active = false;
        this.registrations.delete(registration);
      },
    };
  }

  publish(message: BrokerMessage): Promise<void> {
    for (const registration of this.selectTargets(message.subject)) {
      this.queue.push({ message, registration, attempt: 1 });
    }
    void this.pump();
    return Promise.resolve();
  }

  /**
   * Resolve once every queued delivery — and any redeliveries they trigger — has
   * settled. Use it to wait for the async hop in tests, or to flush in-flight
   * messages on shutdown.
   */
  drain(): Promise<void> {
    if (this.queue.length === 0 && !this.pumping) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  /**
   * The delivery targets for a subject: every matching fan-out subscription,
   * plus one round-robin member of each matching queue group.
   */
  private selectTargets(subject: string): Registration[] {
    const matching = [...this.registrations].filter(
      (registration) =>
        registration.active && registration.patterns.some((p) => subjectMatches(p, subject)),
    );

    const targets: Registration[] = [];
    const queueGroups = new Map<string, Registration[]>();
    for (const registration of matching) {
      if (registration.queue === undefined) {
        targets.push(registration);
      } else {
        const members = queueGroups.get(registration.queue) ?? [];
        members.push(registration);
        queueGroups.set(registration.queue, members);
      }
    }

    for (const [queue, members] of queueGroups) {
      const cursor = this.queueCursors.get(queue) ?? 0;
      targets.push(members[cursor % members.length]);
      this.queueCursors.set(queue, cursor + 1);
    }

    return targets;
  }

  /** Drain the delivery queue, single-flight, redelivering NACKed messages. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      let delivery: Delivery | undefined;
      while ((delivery = this.queue.shift()) !== undefined) {
        if (!delivery.registration.active) {
          continue;
        }
        try {
          await delivery.registration.handler(delivery.message);
        } catch (error) {
          if (delivery.attempt < this.maxDeliver) {
            this.queue.push({ ...delivery, attempt: delivery.attempt + 1 });
          } else {
            this.onDeadLetter(delivery.message, error);
          }
        }
      }
    } finally {
      this.pumping = false;
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  }
}
