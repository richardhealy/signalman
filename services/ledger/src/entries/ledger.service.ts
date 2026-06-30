/**
 * The ledger application service — the financial-record leg of the booking saga.
 *
 * It commits and reverses ledger entries, each operation pairing a state change
 * with an outbox event so the rest of the system learns what happened without the
 * dual-write problem. Two properties make it saga-safe, mirroring the other legs:
 *
 * - **Idempotent commit.** A booking is posted at most once; a retried `commit`
 *   returns the standing entry rather than posting twice. The coordinator (and
 *   broker redeliveries) can therefore retry freely.
 * - **Idempotent compensation.** `reverse` is a no-op once the entry is already
 *   reversed (or was never posted), so the compensation can fire more than once
 *   without backing the same money out twice.
 *
 * Unlike the inventory, payments, and supplier legs, the ledger wraps **no
 * external boundary** — it is our own authoritative record. So a commit has no
 * outage path; the only non-commit outcome is a business **rejection** (a
 * non-positive amount), returned as data with a reason and changing no state.
 *
 * Both `commit` and the outbox `add` it accompanies run in **one** transaction —
 * `runInTransaction` threads a unit of work through the entry write and the
 * outbox staging so they commit together (or not at all), defeating the
 * dual-write problem. The in-memory collaborators model that atomic commit; a
 * Postgres-backed store swaps in behind the same tokens and gets it from a real
 * database transaction.
 */
import { createOutboxRecord, runInTransaction, type OutboxStore, type UnitOfWork } from '@signalman/outbox';
import { randomUUID } from 'node:crypto';
import { type LedgerEntry } from './entry';
import { type LedgerRepository } from './entry-repository';

/** A request to post a booking's money to the ledger. */
export interface CommitCommand {
  bookingId: string;
  amount: number;
  currency: string;
  /** The payment capture reference being recorded; optional. */
  captureId?: string;
}

/** A request to reverse a booking's ledger entry (the compensation). */
export interface ReverseCommand {
  bookingId: string;
}

/**
 * The outcome of {@link LedgerService.commit}. A discriminated union so callers
 * branch on `committed` and a rejection always carries a machine-readable
 * `reason`.
 */
export type CommitOutcome =
  | { committed: true; entryId: string }
  | { committed: false; reason: string };

/** The outcome of {@link LedgerService.reverse}. */
export interface ReverseOutcome {
  reversed: boolean;
  /** The reversed entry's id, or `''` when there was nothing to reverse. */
  entryId: string;
}

/** Injectable collaborators and seams for {@link LedgerService}. */
export interface LedgerServiceOptions {
  entries: LedgerRepository;
  outbox: OutboxStore;
  /** Entry-id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for entry timestamps; defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Transaction runner. Defaults to the in-memory {@link runInTransaction}.
   * Swap in `runInPgTransaction` (bound to a `Pool`) to run the entry + outbox
   * writes inside a real database transaction.
   */
  transact?: <T>(work: (tx: UnitOfWork) => Promise<T>) => Promise<T>;
}

export class LedgerService {
  private readonly entries: LedgerRepository;
  private readonly outbox: OutboxStore;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly transact: <T>(work: (tx: UnitOfWork) => Promise<T>) => Promise<T>;

  constructor(options: LedgerServiceOptions) {
    this.entries = options.entries;
    this.outbox = options.outbox;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
    this.transact = options.transact ?? runInTransaction;
  }

  /**
   * Post `amount` for a booking to the financial record.
   *
   * Idempotent per booking: if the booking is already posted the standing entry
   * is returned unchanged. Otherwise the amount is validated — a non-positive
   * amount is rejected without touching state or staging an event — and on
   * success the entry and a `ledger.committed` event are committed together in
   * one transaction.
   */
  async commit(command: CommitCommand): Promise<CommitOutcome> {
    const existing = await this.entries.findByBooking(command.bookingId);
    if (existing && existing.status === 'committed') {
      return { committed: true, entryId: existing.id };
    }

    if (!Number.isInteger(command.amount) || command.amount <= 0) {
      return { committed: false, reason: 'invalid_amount' };
    }

    const entry: LedgerEntry = {
      id: this.idFactory(),
      bookingId: command.bookingId,
      amount: command.amount,
      currency: command.currency,
      status: 'committed',
      captureId: command.captureId ?? '',
      committedAt: this.clock(),
    };

    // One transaction: the entry and its event commit together or not at all.
    await this.transact(async (tx) => {
      await this.entries.commit(entry, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'ledger_entry',
          aggregateId: entry.id,
          eventType: 'ledger.committed',
          payload: {
            bookingId: entry.bookingId,
            amount: entry.amount,
            currency: entry.currency,
            entryId: entry.id,
            captureId: entry.captureId,
          },
        }),
        tx,
      );
    });

    return { committed: true, entryId: entry.id };
  }

  /**
   * Reverse a booking's ledger entry (the saga compensation).
   *
   * Idempotent: it targets the `committed -> reversed` transition. An entry that
   * is already reversed, or was never posted, yields a successful no-op so the
   * compensation can fire more than once. A live reversal commits the reversed
   * entry and a `ledger.reversed` event together in one transaction.
   */
  async reverse(command: ReverseCommand): Promise<ReverseOutcome> {
    const existing = await this.entries.findByBooking(command.bookingId);
    if (!existing || existing.status !== 'committed') {
      return { reversed: true, entryId: existing?.id ?? '' };
    }

    const reversed: LedgerEntry = {
      ...existing,
      status: 'reversed',
      reversedAt: this.clock(),
    };

    // One transaction: the reversal and its event commit together or not at all.
    await runInTransaction(async (tx) => {
      await this.entries.commit(reversed, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'ledger_entry',
          aggregateId: reversed.id,
          eventType: 'ledger.reversed',
          payload: {
            bookingId: reversed.bookingId,
            amount: reversed.amount,
            currency: reversed.currency,
            entryId: reversed.id,
          },
        }),
        tx,
      );
    });

    return { reversed: true, entryId: reversed.id };
  }
}
