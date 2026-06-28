/**
 * The transactional unit of work that puts a service's business-state change and
 * the outbox row it stages into **one** local transaction — the half of the
 * transactional-outbox pattern that defeats the dual-write problem.
 *
 * A service wraps the two writes that must agree:
 *
 * ```ts
 * await runInTransaction(async (tx) => {
 *   await repository.save(entity, tx); // the business state
 *   await outbox.add(record, tx);      // the event that announces it
 * });
 * ```
 *
 * Either both writes land or neither does. There is no window in which the state
 * committed but the event was lost, and none in which an event was published for
 * a state change that later rolled back — the two failure modes the spec's
 * outbox exists to rule out ("no lost and no phantom events").
 *
 * In production this maps onto a single database transaction: the enlisted
 * writes run against one connection and the {@link OutboxRelay} claims the staged
 * rows only after `COMMIT`. The in-memory reference models the same
 * all-or-nothing guarantee by buffering each enlisted write and applying them
 * together once the unit of work commits — so the durable mechanics stay fully
 * unit-testable without a live datastore, exactly as the rest of `@signalman/*`
 * does.
 *
 * Scope note: the in-memory unit of work models *commit atomicity* (all writes
 * or none), not read-your-writes isolation — a read inside the callback will not
 * observe a write enlisted earlier in the same callback. The outbox staging
 * pattern reads its idempotency state *before* it writes, so this is not a
 * constraint in practice; a Postgres-backed unit of work gets full transaction
 * isolation for free.
 */

/** A write enlisted into a {@link UnitOfWork}, applied iff the unit of work commits. */
export type DeferredWrite = () => void;

/**
 * A unit of work collecting the writes that must commit together.
 *
 * Stores participate by enlisting their mutation with {@link UnitOfWork.defer}
 * instead of applying it immediately, so {@link runInTransaction} can apply them
 * all on success or discard them all on failure.
 */
export interface UnitOfWork {
  /**
   * Enlist a write to apply when the unit of work commits.
   *
   * The write must be infallible: in the in-memory reference it runs during
   * commit, where a throw would tear a hole in the all-or-nothing guarantee. (A
   * real database commits atomically at the driver, so this is a property of the
   * reference, not of the contract a service codes against.)
   */
  defer(write: DeferredWrite): void;
}

/**
 * Run `work` as a single transactional unit of work: the writes it enlists
 * commit together if it resolves, and are discarded together if it throws.
 *
 * This is the "transactional" in transactional outbox. A service performs the
 * reads it needs, then enlists the business-state write and the {@link
 * OutboxStore.add} that accompanies it into the same {@link UnitOfWork}; on
 * success they land atomically, so an event is staged if and only if the state
 * change it announces also committed.
 *
 * @typeParam T - the value `work` produces (e.g. the operation's outcome).
 * @param work - the body that reads what it needs and enlists the writes that
 *   must agree, receiving the {@link UnitOfWork} to enlist them into.
 * @returns whatever `work` returns, after the enlisted writes have committed.
 * @throws whatever `work` throws, having committed nothing — the rollback.
 */
export async function runInTransaction<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
  const writes: DeferredWrite[] = [];
  const tx: UnitOfWork = { defer: (write) => void writes.push(write) };

  // If `work` rejects, we return before reaching the commit loop, so no enlisted
  // write is ever applied — that early return is the rollback.
  const result = await work(tx);

  // Commit: apply every enlisted write. They are infallible in-memory mutations,
  // so the batch lands atomically from any reader's point of view.
  for (const write of writes) {
    write();
  }
  return result;
}
