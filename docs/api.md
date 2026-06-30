# Signalman — API Reference

Signalman exposes two integration surfaces: an **HTTP API** on the gateway (the public entry point) and a set of **internal gRPC services** the saga coordinator drives. A third surface is the **async event stream** the producing services publish to the broker. This document covers all three, plus the **environment variables** that control each service.

---

## HTTP API — Gateway

The gateway is the only service that accepts requests from outside the system. It listens on port `3000` by default (`PORT` env var).

### `POST /bookings`

Start a booking. Validates the request, drives the saga via the coordinator, records the outcome, and returns it. The server span for this request is the **root of the booking trace** — every downstream gRPC and async hop hangs off it.

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sku` | string | yes | Stock-keeping unit to book (e.g. `"ECO"`, `"BUS"`). |
| `qty` | integer > 0 | yes | Number of units to book. |
| `amount` | integer > 0 | yes | Amount to take, in the currency's minor units (e.g. cents). |
| `currency` | string | yes | ISO 4217 currency code (e.g. `"USD"`). |
| `bookingId` | string | no | Caller-supplied idempotency key. A fresh UUID is minted when omitted. |

**Example request:**

```bash
curl -s -X POST http://localhost:3000/bookings \
  -H 'Content-Type: application/json' \
  -d '{"sku":"ECO","qty":1,"amount":9900,"currency":"USD"}'
```

**Response — `201 Created`** (both on a successful booking and on a saga business failure):

| Field | Type | Always present | Description |
|-------|------|----------------|-------------|
| `bookingId` | string | yes | The booking's identifier. |
| `status` | `"booked"` \| `"failed"` | yes | Whether every saga step succeeded. |
| `request` | object | yes | The request echoed back (`sku`, `qty`, `amount`, `currency`). |
| `traceId` | string | yes | W3C trace ID of the booking trace; use this to navigate to the span in Grafana. |
| `recordedAt` | string (ISO-8601) | yes | When the outcome was recorded. |
| `holdId` | string | on `booked` | Inventory hold reference. |
| `authorizationId` | string | on `booked` | PSP authorization reference. |
| `confirmationId` | string | on `booked` | Supplier confirmation reference. |
| `captureId` | string | on `booked` | PSP capture reference. |
| `entryId` | string | on `booked` | Ledger entry identifier. |
| `failedStep` | string | on `failed` | Which saga step stopped the booking (e.g. `"supplier.confirm"`). |
| `reason` | string | on `failed` | Machine-readable reason from the failing leg (e.g. `"insufficient_stock"`, `"card_declined"`, `"no_availability"`). |
| `compensated` | boolean | on `failed` | Whether the completed steps were unwound. |

**Example response (booked):**

```json
{
  "bookingId": "01926a7e-f1d2-7000-b6e2-c8b7a9df1234",
  "status": "booked",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "holdId": "hold-abc",
  "authorizationId": "auth-xyz",
  "confirmationId": "conf-123",
  "captureId": "cap-456",
  "entryId": "entry-789"
}
```

**Example response (failed with compensation):**

```json
{
  "bookingId": "01926a7e-f1d2-7000-b6e2-c8b7a9df5678",
  "status": "failed",
  "request": { "sku": "ECO", "qty": 1, "amount": 9900, "currency": "USD" },
  "traceId": "3a99f37ddc47b843b26b82c28a5e1987",
  "recordedAt": "2026-06-30T12:00:05.000Z",
  "failedStep": "supplier.confirm",
  "reason": "no_availability",
  "compensated": true
}
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | Missing or invalid field (`sku`, `qty`, `amount`, `currency`). Body contains `message` describing the first bad field. |
| `502 Bad Gateway` | The coordinator is unreachable or errored (the gateway itself is healthy). |

---

### `GET /bookings/:id`

Read back the recorded outcome of a booking by its identifier.

**Path parameter:** `id` — the `bookingId` returned by `POST /bookings`.

**Response — `200 OK`:** Same shape as the `POST /bookings` response body.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `404 Not Found` | No booking with this id was recorded on this gateway instance. |

**Example:**

```bash
curl -s http://localhost:3000/bookings/01926a7e-f1d2-7000-b6e2-c8b7a9df1234
```

---

### `GET /health`

Liveness probe. Returns `200 OK` with `{"status":"ok"}` when the gateway process is running.

---

## gRPC API — Internal Services

These services are called by the saga coordinator over gRPC. They are not exposed outside the docker-compose network. Each service is an idempotent command surface keyed by `booking_id`; a retried call returns the standing result rather than repeating the side effect.

gRPC errors (status codes other than `OK`) signal transport/outage failures. Business rejections are returned inside the reply message (e.g. `held = false`, `confirmed = false`) so the coordinator distinguishes a logical "no" from a service being down.

The coordinator injects the W3C `traceparent` into every outbound gRPC metadata call so each leg's SERVER span continues the booking trace.

---

### Coordinator — `signalman.coordinator.v1`

**Default address:** `localhost:5000` (`COORDINATOR_GRPC_URL` on the gateway)

#### `Coordinator.Book`

Drive the complete booking saga. Returns the result of every leg on success, or the failed step and compensation status on failure.

**Request — `BookRequest`:**

| Field | Type | Description |
|-------|------|-------------|
| `booking_id` | string | Idempotency key threaded to every leg. |
| `sku` | string | Stock-keeping unit. |
| `qty` | uint32 | Units to book. |
| `amount` | uint64 | Amount in minor currency units. |
| `currency` | string | ISO 4217 code. |

**Reply — `BookReply`:**

| Field | Type | Description |
|-------|------|-------------|
| `booked` | bool | `true` when every leg succeeded. |
| `hold_id` | string | Inventory hold reference; empty on failure. |
| `authorization_id` | string | PSP authorization reference; empty on failure. |
| `confirmation_id` | string | Supplier confirmation reference; empty on failure. |
| `capture_id` | string | PSP capture reference; empty on failure. |
| `entry_id` | string | Ledger entry id; empty on failure. |
| `failed_step` | string | Step that stopped the saga; empty on success. |
| `reason` | string | Machine-readable reason from the failed leg; empty on success. |
| `compensated` | bool | Whether completed steps were unwound; `false` on success or when the first step failed. |

---

### Inventory — `signalman.inventory.v1`

**Default address:** `localhost:5001` (`INVENTORY_GRPC_URL` on the coordinator)

#### `Inventory.Hold`

Reserve units of a SKU. Idempotent: a retry for the same `booking_id` returns the standing hold.

**Request — `HoldRequest`:**

| Field | Type | Description |
|-------|------|-------------|
| `booking_id` | string | Idempotency key. |
| `sku` | string | SKU to reserve. |
| `qty` | uint32 | Units to reserve. |

**Reply — `HoldReply`:**

| Field | Type | Description |
|-------|------|-------------|
| `held` | bool | `true` when the reservation was granted. |
| `hold_id` | string | Hold reference; empty when `held = false`. |
| `reason` | string | Rejection reason (e.g. `"insufficient_stock"`); empty when `held = true`. |
| `available` | uint32 | Units of the SKU available after the operation. |

#### `Inventory.Release`

Release a booking's hold — the saga compensation. Idempotent: releasing an already-released or unknown booking succeeds.

**Request — `ReleaseRequest`:** `booking_id` string.

**Reply — `ReleaseReply`:** `released` bool (always `true`), `hold_id` string (the released hold, or empty if nothing was held).

---

### Payments — `signalman.payments.v1`

**Default address:** `localhost:5002` (`PAYMENTS_GRPC_URL` on the coordinator)

Wraps a simulated PSP. PSP outages surface as gRPC errors; declines are carried in the reply.

#### `Payments.Authorize`

Authorize an amount against the customer's payment method. Idempotent per `booking_id`.

**Request — `AuthorizeRequest`:** `booking_id` string, `amount` uint64, `currency` string.

**Reply — `AuthorizeReply`:**

| Field | Type | Description |
|-------|------|-------------|
| `authorized` | bool | `true` when the PSP authorized the payment. |
| `payment_id` | string | Internal payment record id; empty when `authorized = false`. |
| `authorization_id` | string | PSP authorization reference; empty when `authorized = false`. |
| `reason` | string | Decline reason (e.g. `"card_declined"`); empty when `authorized = true`. |

#### `Payments.Capture`

Capture a previously authorized payment. Idempotent per `booking_id`.

**Request — `CaptureRequest`:** `booking_id` string.

**Reply — `CaptureReply`:** `captured` bool, `payment_id` string, `capture_id` string, `reason` string (e.g. `"no_authorization"` if nothing to capture).

#### `Payments.Void`

Void an authorization — the saga compensation. Idempotent.

**Request — `VoidRequest`:** `booking_id` string.

**Reply — `VoidReply`:** `voided` bool (always `true`), `payment_id` string (the voided record, or empty if nothing was live).

---

### Supplier — `signalman.supplier.v1`

**Default address:** `localhost:5003` (`SUPPLIER_GRPC_URL` on the coordinator)

Wraps a simulated external partner — deliberately slow and flaky, because this boundary is where divergence is born. Partner outages surface as gRPC errors; rejections are carried in the reply.

#### `Supplier.Confirm`

Confirm a booking with the partner. Idempotent per `booking_id`.

**Request — `ConfirmRequest`:** `booking_id` string, `sku` string, `qty` uint32.

**Reply — `ConfirmReply`:**

| Field | Type | Description |
|-------|------|-------------|
| `confirmed` | bool | `true` when the partner confirmed. |
| `confirmation_id` | string | Partner's confirmation reference; empty when `confirmed = false`. |
| `reason` | string | Rejection reason (e.g. `"no_availability"`); empty when `confirmed = true`. |

#### `Supplier.Cancel`

Cancel a partner confirmation — the saga compensation. Idempotent.

**Request — `CancelRequest`:** `booking_id` string.

**Reply — `CancelReply`:** `cancelled` bool (always `true`), `confirmation_id` string (the cancelled reference, or empty if nothing was live).

---

### Ledger — `signalman.ledger.v1`

**Default address:** `localhost:5004` (`LEDGER_GRPC_URL` on the coordinator)

The internal financial-record source of truth. Unlike the other legs it wraps no external system, so a commit either succeeds or is rejected as invalid data — there is no outage path.

#### `Ledger.Commit`

Post a booking's amount to the financial record. Idempotent per `booking_id`.

**Request — `CommitRequest`:** `booking_id` string, `amount` uint64 (must be positive), `currency` string, `capture_id` string (optional; ties the entry to the PSP capture).

**Reply — `CommitReply`:**

| Field | Type | Description |
|-------|------|-------------|
| `committed` | bool | `true` when the entry was posted. |
| `entry_id` | string | Ledger entry id; empty when `committed = false`. |
| `reason` | string | Rejection reason (e.g. `"invalid_amount"`); empty when `committed = true`. |

#### `Ledger.Reverse`

Reverse a ledger entry — the saga compensation. Idempotent.

**Request — `ReverseRequest`:** `booking_id` string.

**Reply — `ReverseReply`:** `reversed` bool (always `true`), `entry_id` string (the reversed entry, or empty if nothing was live).

---

## Async Events

Every producing service stages events transactionally (the **outbox pattern**) and the relay publishes them to the configured broker. All events carry W3C `traceparent` and `tracestate` headers so a consumer can continue the booking trace. The default broker is in-memory; set `BROKER=nats` with `NATS_URL` to use JetStream.

Consumers that process a message more than once (due to broker redelivery) are safe because they are wrapped in the idempotent inbox (`@signalman/inbox`), which deduplicates by message id.

### Event subjects

| Subject | Produced by | Consumed by | Payload fields |
|---------|-------------|-------------|----------------|
| `inventory.held` | `inventory` | reconciler | `bookingId`, `holdId`, `sku`, `qty` |
| `inventory.released` | `inventory` | reconciler | `bookingId`, `holdId` |
| `payment.authorized` | `payments` | — | `bookingId`, `paymentId`, `authorizationId` |
| `payment.captured` | `payments` | — | `bookingId`, `paymentId`, `captureId` |
| `payment.voided` | `payments` | — | `bookingId`, `paymentId` |
| `supplier.confirmed` | `supplier` | reconciler | `bookingId`, `confirmationId`, `sku`, `qty` |
| `supplier.cancelled` | `supplier` | reconciler | `bookingId`, `confirmationId` |
| `ledger.committed` | `ledger` | notifier, reconciler | `bookingId`, `entryId`, `amount`, `currency` |
| `ledger.reversed` | `ledger` | reconciler | `bookingId`, `entryId` |

Fan-out consumers (notifier and reconciler both subscribe to `ledger.*`) receive their own copy of each message. Each starts a new trace and carries a **span link** back to the producer span — so the notifier's trace and the reconciler's trace are independent but navigable to the original booking trace.

---

## Environment Variables

### Gateway

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port. |
| `COORDINATOR_GRPC_URL` | `localhost:5000` | gRPC address of the coordinator service. |
| `POSTGRES_URL` | — | Postgres connection string. When set, booking records are persisted in `gateway.bookings`. Without it, an in-memory store is used (records lost on restart). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint for traces and metrics. |

### Coordinator

| Variable | Default | Description |
|----------|---------|-------------|
| `INVENTORY_GRPC_URL` | `localhost:5001` | Inventory service gRPC address. |
| `PAYMENTS_GRPC_URL` | `localhost:5002` | Payments service gRPC address. |
| `SUPPLIER_GRPC_URL` | `localhost:5003` | Supplier service gRPC address. |
| `LEDGER_GRPC_URL` | `localhost:5004` | Ledger service gRPC address. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Inventory

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_URL` | — | Enables the Postgres-backed hold repository and outbox store. |
| `BROKER` | `memory` | Broker transport: `memory` (in-process) or `nats`. |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL (used when `BROKER=nats`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Payments

| Variable | Default | Description |
|----------|---------|-------------|
| `PSP_LATENCY_MS` | `50` | Simulated PSP response latency (ms). |
| `PSP_DECLINE_RATE` | `0` | Fraction of PSP calls that return a business decline (0–1). |
| `PSP_FAILURE_RATE` | `0` | Fraction of PSP calls that throw (simulate outage) (0–1). |
| `POSTGRES_URL` | — | Enables the Postgres-backed payment repository and outbox store. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Supplier

| Variable | Default | Description |
|----------|---------|-------------|
| `SUPPLIER_LATENCY_MS` | `200` | Simulated partner response latency (ms) — deliberately higher than the PSP. |
| `SUPPLIER_REJECT_RATE` | `0` | Fraction of partner calls that return a business rejection (0–1). |
| `SUPPLIER_FAILURE_RATE` | `0` | Fraction of partner calls that throw (simulate outage) (0–1). Set to `1` to force the saga to compensate every time. |
| `POSTGRES_URL` | — | Enables the Postgres-backed confirmation repository and outbox store. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Ledger

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_URL` | — | Enables the Postgres-backed entry repository and outbox store. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Notifier

| Variable | Default | Description |
|----------|---------|-------------|
| `NOTIFIER_LATENCY_MS` | `100` | Simulated notification-provider latency (ms). |
| `NOTIFIER_FAILURE_RATE` | `0` | Fraction of provider sends that throw (simulate outage) (0–1). A failed send NACKs so the broker redelivers. |
| `BROKER` | `memory` | Broker transport. |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Reconciler

| Variable | Default | Description |
|----------|---------|-------------|
| `RECONCILER_INTERVAL_MS` | `30000` | How often to run a reconciliation pass (ms). |
| `RECONCILER_SETTLE_GRACE_MS` | `5000` | A booking is not eligible for reconciliation until this many ms after its last source-of-truth event, so in-flight sagas are never mistaken for divergences. |
| `BROKER` | `memory` | Broker transport used to subscribe to source-of-truth events. |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP endpoint. |

### Shared / infrastructure

| Variable | Where used | Description |
|----------|-----------|-------------|
| `SERVICE_NAME` | All services | Sets `service.name` on OTel spans; the `Dockerfile` sets this per container. |
| `BROKER` | All services | `memory` (default, no infrastructure) or `nats` (JetStream in docker-compose). |
| `NATS_URL` | All services | NATS JetStream server URL (e.g. `nats://nats:4222` inside docker-compose). |
| `POSTGRES_URL` | All data-bearing services | `postgres://user:pass@host:5432/dbname`; enables persistent stores and the Postgres-backed outbox. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | All services | OTLP/HTTP endpoint; set to `http://otel-collector:4318` in docker-compose. |

---

## Error catalogue

### Saga failure reasons

These values appear in `BookingRecord.reason` (HTTP) and `BookReply.reason` (gRPC) when a business rejection stops the saga.

| Reason | From | Meaning |
|--------|------|---------|
| `insufficient_stock` | Inventory | Not enough units of the SKU available. |
| `card_declined` | Payments | The simulated PSP declined the authorization. |
| `no_availability` | Supplier | The simulated partner rejected the confirmation. |
| `invalid_amount` | Ledger | The commit amount was zero or negative. |
| `no_authorization` | Payments | A capture was attempted with no live authorization. |
| `authorization_voided` | Payments | A capture was attempted on an authorization that was already voided. |

Transport failures (gRPC errors from a service being down) propagate as a `502` at the HTTP layer, with a machine-readable message in the `message` field of the error body.

---

## Observability

Every booking produces one connected trace starting at the `POST /bookings` SERVER span. The `traceId` in every `BookingRecord` response is the W3C trace id; paste it into Grafana's Tempo explore view to jump straight to the full span tree.

Grafana is available at `http://localhost:3001` after `docker-compose up`. The pre-provisioned **Signalman** dashboard shows:
- **Booking saga — RED**: rate, error ratio, and p50/p99 latency across the whole saga.
- **Per-service RED**: same metrics broken down by service.
- **Booking saga — per-step SLOs**: 14 stat panels (one latency + one error-rate SLO per forward saga step), green / yellow / red against step-specific thresholds.
- **Trace explorer**: a live trace search panel linked to the Tempo datasource.

Metric exemplars on each panel carry the trace ID of the request that produced the data point, so a metric spike links directly to the span that caused it.
