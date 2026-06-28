/**
 * The inventory application service — the inventory leg of the booking saga.
 *
 * It places and releases holds, each operation pairing a state change with an
 * outbox event so the rest of the system learns what happened without the
 * dual-write problem. Two properties make it saga-safe:
 *
 * - **Idempotent placement.** A booking holds inventory at most once; a retried
 *   `hold` returns the existing reservation rather than reserving twice. The
 *   coordinator (and broker redeliveries) can therefore retry freely.
 * - **Idempotent compensation.** `release` is a no-op once the hold is already
 *   released (or never existed), so the compensation can fire more than once
 *   without over-restoring stock.
 *
 * Both `commitHold`/`commitRelease` and the outbox `add` they accompany run in
 * **one** transaction — `runInTransaction` threads a unit of work through the
 * hold write and the outbox staging so they commit together (or not at all),
 * defeating the dual-write problem. The in-memory collaborators model that atomic
 * commit; a Postgres-backed store swaps in behind the same tokens and gets it from
 * a real database transaction.
 */
import { createOutboxRecord, runInTransaction, type OutboxStore } from '@signalman/outbox';
import { randomUUID } from 'node:crypto';
import { type Hold } from './hold';
import { type HoldRepository } from './hold-repository';

/** A request to reserve inventory for a booking. */
export interface HoldCommand {
  bookingId: string;
  sku: string;
  qty: number;
}

/** A request to release a booking's inventory (the compensation). */
export interface ReleaseCommand {
  bookingId: string;
}

/**
 * The outcome of {@link InventoryService.hold}. A discriminated union so callers
 * branch on `held` and the rejection always carries a machine-readable `reason`.
 */
export type HoldOutcome =
  | { held: true; holdId: string; available: number }
  | { held: false; reason: string; available: number };

/** The outcome of {@link InventoryService.release}. */
export interface ReleaseOutcome {
  released: boolean;
  /** The released hold's id, or `''` when there was nothing to release. */
  holdId: string;
}

/** Injectable collaborators and seams for {@link InventoryService}. */
export interface InventoryServiceOptions {
  holds: HoldRepository;
  outbox: OutboxStore;
  /** Hold-id generator; defaults to {@link randomUUID}. Override for deterministic tests. */
  idFactory?: () => string;
  /** Clock for hold timestamps; defaults to `() => new Date()`. */
  clock?: () => Date;
}

export class InventoryService {
  private readonly holds: HoldRepository;
  private readonly outbox: OutboxStore;
  private readonly idFactory: () => string;
  private readonly clock: () => Date;

  constructor(options: InventoryServiceOptions) {
    this.holds = options.holds;
    this.outbox = options.outbox;
    this.idFactory = options.idFactory ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Reserve `qty` of `sku` for a booking.
   *
   * Idempotent per booking: if the booking already holds inventory the standing
   * hold is returned unchanged. Otherwise availability is checked — an
   * insufficient-stock request is rejected without touching state or staging an
   * event — and on success the hold and an `inventory.held` event are committed
   * together in one transaction.
   */
  async hold(command: HoldCommand): Promise<HoldOutcome> {
    const existing = await this.holds.findByBooking(command.bookingId);
    if (existing && existing.status === 'held') {
      return {
        held: true,
        holdId: existing.id,
        available: await this.holds.availableFor(existing.sku),
      };
    }

    const available = await this.holds.availableFor(command.sku);
    if (command.qty > available) {
      return { held: false, reason: 'insufficient_stock', available };
    }

    const hold: Hold = {
      id: this.idFactory(),
      bookingId: command.bookingId,
      sku: command.sku,
      qty: command.qty,
      status: 'held',
      createdAt: this.clock(),
    };

    // One transaction: the hold and its event commit together or not at all.
    await runInTransaction(async (tx) => {
      await this.holds.commitHold(hold, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'hold',
          aggregateId: hold.id,
          eventType: 'inventory.held',
          payload: { bookingId: hold.bookingId, sku: hold.sku, qty: hold.qty },
        }),
        tx,
      );
    });

    return { held: true, holdId: hold.id, available: available - hold.qty };
  }

  /**
   * Release a booking's hold (the saga compensation).
   *
   * Idempotent: a hold that is already released — or was never placed — yields a
   * successful no-op so the compensation can fire more than once without
   * over-restoring stock. A live release commits the released hold and an
   * `inventory.released` event together in one transaction.
   */
  async release(command: ReleaseCommand): Promise<ReleaseOutcome> {
    const existing = await this.holds.findByBooking(command.bookingId);
    if (!existing || existing.status === 'released') {
      return { released: true, holdId: existing?.id ?? '' };
    }

    const released: Hold = { ...existing, status: 'released', releasedAt: this.clock() };

    // One transaction: the release and its event commit together or not at all.
    await runInTransaction(async (tx) => {
      await this.holds.commitRelease(released, tx);
      await this.outbox.add(
        createOutboxRecord({
          aggregateType: 'hold',
          aggregateId: released.id,
          eventType: 'inventory.released',
          payload: { bookingId: released.bookingId, sku: released.sku, qty: released.qty },
        }),
        tx,
      );
    });

    return { released: true, holdId: released.id };
  }
}
