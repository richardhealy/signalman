/**
 * Demo availability catalogue: the SKUs the inventory service starts with.
 *
 * In in-memory mode (no `POSTGRES_URL`) it is the whole catalogue; in Postgres
 * mode {@link PostgresHoldRepository.ensureSchema} seeds the `inventory` schema
 * with it on bootstrap. The README and docs book these SKUs, and
 * `services/gateway/src/bookings/documented-requests.spec.ts` checks that every
 * documented booking request names one of them.
 */
export const DEMO_STOCK: Readonly<Record<string, number>> = {
  'seat-economy': 100,
  'seat-business': 20,
  'room-standard': 50,
};
