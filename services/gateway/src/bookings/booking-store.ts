/**
 * Where the gateway keeps the outcome of each booking attempt so the status
 * endpoint can read it back.
 *
 * {@link BookingStore} is the persistence contract; {@link InMemoryBookingStore}
 * is the reference implementation that stands in until a Postgres-backed store
 * lands behind the same {@link BOOKING_STORE} token. Writes are last-wins per
 * booking id: a retried `Book` records the latest outcome over the previous one,
 * which is what an operator wants to see.
 */
import { type BookingRecord } from './booking';

/** The store the gateway records and reads booking outcomes through. */
export interface BookingStore {
  /** Record (or overwrite) the outcome of a booking attempt. */
  save(record: BookingRecord): Promise<void>;
  /** The recorded outcome for a booking id, or `undefined` if none is known. */
  get(bookingId: string): Promise<BookingRecord | undefined>;
}

/** DI token for the {@link BookingStore} the gateway records outcomes through. */
export const BOOKING_STORE = Symbol('BOOKING_STORE');

/** In-memory reference {@link BookingStore} — process-local, last-wins per booking id. */
export class InMemoryBookingStore implements BookingStore {
  private readonly records = new Map<string, BookingRecord>();

  async save(record: BookingRecord): Promise<void> {
    this.records.set(record.bookingId, record);
  }

  async get(bookingId: string): Promise<BookingRecord | undefined> {
    return this.records.get(bookingId);
  }
}
