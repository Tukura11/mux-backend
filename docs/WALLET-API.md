# Wallet API

This document describes the wallet-facing HTTP API exposed by `mux-backend`.
All endpoints are authenticated and deny-by-default: a request that cannot be
proven to come from an authorized principal is rejected before any state is
mutated.

## Authentication

Every wallet endpoint requires one of the following credentials. The server is
the source of truth for authorization; clients cannot bypass policy by
supplying a `successor_id` or any other field.

| Credential | Header | Notes |
| --- | --- | --- |
| Owner JWT | `Authorization: Bearer <jwt>` | Issued to the wallet owner. |
| Delegate JWT | `Authorization: Bearer <jwt>` | Scoped to a wallet; may be revoked. |
| Guardian JWT | `Authorization: Bearer <jwt>` | Recovery-only surface. |
| API key | `X-API-Key: <key>` | Server-to-server; never logged. |

JWTs and API keys are redacted from logs and error payloads. Never echo raw key
material, JWTs, or webhook secrets in responses.

## Authorization

Wallet orchestration is deny-by-default. Every orchestration entrypoint
requires a valid API key **and** an authenticated principal, and the caller
must be the wallet owner or an explicitly granted delegate/guardian for the
target `userId`/`network` pair. Requests that present a valid API key but no
matching owner/delegate/guardian grant are rejected with `403`; requests with
no credentials at all are rejected with `401`. A revoked delegate is treated
exactly like a missing grant. Clients cannot bypass policy by supplying a
`userId` in the body or path that they do not own.

## Error codes

Orchestration responses use a stable error envelope. Every error carries a
`code`, a human-readable `message`, and a `correlationId` that matches the
`X-Request-Id` response header so operators can trace a single request across
logs and metrics.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `WALLET_UNAUTHORIZED` | `401` | Missing or invalid credentials. |
| `WALLET_FORBIDDEN` | `403` | Authenticated but not owner/delegate/guardian. |
| `WALLET_NOT_FOUND` | `404` | No wallet for the requested user/network. |
| `WALLET_ALREADY_EXISTS` | `409` | Active wallet already exists for the pair. |
| `WALLET_IDEMPOTENCY_CONFLICT` | `409` | Idempotency key reused for a different user/network. |
| `WALLET_DEPENDENCY_UNAVAILABLE` | `503` | Key-management or RPC dependency failed; write was not committed. |
| `WALLET_ORCHESTRATION_DISABLED` | `503` | Feature flag is off for this network. |

## Idempotency

Every request may carry `X-Correlation-Id`. If absent, the server generates one
and returns it in the response header. All error responses include the same
correlation id so operators can trace a failure end-to-end.

## Error envelope

All errors share a stable shape:

```json
{
  "error": {
    "code": "WALLET_SUCCESSOR_SELF_REFERENCE",
    "message": "A wallet cannot be its own successor.",
    "correlation_id": "c0ffee00-0000-4000-8000-000000000000"
  }
}
```

Stable error codes for the successor surface:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `WALLET_NOT_FOUND` | 404 | Target wallet does not exist. |
| `WALLET_SUCCESSOR_NOT_FOUND` | 404 | `successor_id` does not resolve to a wallet. |
| `WALLET_SUCCESSOR_SELF_REFERENCE` | 422 | `successor_id` equals the wallet id. |
| `WALLET_SUCCESSOR_CYCLE` | 422 | Assignment would create a successor cycle. |
| `WALLET_SUCCESSOR_ALREADY_SET` | 409 | Wallet already has an active successor. |
| `WALLET_SUCCESSOR_NOT_AUTHORIZED` | 403 | Caller is not owner/delegate/guardian for this wallet. |
| `WALLET_SUCCESSOR_DELEGATE_REVOKED` | 403 | Delegate credential has been revoked. |
| `WALLET_SUCCESSOR_DEPENDENCY_UNAVAILABLE` | 503 | RPC/DB/Horizon unavailable; write failed closed. |
| `WALLET_SUCCESSOR_IDEMPOTENCY_CONFLICT` | 409 | Same idempotency key reused with a different payload. |

## Successor semantics

A wallet may have at most one **active successor**. The `successor_id` field is
the canonical pointer used by recovery and spend delegation. The following
invariants are enforced server-side on every write:

1. **Existence** — `successor_id` must resolve to a wallet that exists.
2. **No self-reference** — a wallet cannot be its own successor.
3. **No cycles** — following `successor_id` from any wallet must terminate; the
   server rejects assignments that would introduce a cycle.
4. **Single active successor** — a wallet with an active successor must have it
   explicitly cleared before a new one is assigned.
5. **Authorization** — only the owner, an unrevoked delegate, or a guardian may
   set or clear a successor. API keys are deny-by-default for this surface
   unless explicitly granted the `wallet:successor:write` scope.
6. **Idempotency** — writes accept an `Idempotency-Key` header. Replaying the
   same key with the same payload returns the original result; replaying with a
   different payload returns `WALLET_SUCCESSOR_IDEMPOTENCY_CONFLICT`.
7. **Fail-closed** — if the RPC, database, or Horizon dependency is unavailable,
   the write is rejected with `WALLET_SUCCESSOR_DEPENDENCY_UNAVAILABLE` and no
   partial state is persisted.

### Set successor

```
PUT /wallets/{wallet_id}/successor
Authorization: Bearer <jwt>
Idempotency-Key: <opaque>
X-Correlation-Id: <opaque>

{ "successor_id": "<wallet_id>" }
```

Returns `200` with the updated wallet on success. Returns the error envelope
above on failure.

### Clear successor

```
DELETE /wallets/{wallet_id}/successor
Authorization: Bearer <jwt>
Idempotency-Key: <opaque>
X-Correlation-Id: <opaque>
```

Clearing is idempotent: clearing an already-cleared successor returns `200`.

### Read successor

```
GET /wallets/{wallet_id}/successor
Authorization: Bearer <jwt>
```

Returns `{ "successor_id": "<wallet_id>" | null }`.

## Observability

Successor writes emit structured logs and metrics on the money path:

- `wallet_successor_write_total{result="ok|error",code="..."}`
- `wallet_successor_write_latency_seconds`
- `wallet_successor_dependency_failures_total{dependency="rpc|db|horizon"}`

Logs include the correlation id and wallet id only. They never include JWTs,
API keys, webhook secrets, or raw key material.

## Feature flag / kill switch

Successor writes are gated behind the `WALLET_SUCCESSOR_WRITES_ENABLED` flag.
When disabled, the endpoints return `503 WALLET_SUCCESSOR_DEPENDENCY_UNAVAILABLE`
and no state is mutated. This flag is the documented rollback lever for
mainnet-affecting changes; see the runbook for the rollback procedure.

## References

- `prisma/migrations/20260601000000_add_wallet_successor_id/`
