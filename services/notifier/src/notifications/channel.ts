/**
 * The customer-notification boundary — the external provider the notifier wraps.
 *
 * Telling the customer goes through someone else's system: an email or SMS
 * provider that lives outside our transactional reach and can be slow or down.
 * That is another external source of truth, and the same boundary the supplier and
 * PSP legs model — so v1 ships a {@link SimulatedNotificationChannel} with
 * controllable latency and failure injection in place of a real provider. Every
 * send is wrapped in a CLIENT span — the provider hop made visible on the booking
 * trace — so a slow or failing notification shows up where you would look for it.
 *
 * Unlike the supplier partner there is no business "rejection" here: a send either
 * succeeds or the provider is unreachable. A send that cannot be delivered throws
 * {@link NotificationChannelUnavailableError}, which the consumer turns into a NACK
 * so the broker redelivers — at-least-once plus the inbox's dedup is the
 * effectively-once the spec calls for.
 */
import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { getTracer } from '@signalman/otel';
import { randomUUID } from 'node:crypto';
import { type NotificationChannelKind, type NotificationKind } from './notification';

/** A request to send one notification to the customer. */
export interface NotificationRequest {
  bookingId: string;
  /** The customer contact to deliver to. */
  recipient: string;
  /** The transport to deliver over. */
  channel: NotificationChannelKind;
  /** What the customer is being told. */
  kind: NotificationKind;
}

/** The provider's acknowledgement of an accepted send. */
export interface NotificationReceipt {
  /** The provider's message id — the external reference proving the message was accepted. */
  providerMessageId: string;
}

/** The external notification boundary the notifier sends through. */
export interface NotificationChannel {
  /** Send a notification; resolves with the provider's receipt, or throws if unreachable. */
  send(request: NotificationRequest): Promise<NotificationReceipt>;
}

/**
 * A technical failure of the notification boundary — the provider was unreachable
 * or timed out. Propagated so the consumer NACKs and the broker redelivers, and so
 * the trace shows an errored provider hop rather than a silently dropped message.
 */
export class NotificationChannelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationChannelUnavailableError';
  }
}

/** The `peer.service` the simulated provider spans attribute their hop to. */
export const NOTIFICATION_PEER_SERVICE = 'notification-provider';

const ATTR_NOTIFIER_OPERATION = 'signalman.notifier.operation';
const ATTR_NOTIFIER_OUTCOME = 'signalman.notifier.outcome';
const ATTR_NOTIFIER_REFERENCE = 'signalman.notifier.reference';
const ATTR_PEER_SERVICE = 'peer.service';

/** Construction options for {@link SimulatedNotificationChannel}. */
export interface SimulatedNotificationChannelOptions {
  /** Simulated round-trip latency per send, in ms. Defaults to `0`. */
  latencyMs?: number;
  /** Fraction of sends (0–1) that fail outright (unreachable/timeout). Defaults to `0`. */
  failureRate?: number;
  /** RNG seam for the failure roll; defaults to {@link Math.random}. Inject for deterministic tests. */
  random?: () => number;
  /** Sleep seam for simulated latency; defaults to a real `setTimeout`. Inject `() => Promise.resolve()` in tests. */
  delay?: (ms: number) => Promise<void>;
  /** Provider-message-id generator; defaults to {@link randomUUID}. */
  idFactory?: () => string;
  /** Tracer for the provider-hop spans; defaults to the `@signalman/notifier` tracer. */
  tracer?: Tracer;
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake provider standing in for a real email/SMS gateway until one is
 * integrated. It models the one thing a real boundary forces you to reckon with —
 * it is slow, and it can be down — under deterministic control, and emits the same
 * CLIENT span a real client would, so the rest of the system (and its traces) are
 * exercised exactly as they will be in production.
 */
export class SimulatedNotificationChannel implements NotificationChannel {
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly tracer: Tracer;

  constructor(options: SimulatedNotificationChannelOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? Math.random;
    this.delay = options.delay ?? realDelay;
    this.idFactory = options.idFactory ?? randomUUID;
    this.tracer = options.tracer ?? getTracer('@signalman/notifier');
  }

  async send(request: NotificationRequest): Promise<NotificationReceipt> {
    return this.call(
      'send',
      {
        'signalman.notifier.booking_id': request.bookingId,
        'signalman.notifier.recipient': request.recipient,
        'signalman.notifier.channel': request.channel,
        'signalman.notifier.kind': request.kind,
      },
      async (span) => {
        if (this.failureRate > 0 && this.random() < this.failureRate) {
          throw new NotificationChannelUnavailableError('notification provider unreachable');
        }
        const providerMessageId = this.idFactory();
        span.setAttribute(ATTR_NOTIFIER_OUTCOME, 'sent');
        span.setAttribute(ATTR_NOTIFIER_REFERENCE, providerMessageId);
        return { providerMessageId };
      },
    );
  }

  /**
   * Run a provider operation inside a CLIENT span: apply the simulated latency,
   * invoke the body, and translate its outcome onto the span. A returned receipt
   * is an OK span; a thrown {@link NotificationChannelUnavailableError} is recorded
   * as an errored span and rethrown — the provider hop is observable either way.
   */
  private call<T>(
    operation: string,
    attributes: Attributes,
    body: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `notifier ${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [ATTR_NOTIFIER_OPERATION]: operation,
          [ATTR_PEER_SERVICE]: NOTIFICATION_PEER_SERVICE,
          ...attributes,
        },
      },
      async (span) => {
        try {
          if (this.latencyMs > 0) {
            await this.delay(this.latencyMs);
          }
          const result = await body(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          span.recordException(error instanceof Error ? error : { message });
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          span.setAttribute(ATTR_ERROR_TYPE, error instanceof Error ? error.name : 'Error');
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
