/**
 * The Payment Service Provider boundary — the external source of truth the
 * payments service wraps.
 *
 * The PSP is deliberately outside our transactional reach: it authorizes,
 * captures, and voids funds, and only it knows whether those really happened.
 * That gap is exactly where divergence is born (the spec's central concern), so
 * v1 ships a {@link SimulatedPsp} with controllable latency and failure
 * injection in place of a real provider. Every call is wrapped in a CLIENT span
 * — the external hop made visible in the booking trace — so a slow or failing
 * PSP shows up where you would look for it.
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

/** A request to authorize funds against a method of payment. */
export interface PspAuthorizeRequest {
  bookingId: string;
  /** Amount in the currency's minor units (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code. */
  currency: string;
}

/**
 * The PSP's verdict on an authorization. A discriminated union: an approval
 * carries the provider's authorization reference, a decline a machine-readable
 * reason. A decline is a *successful* call with a business "no" — distinct from
 * the PSP being unreachable, which throws {@link PspUnavailableError}.
 */
export type PspAuthorizeResult =
  | { approved: true; authorizationId: string }
  | { approved: false; declineReason: string };

/** The PSP's capture reference for a captured authorization. */
export interface PspCaptureResult {
  captureId: string;
}

/** The external payment boundary the payments service calls. */
export interface Psp {
  /** Authorize funds; resolves with the provider's verdict, or throws if unreachable. */
  authorize(request: PspAuthorizeRequest): Promise<PspAuthorizeResult>;
  /** Capture a previously authorized payment by its authorization reference. */
  capture(authorizationId: string): Promise<PspCaptureResult>;
  /** Void (release) a previously obtained authorization. */
  voidAuthorization(authorizationId: string): Promise<void>;
}

/**
 * A technical failure of the PSP boundary — the provider was unreachable or
 * timed out. Distinct from a decline (a successful call with a business "no"):
 * an unavailable PSP propagates so the saga can retry and the trace shows an
 * errored external hop, where the decline is returned as data.
 */
export class PspUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PspUnavailableError';
  }
}

/** The `peer.service` the simulated PSP spans attribute their hop to. */
export const PSP_PEER_SERVICE = 'psp-simulator';

const ATTR_PSP_OPERATION = 'signalman.psp.operation';
const ATTR_PSP_OUTCOME = 'signalman.psp.outcome';
const ATTR_PSP_AUTHORIZATION_ID = 'signalman.psp.authorization_id';
const ATTR_PSP_CAPTURE_ID = 'signalman.psp.capture_id';
const ATTR_PEER_SERVICE = 'peer.service';

/** Construction options for {@link SimulatedPsp}. */
export interface SimulatedPspOptions {
  /** Simulated round-trip latency per call, in ms. Defaults to `0`. */
  latencyMs?: number;
  /** Fraction of authorizations (0–1) the provider declines. Defaults to `0`. */
  declineRate?: number;
  /** Fraction of calls (0–1) that fail outright (unreachable/timeout). Defaults to `0`. */
  failureRate?: number;
  /** RNG seam for decline/failure rolls; defaults to {@link Math.random}. Inject for deterministic tests. */
  random?: () => number;
  /** Sleep seam for simulated latency; defaults to a real `setTimeout`. Inject `() => Promise.resolve()` in tests. */
  delay?: (ms: number) => Promise<void>;
  /** Reference-id generator (authorization/capture ids); defaults to {@link randomUUID}. */
  idFactory?: () => string;
  /** Tracer for the external-hop spans; defaults to the `@signalman/payments` tracer. */
  tracer?: Tracer;
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake PSP standing in for a real provider until one is integrated. It models
 * the two things a real boundary forces you to reckon with — it is slow, and it
 * fails — under deterministic control, and emits the same CLIENT spans a real
 * client would, so the rest of the system (and its traces) are exercised exactly
 * as they will be in production.
 */
export class SimulatedPsp implements Psp {
  private readonly latencyMs: number;
  private readonly declineRate: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly idFactory: () => string;
  private readonly tracer: Tracer;

  constructor(options: SimulatedPspOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.declineRate = options.declineRate ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? Math.random;
    this.delay = options.delay ?? realDelay;
    this.idFactory = options.idFactory ?? randomUUID;
    this.tracer = options.tracer ?? getTracer('@signalman/payments');
  }

  async authorize(request: PspAuthorizeRequest): Promise<PspAuthorizeResult> {
    return this.call(
      'authorize',
      {
        'signalman.psp.booking_id': request.bookingId,
        'signalman.psp.amount': request.amount,
        'signalman.psp.currency': request.currency,
      },
      async (span) => {
        if (this.roll(this.failureRate)) {
          throw new PspUnavailableError('PSP authorize timed out');
        }
        if (this.roll(this.declineRate)) {
          span.setAttribute(ATTR_PSP_OUTCOME, 'declined');
          return { approved: false, declineReason: 'card_declined' };
        }
        const authorizationId = this.idFactory();
        span.setAttribute(ATTR_PSP_OUTCOME, 'approved');
        span.setAttribute(ATTR_PSP_AUTHORIZATION_ID, authorizationId);
        return { approved: true, authorizationId };
      },
    );
  }

  async capture(authorizationId: string): Promise<PspCaptureResult> {
    return this.call(
      'capture',
      { [ATTR_PSP_AUTHORIZATION_ID]: authorizationId },
      async (span) => {
        if (this.roll(this.failureRate)) {
          throw new PspUnavailableError('PSP capture timed out');
        }
        const captureId = this.idFactory();
        span.setAttribute(ATTR_PSP_CAPTURE_ID, captureId);
        return { captureId };
      },
    );
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    await this.call(
      'void',
      { [ATTR_PSP_AUTHORIZATION_ID]: authorizationId },
      async () => {
        if (this.roll(this.failureRate)) {
          throw new PspUnavailableError('PSP void timed out');
        }
      },
    );
  }

  /** True with probability `rate` (clamped to [0, 1]); the failure/decline coin. */
  private roll(rate: number): boolean {
    return rate > 0 && this.random() < rate;
  }

  /**
   * Run a PSP operation inside a CLIENT span: apply the simulated latency, invoke
   * the body, and translate its outcome onto the span. A returned value (approval
   * or decline) is an OK span; a thrown {@link PspUnavailableError} is recorded as
   * an errored span and rethrown — the external hop is observable either way.
   */
  private call<T>(
    operation: string,
    attributes: Attributes,
    body: (span: Span) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `psp ${operation}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [ATTR_PSP_OPERATION]: operation,
          [ATTR_PEER_SERVICE]: PSP_PEER_SERVICE,
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
