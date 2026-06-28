/**
 * The NATS JetStream adapter — the first *real* transport behind the
 * {@link MessageBroker} boundary, the production sibling of the in-process
 * {@link InMemoryBroker} reference.
 *
 * It preserves the exact semantics the rest of the system already depends on,
 * mapped onto JetStream primitives:
 *
 * - **Durable stream**: a publish lands in a JetStream stream, so the event
 *   survives a broker restart — the durability the transactional outbox assumes
 *   on the other side of the hop.
 * - **Subject matching** with NATS wildcards: native, the `subjectMatches`
 *   rules the in-memory broker emulates are JetStream's own.
 * - **Fan-out**: a subscription without a queue group gets its own *ephemeral*
 *   push consumer, so every matching subscriber receives its own copy; a
 *   subscription *with* a queue group shares a *durable* consumer with its
 *   members, so they load-balance the subject (NATS queue group).
 * - **At-least-once delivery**: the handler resolving `ack()`s the message;
 *   throwing `nak()`s it for redelivery, up to `maxDeliver` attempts, after
 *   which it is `term()`-inated and surfaced to {@link NatsBrokerOptions.onDeadLetter}
 *   — the same attempt budget and dead-letter seam the reference models. Pair
 *   with the idempotent inbox for effectively-once processing.
 *
 * The {@link MessageBroker} surface stays unchanged, so a service swaps this in
 * for the in-memory reference behind the same DI token — the relay still
 * publishes records and consumers still subscribe, now over JetStream.
 */
import {
  connect,
  consumerOpts,
  createInbox,
  JSONCodec,
  type ConnectionOptions,
  type JetStreamClient,
  type JsMsg,
  type JsMsgCallback,
  type JetStreamSubscription,
  type NatsConnection,
} from 'nats';
import {
  type BrokerHandler,
  type MessageBroker,
  type SubscribeOptions,
  type Subscription,
} from './broker';
import { type BrokerMessage } from './message';
import { DEFAULT_MAX_DELIVER } from './memory-broker';
import { decodeNatsHeaders, encodeNatsHeaders, MESSAGE_ID_HEADER } from './nats-headers';

/** Default JetStream stream name the adapter provisions. */
export const DEFAULT_STREAM_NAME = 'SIGNALMAN';

/**
 * Default subjects the stream captures — the booking event families the saga
 * participants stage. The domain is swappable (see the spec), so callers may
 * override these to capture a different subject space.
 */
export const DEFAULT_STREAM_SUBJECTS = [
  'inventory.>',
  'payment.>',
  'supplier.>',
  'ledger.>',
];

/** Default redelivery timeout (ms): how long an unacked delivery waits before redelivery. */
export const DEFAULT_ACK_WAIT_MS = 30_000;

/** Construction inputs for a {@link NatsBroker}. */
export interface NatsBrokerOptions {
  /** Stream identity. Defaults to {@link DEFAULT_STREAM_NAME} / {@link DEFAULT_STREAM_SUBJECTS}. */
  stream?: { name?: string; subjects?: string[] };
  /**
   * Maximum delivery attempts before a message is dead-lettered, mirroring the
   * reference broker's attempt budget. Defaults to {@link DEFAULT_MAX_DELIVER}.
   */
  maxDeliver?: number;
  /**
   * How long (ms) the server waits for an ack before redelivering a message
   * whose handler neither ack'd nor nak'd (e.g. a crashed consumer). An explicit
   * `nak()` redelivers immediately regardless. Defaults to {@link DEFAULT_ACK_WAIT_MS}.
   */
  ackWaitMs?: number;
  /**
   * Invoked when a delivery exhausts `maxDeliver` without the handler
   * acknowledging — the dead-letter observability seam, matching the reference.
   * The message is `term()`-inated so JetStream stops redelivering it.
   */
  onDeadLetter?: (message: BrokerMessage, error: unknown) => void;
  /**
   * Invoked on a subscription-level error (a delivery the client could not turn
   * into a message — heartbeat miss, decode failure). Defaults to a no-op.
   */
  onError?: (error: unknown, context: string) => void;
}

/**
 * Derive a NATS-legal durable consumer name for a queue group on a subject
 * pattern. The name is a pure function of `(stream, queue, pattern)`, so every
 * member of a queue group across every process derives the *same* durable and
 * therefore binds to one shared consumer — which is what makes them load-balance.
 * Subject wildcards and other illegal characters are replaced so the name is a
 * valid JetStream durable.
 */
export function durableName(stream: string, queue: string, pattern: string): string {
  return sanitizeName(`${stream}-${queue}-${pattern}`);
}

/**
 * The deterministic deliver subject a queue group's push consumer delivers to.
 * Like {@link durableName} it must be identical across members (so they form one
 * NATS queue subscription), and it lives outside the stream's captured subjects
 * so deliveries never loop back into the stream.
 */
export function deliverSubject(stream: string, queue: string, pattern: string): string {
  return `_signalman.deliver.${sanitizeName(`${stream}-${queue}-${pattern}`)}`;
}

/** Replace characters illegal in a NATS durable/token with `_`. */
function sanitizeName(value: string): string {
  return value.replace(/[.*>\s/\\]/g, '_');
}

export class NatsBroker implements MessageBroker {
  private readonly js: JetStreamClient;
  private readonly codec = JSONCodec();
  private readonly streamName: string;
  private readonly streamSubjects: string[];
  private readonly maxDeliver: number;
  private readonly ackWaitMs: number;
  private readonly onDeadLetter: (message: BrokerMessage, error: unknown) => void;
  private readonly onError: (error: unknown, context: string) => void;

  private readonly subscriptions = new Set<JetStreamSubscription>();
  /** In-flight subscription openings, so {@link whenReady} can await establishment. */
  private readonly pending = new Set<Promise<unknown>>();

  private constructor(
    private readonly connection: NatsConnection,
    options: NatsBrokerOptions,
    private readonly ownsConnection: boolean,
  ) {
    this.js = connection.jetstream();
    this.streamName = options.stream?.name ?? DEFAULT_STREAM_NAME;
    this.streamSubjects = options.stream?.subjects ?? DEFAULT_STREAM_SUBJECTS;
    this.maxDeliver = options.maxDeliver ?? DEFAULT_MAX_DELIVER;
    this.ackWaitMs = options.ackWaitMs ?? DEFAULT_ACK_WAIT_MS;
    this.onDeadLetter = options.onDeadLetter ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Adapt an existing {@link NatsConnection} (the caller owns its lifecycle), and
   * provision the stream. Use this when the connection is shared or DI-managed.
   */
  static async create(
    connection: NatsConnection,
    options: NatsBrokerOptions = {},
  ): Promise<NatsBroker> {
    const broker = new NatsBroker(connection, options, false);
    await broker.ensureStream();
    return broker;
  }

  /**
   * Connect to NATS and provision the stream. The broker owns the connection, so
   * {@link close} drains and closes it. Use this for a standalone service or the
   * docker-compose stack.
   */
  static async connect(
    options: NatsBrokerOptions & { connection?: ConnectionOptions } = {},
  ): Promise<NatsBroker> {
    const connection = await connect(options.connection);
    const broker = new NatsBroker(connection, options, true);
    await broker.ensureStream();
    return broker;
  }

  /**
   * Provision the stream idempotently: add it, or — if it already exists — widen
   * its subjects to include this broker's, so re-running against a live server
   * (and two brokers sharing a stream) both work.
   */
  private async ensureStream(): Promise<void> {
    const manager = await this.connection.jetstreamManager();
    try {
      await manager.streams.add({ name: this.streamName, subjects: this.streamSubjects });
    } catch {
      const info = await manager.streams.info(this.streamName);
      const subjects = Array.from(
        new Set([...(info.config.subjects ?? []), ...this.streamSubjects]),
      );
      await manager.streams.update(this.streamName, { ...info.config, subjects });
    }
  }

  publish(message: BrokerMessage): Promise<void> {
    const headers = encodeNatsHeaders(message.headers);
    headers.set(MESSAGE_ID_HEADER, message.id);
    return this.js
      .publish(message.subject, this.codec.encode(message.payload), {
        headers,
        // JetStream's own dedup window keys on this, a second cheap guard against
        // a relay double-publish (the inbox is the authoritative dedup).
        msgID: message.id,
      })
      .then(() => undefined);
  }

  subscribe(
    subjects: string | string[],
    handler: BrokerHandler,
    options: SubscribeOptions = {},
  ): Subscription {
    const patterns = Array.isArray(subjects) ? subjects : [subjects];
    const opened = patterns.map((pattern) => this.openSubscription(pattern, handler, options.queue));
    return {
      unsubscribe: () => {
        for (const opening of opened) {
          opening
            .then((subscription) => {
              this.subscriptions.delete(subscription);
              subscription.unsubscribe();
            })
            .catch(() => {});
        }
      },
    };
  }

  /**
   * Resolve once every subscription opened so far has been established on the
   * server. A push consumer subscribes asynchronously while {@link subscribe}
   * returns synchronously (the boundary is sync); awaiting this before the first
   * publish closes the start-up race in tests and on a cold boot.
   */
  async whenReady(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Open one JetStream push consumer for a single subject pattern. */
  private openSubscription(
    pattern: string,
    handler: BrokerHandler,
    queue: string | undefined,
  ): Promise<JetStreamSubscription> {
    const opts = consumerOpts();
    opts.ackExplicit();
    opts.manualAck();
    opts.maxDeliver(this.maxDeliver);
    opts.ackWait(this.ackWaitMs);
    opts.filterSubject(pattern);
    if (queue !== undefined) {
      // Queue group: a shared durable consumer its members load-balance.
      opts.durable(durableName(this.streamName, queue, pattern));
      opts.queue(queue);
      opts.deliverTo(deliverSubject(this.streamName, queue, pattern));
      opts.deliverAll();
    } else {
      // Fan-out: an ephemeral consumer per subscriber, each its own copy.
      opts.deliverTo(createInbox());
      opts.deliverNew();
    }
    opts.callback(this.makeCallback(handler));

    const opening = this.js
      .subscribe(pattern, opts)
      .then((subscription) => {
        this.subscriptions.add(subscription);
        return subscription;
      })
      .catch((error) => {
        this.onError(error, `subscribe:${pattern}`);
        throw error;
      });
    this.pending.add(opening);
    void opening.finally(() => this.pending.delete(opening)).catch(() => {});
    return opening;
  }

  /** Wrap a {@link BrokerHandler} as the JetStream callback that ack/nak/dead-letters. */
  private makeCallback(handler: BrokerHandler): JsMsgCallback {
    return (error, jsmsg) => {
      if (error) {
        this.onError(error, 'delivery');
        return;
      }
      if (jsmsg === null) {
        return;
      }
      const message = this.toBrokerMessage(jsmsg);
      void handler(message).then(
        () => jsmsg.ack(),
        (handlerError) => {
          if (jsmsg.info.deliveryCount >= this.maxDeliver) {
            this.onDeadLetter(message, handlerError);
            jsmsg.term();
          } else {
            jsmsg.nak();
          }
        },
      );
    };
  }

  /** Decode a delivered JetStream message back into a transport-agnostic {@link BrokerMessage}. */
  private toBrokerMessage(jsmsg: JsMsg): BrokerMessage {
    const id = jsmsg.headers?.get(MESSAGE_ID_HEADER);
    return {
      id: id !== undefined && id !== '' ? id : String(jsmsg.seq),
      subject: jsmsg.subject,
      payload: this.codec.decode(jsmsg.data),
      headers: decodeNatsHeaders(jsmsg.headers),
    };
  }

  /** Stop every subscription and, if this broker owns the connection, drain it. */
  async close(): Promise<void> {
    await this.whenReady();
    for (const subscription of this.subscriptions) {
      try {
        subscription.unsubscribe();
      } catch {
        // already torn down
      }
    }
    this.subscriptions.clear();
    if (this.ownsConnection) {
      await this.connection.drain();
    }
  }
}
