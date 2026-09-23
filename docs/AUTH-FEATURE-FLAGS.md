# Auth & Feature Flags

# Auth & Feature Flags

This document describes the authorization model and feature-flag / kill-switch
surface used by the invisible-wallet orchestration path, and summarizes the
feature flags added for the auth and session endpoints, including the
provider-selection flags used to unify Clerk and Better Auth behind a single
auth surface. It is the companion to
[`docs/WALLET-API.md`](./WALLET-API.md) and is intended for Stellar Wave
contributors working on wallet orchestration.

## Invariants

1. The server is the source of truth for spends, recovery, and admin actions.
   Clients cannot bypass policy by calling the wallet API directly.
2. Every privileged entrypoint is **deny-by-default**: if the caller's role,
   delegate status, or feature flag cannot be positively verified, the request
   is rejected.
3. Money-path and mainnet-affecting behavior is gated behind a feature flag or
   kill-switch. When the flag is off, the endpoint fails closed with a stable
error code rather than silently degrading.
4. All external entrypoints are rate-limited and authorized. Correlation ids
   are propagated on every request and echoed in error envelopes.

## Roles

| Role      | Source                          | Can orchestrate wallets | Can spend | Can recover |
|-----------|---------------------------------|-------------------------|-----------|-------------|
| owner     | wallet record                   | yes                     | yes       | yes         |
| delegate  | signed delegation, not revoked  | yes                     | per grant | no          |
| guardian  | recovery config                 | no                      | no        | yes         |
| api-key   | server-issued, scoped           | per scope               | per scope | no          |
| jwt       | session token, unexpired        | per scope               | per scope | no          |

A revoked delegate, an expired JWT, or a wrong role must be rejected before any
wallet state is mutated.

## Feature flags

Flags are read from the environment and default to **off** in production unless
explicitly enabled. The wallet orchestration path uses:

- `WALLET_ORCHESTRATION_ENABLED` — master switch for the orchestration
  entrypoints. When unset or `false`, orchestration requests fail closed with
  `WALLET_ORCHESTRATION_DISABLED`.
- `WALLET_ORCHESTRATION_MAINNET_ENABLED` — additional gate for mainnet. Testnet
  may be enabled independently; mainnet requires both flags.

### Kill-switch

Setting `WALLET_ORCHESTRATION_ENABLED=false` disables the orchestration path
without a deploy. In-flight requests complete; new requests are rejected with
the stable error code above. This is the documented rollback for the
orchestration change.

## Stable error codes

| Code                              | Meaning                                              |
|-----------------------------------|------------------------------------------------------|
| `WALLET_ORCHESTRATION_DISABLED`   | Feature flag off; fail closed.                       |
| `WALLET_AUTHZ_DENIED`             | Caller lacks owner/delegate/guardian/scope rights.   |
| `WALLET_DELEGATE_REVOKED`         | Delegate grant revoked or expired.                   |
| `WALLET_IDEMPOTENCY_CONFLICT`     | Replayed request with a different payload.           |
| `WALLET_DEPENDENCY_UNAVAILABLE`   | RPC/DB/Horizon outage; writes fail closed.           |

Errors are returned in the shared error envelope and include the request
correlation id. Secrets, JWTs, webhook secrets, and raw key material are never
logged or returned.

## Idempotency

Concurrent or replayed orchestration requests must carry an idempotency key.
The server stores the key with the resulting response; a replay with the same
payload returns the stored response, and a replay with a different payload is
rejected with `WALLET_IDEMPOTENCY_CONFLICT`.

## Testnet vs mainnet

Misconfiguration is treated as a failure mode: if the environment is mainnet
and `WALLET_ORCHESTRATION_MAINNET_ENABLED` is not set, orchestration fails
closed. Testnet defaults are documented in [`docs/WALLET-API.md`](./WALLET-API.md).

## Auth API flag

- `FEATURE_AUTH_API` (boolean, default: false)
  - When `true`, the auth endpoints are enabled: `POST /auth/authenticate`, `GET /auth/sessions`, `GET /auth/validate/:authId`.
  - When `false` or unset, the endpoints return HTTP 403 (Forbidden) with message: "Feature is not available at this time. (Flag: auth_api)".

## Endpoint Authentication & Authorization Policies

### `POST /auth/authenticate`
- **Access**: Public (no auth required, feature flag gates availability)
- **Requirements**: Must provide valid, signed JWT token in Authorization header
- **Scoping**: Identity is cryptographically verified from JWT; not user-scoped (enables new user onboarding)

### `GET /auth/sessions`
- **Access**: Authenticated (requires valid JWT token)
- **Scoping**: Self-scoped to authenticated user's sessions only. Callers cannot list another user's sessions.
- **Enforcement**: Must verify authenticated user ID and scope results to that user

### `GET /auth/validate/:authId`
- **Access**: Public (no auth required, rate-limited)
- **Purpose**: Pre-flight check to see if an authId can authenticate (returns 200/401/403)
- **Scoping**: Not user-scoped (allows UX validation without requiring auth)

## Implementation Notes

- The flag is implemented via the existing `FeatureFlagGuard` and the `@FeatureFlag('auth_api')` decorator on the `AuthOrchestratorController`.
- The guard reads environment variables using the existing pattern: `FEATURE_<FLAG_NAME>=true|false` (e.g. `FEATURE_AUTH_API=true`).
- `GET /auth/sessions` is NOT marked `@Public()` and therefore requires authentication beyond the feature flag.
- Existing unit tests for `FeatureFlagGuard` cover enabled/disabled behavior. The auth controller tests override the guard for isolation.

## Auth provider flags (Clerk vs Better Auth)

Mux supports two identity providers behind one auth surface. Provider selection is explicit and
fail-closed: if the configured provider is not enabled, auth entrypoints deny by default rather
than silently falling back to the other provider.

- `AUTH_PROVIDER` (enum: `clerk` | `better_auth`, default: `clerk`)
  - Selects the active identity provider for token verification and session issuance.
  - Unknown or unset values resolve to the default (`clerk`); an unrecognized non-empty value is
    treated as a misconfiguration and auth entrypoints fail closed (HTTP 503, code
    `AUTH_PROVIDER_MISCONFIGURED`).
- `FEATURE_AUTH_PROVIDER_CLERK` (boolean, default: true)
  - Enables the Clerk provider. When `false`, Clerk tokens are rejected even if `AUTH_PROVIDER=clerk`.
- `FEATURE_AUTH_PROVIDER_BETTER_AUTH` (boolean, default: false)
  - Enables the Better Auth provider. When `false`, Better Auth tokens are rejected even if
    `AUTH_PROVIDER=better_auth`.

### Precedence and resolution

1. `AUTH_PROVIDER` chooses the active provider.
2. The matching `FEATURE_AUTH_PROVIDER_*` flag must be `true`; otherwise the request is denied
   (HTTP 403, code `AUTH_PROVIDER_DISABLED`).
3. If `AUTH_PROVIDER` is set to an unknown value, resolution fails closed
   (HTTP 503, code `AUTH_PROVIDER_MISCONFIGURED`).
4. If the provider's verification dependency (JWKS/RPC/DB) is unavailable, writes fail closed
   (HTTP 503, code `AUTH_PROVIDER_UNAVAILABLE`); no implicit fallback to the other provider.

All provider-resolution errors include a stable `code` and a `correlationId` echoed from the
request (or generated) so operators can trace failures without exposing tokens or key material.

### Authorization

Provider selection does not bypass authorization. Every auth entrypoint still enforces the
owner/delegate/guardian/API-key/JWT policy; a valid token from the active provider is necessary
but not sufficient. New privileged surfaces are deny-by-default.

### Testnet vs mainnet

- Testnet may enable both providers for migration testing; mainnet should enable exactly one.
- Enabling a provider on mainnet is a money-path-adjacent change and must be gated behind the
  corresponding `FEATURE_AUTH_PROVIDER_*` flag with a documented rollback (flip the flag back to
  `false`; no data migration required).

## Operational guidance

- To enable auth in runtime, set `FEATURE_AUTH_API=true` in the configuration used by the service (env, k8s secret, etc.).
- To switch providers, set `AUTH_PROVIDER` and the matching `FEATURE_AUTH_PROVIDER_*` flag together; never enable a provider flag without confirming the provider's verification dependency is reachable.
- Ensure any API gateway or routing changes are coordinated when toggling these flags in production to avoid unexpected client errors.
- For `GET /auth/sessions`, ensure the backend can extract the authenticated user's ID from the verified JWT and scope queries accordingly.
- Rollback: set the affected `FEATURE_AUTH_PROVIDER_*` flag to `false` (or revert `AUTH_PROVIDER`) and redeploy; auth fails closed until a valid provider is re-enabled.

## References

- [`docs/WALLET-API.md`](./WALLET-API.md)
- `test/wallet-orchestration.e2e-spec.ts`
