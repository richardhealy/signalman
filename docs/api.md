# Signalman — API Reference

This document is the complete API reference for Signalman. The system exposes
two kinds of surfaces:

- **HTTP** — the gateway is the only public HTTP surface. Clients send bookings
  here; the gateway opens the booking trace and drives the saga.
- **gRPC** — five internal services expose gRPC contracts consumed by the
  coordinator. These are internal and not meant to be called by external
  clients, but are documented here for operators and integration authors.

All gRPC services use **proto3** with a package path of
`signalman.<service>.v1`. Proto source files live under
`services/<service>/src/proto/`.

---

## Table of contents

1. [HTTP API — Gateway](#1-http-api--gateway)
   - [POST /bookings](#post-bookings)
   - [GET /bookings/:id](#get-bookingsid)
   - [GET /health](#get-health)
2. [gRPC — Coordinator](#2-grpc--coordinator)
   - [Book](#book)
3. [gRPC — Inventory](#3-grpc--inventory)
   - [Hold](#hold)
   - [Release](#release)
4. [gRPC — Payments](#4-grpc--payments)
   - [Authorize](#authorize)
   - [Capture](#capture)
   - [Void](#void)
5. [gRPC — Supplier](#5-grpc--supplier)
   - [Confirm](#confirm)
   - [Cancel](#cancel)
6. [gRPC — Ledger](#6-grpc--ledger)
   - [Commit](#commit)
   - [Reverse](#reverse)
7. [Error catalogue](#7-error-catalogue)
8. [Trace propagation](#8-trace-propagation)
9. [Async events](#9-async-events)

---

## 1. HTTP API — Gateway

**Base URL:** `http://localhost:3000` (docker-compose default).

No authentication is required for the demo stack. The gateway performs
field-level validation and returns `400` on malformed requests.

All responses are JSON. `Content-Type: application/json` is the default.

---

### POST /bookings

Start a booking. The gateway validates the request body, mints a `bookingId`
if the caller omits one, and drives the booking saga synchronously through the
coordinator. The saga runs `hold → authorize → confirm → capture → commit` and
fires compensations in reverse on any failure.

The response is always `201 Created` when the gateway recorded an outcome —
whether the saga completed or stopped on a business failure. The `status` field
distinguishes the two cases. The gateway records a `502 Bad Gateway` only when
the coordinator is unreachable.

**Request body**

```json
{
  "sku": "SEAT-A1",
  "qty": 2,
  "amount": 15000,
  "currency": "USD",
  "bookingId": "bk_01HXYZ"
}
```

| Field       | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `sku`       | string | Yes      | Stock-keeping unit to book (e.g. a seat class or room-night). |
| `qty`       | int    | Yes      | Number of units to book. Must be a positive integer. |
| `amount`    | int    | Yes      | Amount to take, in the currency's minor units (e.g. 15000 = $150.00 USD). Must be a positive integer. |
| `currency`  | string | Yes      | ISO 4217 currency code, e.g. `"USD"`. |
| `bookingId` | string | No       | Caller-supplied idempotency key. The gateway mints a UUID when omitted. Retrying `POST /bookings` with the same `bookingId` is safe — the saga legs are idempotent per booking id. |

**Response — 201 Created (booked)**

```json
{
  "bookingId": "bk_01HXYZ",
  "status": "booked",
  "request": { "sku": "SEAT-A1", "qty": 2, "amount": 15000, "currency": "USD" },
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "holdId": "hold_abc123",
  "authorizationId": "auth_def456",
  "confirmationId": "conf_ghi789",
  "captureId": "cap_jkl012",
  "entryId": "entry_mno345"
}
```

**Response — 201 Created (failed)**

```json
{
  "bookingId": "bk_01HXYZ",
  "status": "failed",
  "request": { "sku": "SEAT-A1", "qty": 2, "amount": 15000, "currency": "USD" },
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "recordedAt": "2026-06-30T12:00:00.000Z",
  "failedStep": "supplier.confirm",
  "reason": "no_availability",
  "compensated": true
}
```

**BookingRecord fields**

| Field             | Type    | When present   | Description |
|-------------------|---------|----------------|-------------|
| `bookingId`       | string  | Always         | The booking's id. |
| `status`          | string  | Always         | `"booked"` or `"failed"`. |
| `request`         | object  | Always         | The originating request fields, echoed back. |
| `traceId`         | string  | Always         | Trace id of the request's span; use it to jump to the booking trace in Grafana. |
| `recordedAt`      | string  | Always         | ISO-8601 instant the outcome was recorded. |
| `holdId`          | string  | booked only    | Inventory's hold reference. |
| `authorizationId` | string  | booked only    | PSP's authorization reference. |
| `confirmationId`  | string  | booked only    | Supplier's confirmation reference. |
| `captureId`       | string  | booked only    | PSP's capture reference. |
| `entryId`         | string  | booked only    | Ledger entry id. |
| `failedStep`      | string  | failed only    | The saga step that stopped (e.g. `"supplier.confirm"`). |
| `reason`          | string  | failed only    | Machine-readable failure reason (e.g. `"insufficient_stock"`). |
| `compensated`     | boolean | failed only    | Whether the completed steps were unwound by compensations. |

**Error responses**

| Status | Condition |
|--------|-----------|
| 400    | Malformed request body (missing required field, wrong type, non-positive integer). |
| 502    | Coordinator unreachable or threw an unexpected error. |

---

### GET /bookings/:id

Read back the recorded outcome of a booking. Returns the same `BookingRecord`
shape as `POST /bookings`. Useful for polling a booking's fate or retrieving
the `traceId` to navigate to the booking's trace.

**Path parameter**

| Parameter | Type   | Description |
|-----------|--------|-------------|
| `id`      | string | The `bookingId` as returned by `POST /bookings`. |

**Response — 200 OK**

Same `BookingRecord` shape as `POST /bookings`.

**Error responses**

| Status | Condition |
|--------|-----------|
| 404    | No booking recorded for the given id. |

---

### GET /health

Liveness/readiness probe. Returns `200 OK` when the gateway process is up.
This endpoint does **not** check the health of downstream services — it only
reports that the gateway process itself is alive.

**Response — 200 OK**

```json
{ "status": "ok", "service": "gateway" }
```

---

## 2. gRPC — Coordinator

**Package:** `signalman.coordinator.v1`  
**Service:** `Coordinator`  
**Proto:** `services/coordinator/src/proto/coordinator.proto`

The coordinator is the saga orchestrator. The gateway is its only caller in
the production system.

---

### Book

Drive the booking saga to completion.

The saga runs the five forward steps in order:
`inventory.Hold → payments.Authorize → supplier.Confirm → payments.Capture → ledger.Commit`.

On any rejection (a leg's business "no") or outage (a thrown error), the
completed steps are compensated in reverse:
`supplier.Cancel → payments.Void → inventory.Release`.

Idempotency is delegated to the legs: every downstream command is keyed by
`booking_id`, so a retried `Book` replays the saga without double-booking.

**Request — `BookRequest`**

| Field       | Type   | Description |
|-------------|--------|-------------|
| `booking_id`| string | The booking's id; threaded to every leg as the idempotency key. |
| `sku`       | string | The stock-keeping unit to book. |
| `qty`       | uint32 | How many units to book. |
| `amount`    | uint64 | Amount to take, in the currency's minor units. |
| `currency`  | string | ISO 4217 currency code. |

**Reply — `BookReply`**

| Field              | Type   | When set     | Description |
|--------------------|--------|--------------|-------------|
| `booked`           | bool   | Always       | Whether every leg succeeded. |
| `hold_id`          | string | booked only  | Inventory's hold reference. |
| `authorization_id` | string | booked only  | PSP's authorization reference. |
| `confirmation_id`  | string | booked only  | Supplier's confirmation reference. |
| `capture_id`       | string | booked only  | PSP's capture reference. |
| `entry_id`         | string | booked only  | Ledger entry id. |
| `failed_step`      | string | failed only  | The saga step that stopped (e.g. `"supplier.confirm"`). |
| `reason`           | string | failed only  | Machine-readable failure reason. |
| `compensated`      | bool   | failed only  | Whether compensations ran. False when the very first step failed. |

---

## 3. gRPC — Inventory

**Package:** `signalman.inventory.v1`  
**Service:** `Inventory`  
**Proto:** `services/inventory/src/proto/inventory.proto`

Inventory owns availability and holds. The coordinator is its only caller.

---

### Hold

Reserve `qty` of `sku` for a booking.

Idempotent per booking: a retry returns the standing hold rather than
reserving twice. An over-capacity request is rejected with `held = false` and
a `reason`.

**Request — `HoldRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking the reservation belongs to; also the idempotency key. |
| `sku`        | string | The stock-keeping unit to reserve. |
| `qty`        | uint32 | How many units to reserve. |

**Reply — `HoldReply`**

| Field       | Type   | When set      | Description |
|-------------|--------|---------------|-------------|
| `held`      | bool   | Always        | Whether the reservation was granted. |
| `hold_id`   | string | held = true   | The hold's id. |
| `reason`    | string | held = false  | Machine-readable rejection reason (e.g. `"insufficient_stock"`). |
| `available` | uint32 | Always        | Units of `sku` remaining available after the operation. |

---

### Release

Release a booking's hold — the saga compensation.

Idempotent: releasing an already-released or unknown booking succeeds without
over-restoring stock.

**Request — `ReleaseRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking whose hold should be released. |

**Reply — `ReleaseReply`**

| Field     | Type   | Description |
|-----------|--------|-------------|
| `released`| bool   | Always true once the booking holds no inventory (the desired end state). |
| `hold_id` | string | The released hold's id; empty when there was nothing to release. |

---

## 4. gRPC — Payments

**Package:** `signalman.payments.v1`  
**Service:** `Payments`  
**Proto:** `services/payments/src/proto/payments.proto`

Payments owns authorizations and captures, wrapping a simulated PSP. The
coordinator is its only caller.

A PSP **decline** is a business rejection (`authorized = false` with a
`reason`). A PSP **outage** surfaces as a gRPC error — the external hop is a
CLIENT span in the booking trace and is observable in Grafana.

---

### Authorize

Authorize `amount` against the customer's method of payment.

Idempotent per booking: a retry returns the standing authorization.

**Request — `AuthorizeRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking the payment belongs to; also the idempotency key. |
| `amount`     | uint64 | Amount to authorize, in the currency's minor units. |
| `currency`   | string | ISO 4217 currency code. |

**Reply — `AuthorizeReply`**

| Field              | Type   | When set           | Description |
|--------------------|--------|--------------------|-------------|
| `authorized`       | bool   | Always             | Whether the PSP granted the authorization. |
| `payment_id`       | string | authorized = true  | Our internal payment record id. |
| `authorization_id` | string | authorized = true  | The PSP's authorization reference (the external truth handle). |
| `reason`           | string | authorized = false | Machine-readable decline reason (e.g. `"card_declined"`). |

---

### Capture

Capture a previously authorized payment — the saga's money-taking step.

Idempotent per booking: a retry returns the standing capture.

**Request — `CaptureRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking whose authorization should be captured. |

**Reply — `CaptureReply`**

| Field        | Type   | When set          | Description |
|--------------|--------|-------------------|-------------|
| `captured`   | bool   | Always            | Whether the capture succeeded. |
| `payment_id` | string | captured = true   | Our internal payment record id. |
| `capture_id` | string | captured = true   | The PSP's capture reference. |
| `reason`     | string | captured = false  | Machine-readable reason (e.g. `"no_authorization"`). |

---

### Void

Void a booking's authorization — the saga compensation.

Idempotent: voiding an already-voided or unknown booking succeeds without
double-voiding.

**Request — `VoidRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking whose authorization should be voided. |

**Reply — `VoidReply`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `voided`     | bool   | Always true once the booking holds no live authorization. |
| `payment_id` | string | The voided payment record id; empty when there was nothing to void. |

---

## 5. gRPC — Supplier

**Package:** `signalman.supplier.v1`  
**Service:** `Supplier`  
**Proto:** `services/supplier/src/proto/supplier.proto`

Supplier confirms reservations with a simulated external partner —
deliberately slow and flaky, because this is where divergence is born. The
coordinator is its only caller.

A partner **rejection** is returned as data (`confirmed = false` with a
`reason`). A partner **outage** surfaces as a gRPC error — the external hop is
a CLIENT span and is observable in Grafana.

---

### Confirm

Confirm a booking with the external partner.

Idempotent per booking: a retry returns the standing confirmation.

**Request — `ConfirmRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking the confirmation belongs to; also the idempotency key. |
| `sku`        | string | The SKU being confirmed, mirroring what inventory held. |
| `qty`        | uint32 | How many units to confirm. |

**Reply — `ConfirmReply`**

| Field             | Type   | When set            | Description |
|-------------------|--------|---------------------|-------------|
| `confirmed`       | bool   | Always              | Whether the partner confirmed the booking. |
| `confirmation_id` | string | confirmed = true    | The partner's confirmation reference — the external truth handle the reconciler matches against other sources. |
| `reason`          | string | confirmed = false   | Machine-readable rejection reason (e.g. `"no_availability"`). |

---

### Cancel

Cancel a booking's confirmation — the saga compensation.

Idempotent: cancelling an already-cancelled or unknown booking succeeds.

**Request — `CancelRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking whose confirmation should be cancelled. |

**Reply — `CancelReply`**

| Field             | Type   | Description |
|-------------------|--------|-------------|
| `cancelled`       | bool   | Always true once the booking holds no live confirmation. |
| `confirmation_id` | string | The cancelled partner confirmation reference; empty when nothing to cancel. |

---

## 6. gRPC — Ledger

**Package:** `signalman.ledger.v1`  
**Service:** `Ledger`  
**Proto:** `services/ledger/src/proto/ledger.proto`

Ledger owns the financial record of what actually happened. Unlike the other
legs it wraps no external system, so a commit is an internal posting — the
only non-commit outcome is a business rejection, not an outage.

---

### Commit

Post a booking's money to the financial record — the saga's final forward step
after `payments.Capture`.

Idempotent per booking: a retry returns the standing entry.

**Request — `CommitRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking the entry belongs to; also the idempotency key. |
| `amount`     | uint64 | Amount to post, in the currency's minor units. Must be positive. |
| `currency`   | string | ISO 4217 currency code. |
| `capture_id` | string | The PSP capture reference, tying the financial record to the money payments took. May be empty. |

**Reply — `CommitReply`**

| Field       | Type   | When set          | Description |
|-------------|--------|-------------------|-------------|
| `committed` | bool   | Always            | Whether the entry was posted. |
| `entry_id`  | string | committed = true  | The ledger entry's id — the truth handle the reconciler matches. |
| `reason`    | string | committed = false | Machine-readable rejection reason (e.g. `"invalid_amount"`). |

---

### Reverse

Reverse a booking's ledger entry — the saga compensation.

Idempotent: reversing an already-reversed or unknown booking succeeds.

**Request — `ReverseRequest`**

| Field        | Type   | Description |
|--------------|--------|-------------|
| `booking_id` | string | The booking whose ledger entry should be reversed. |

**Reply — `ReverseReply`**

| Field      | Type   | Description |
|------------|--------|-------------|
| `reversed` | bool   | Always true once the booking holds no live entry. |
| `entry_id` | string | The reversed entry's id; empty when nothing to reverse. |

---

## 7. Error catalogue

### HTTP errors

| Status | Description |
|--------|-------------|
| 400 Bad Request    | Malformed request body — missing a required field, wrong type, or a non-positive value for `qty` or `amount`. The response body carries `{"statusCode":400,"message":"<field-level description>"}`. |
| 404 Not Found      | `GET /bookings/:id` — no booking recorded for the given id. |
| 502 Bad Gateway    | `POST /bookings` — the coordinator was unreachable or threw an unexpected error. The gateway is healthy; its downstream is not. |

### gRPC errors

The gRPC services deliberately return **business rejections as reply data**
(e.g. `held = false`) rather than as gRPC status codes, so the coordinator can
distinguish a leg's "no" from a transport failure. The only gRPC-level errors
are:

| Code | Description |
|------|-------------|
| UNAVAILABLE    | The service process is down or the dial-timeout expired. |
| INTERNAL       | An unexpected error inside the service (logged and traced). |

When a leg's external boundary (PSP, supplier partner) fails, the leg surfaces
it as a gRPC `INTERNAL` error so the coordinator can compensate the saga and
the failure appears as an errored CLIENT span in the booking trace.

### Business rejection reasons

| Reason                      | Service   | Operation    | Description |
|-----------------------------|-----------|--------------|-------------|
| `insufficient_stock`        | Inventory | Hold         | The requested quantity exceeds available inventory. |
| `card_declined`             | Payments  | Authorize    | The simulated PSP declined the authorization. |
| `no_availability`           | Supplier  | Confirm      | The simulated partner rejected the confirmation. |
| `invalid_amount`            | Ledger    | Commit       | A non-positive `amount` was supplied. |
| `no_authorization`          | Payments  | Capture      | No live authorization exists for the booking (e.g. was already voided). |
| `authorization_voided`      | Payments  | Capture      | The authorization was already voided before capture. |

---

## 8. Trace propagation

Every booking is one connected trace. The W3C `traceparent` header is the
propagation mechanism:

- The gateway's `POST /bookings` SERVER span is the **root** of the booking
  trace. Its `traceId` is recorded on the `BookingRecord` and returned to the
  caller.
- The gateway injects `traceparent` into the gRPC metadata on its coordinator
  call; the coordinator continues that trace as a SERVER child span.
- The coordinator injects `traceparent` into the gRPC metadata on each leg
  call; each leg continues the same trace as a SERVER child span.
- When a leg publishes an outbox event, the relay injects the span context into
  the broker message headers; the consumer extracts it and its CONSUMER span
  continues the same trace.
- Fan-out consumers (e.g. the notifier and reconciler both consuming
  `ledger.committed`) open a **new root trace** with a **span link** to the
  producer span — so each consumer's trace is independent but navigable to its
  source event via the link.

The `traceId` in a `BookingRecord` or a reconciler `DivergenceFinding` is a
direct link to the trace in Grafana Tempo (`localhost:3001`).

---

## 9. Async events

The saga legs publish events through the transactional outbox onto the broker
(`NATS JetStream` in the docker stack). These events are internal to the
system and are not intended as a public API, but operators may consume them for
monitoring or integration.

| Subject                  | Published by | Payload summary |
|--------------------------|-------------|-----------------|
| `inventory.held`         | Inventory   | `bookingId`, `holdId`, `sku`, `qty` |
| `inventory.released`     | Inventory   | `bookingId`, `holdId` |
| `payment.authorized`     | Payments    | `bookingId`, `paymentId`, `authorizationId`, `amount`, `currency` |
| `payment.captured`       | Payments    | `bookingId`, `paymentId`, `captureId` |
| `payment.voided`         | Payments    | `bookingId`, `paymentId` |
| `supplier.confirmed`     | Supplier    | `bookingId`, `confirmationId`, `sku`, `qty` |
| `supplier.cancelled`     | Supplier    | `bookingId`, `confirmationId` |
| `ledger.committed`       | Ledger      | `bookingId`, `entryId`, `amount`, `currency` |
| `ledger.reversed`        | Ledger      | `bookingId`, `entryId` |

All messages carry W3C `traceparent` in their headers so consumers can
continue the booking trace. Message ids are stable per outbox record and serve
as the dedup key for idempotent consumers.

The reconciler subscribes to `inventory.*`, `supplier.*`, and `ledger.*` to
build its cross-service source-of-truth snapshot; the notifier subscribes to
`ledger.committed` to drive the customer notification.
