# Mainnet Payment Feature Flag & Kill-Switch

This runbook documents the feature flag and kill-switch that gate all
mainnet-affecting payment behavior in `mux-backend`, including the
**payment dry-run mode** described in [`PAYMENT-DRY-RUN.md`](./PAYMENT-DRY-RUN.md).
It is the source of truth for operators and Stellar Wave contributors working
on payment, wallet, and webhook delivery paths.

> Scope: money-path and mainnet-affecting changes only. Testnet behavior is
> unaffected unless explicitly noted.

## Why this exists

Payment dry-run lets clients simulate and validate a payment without
submitting it to Stellar/Horizon. Because dry-run shares the same authz,
idempotency, and validation code paths as live payments, it must be gated so
that a misconfiguration cannot accidentally promote a dry-run into a live
spend, and so operators can disable the money path quickly during an incident.

## Flags

| Flag | Env var | Default | Effect |
| --- | --- | --- | --- |
| Payment dry-run | `PAYMENT_DRY_RUN_ENABLED` | `false` | Enables the dry-run entrypoint. When `false`, dry-run requests are rejected with `PAYMENT_DRY_RUN_DISABLED`. |
| Mainnet payments | `PAYMENT_MAINNET_ENABLED` | `false` | Master switch for live mainnet submission. When `false`, live writes fail closed with `PAYMENT_MAINNET_DISABLED`. |
| Payment kill-switch | `PAYMENT_KILL_SWITCH` | `false` | When `true`, all payment writes (live and dry-run) are rejected immediately with `PAYMENT_KILL_SWITCH_ENGAGED`. |

All flags are **deny-by-default**: unset or unparseable values are treated as
`false`.

- **Deny-by-default.** When unset or `false`, mainnet money-path writes and
  outbound webhook delivery are disabled. Testnet behavior is unaffected.
- **Fail-closed.** If the flag cannot be read (config/RPC/DB outage), treat it as
  `false` and reject the write rather than proceeding.
- **Kill-switch.** Setting the flag to `false` at runtime must stop new mainnet
  writes and webhook deliveries without a redeploy; in-flight retries drain to
  the dead-letter queue instead of being re-sent.

Operational guidance:
- Keep this flag off in production until mainnet payment submission has been reviewed and approved for general availability; flip it on per-environment via env/secret config.

## Testnet Faucet Mainnet Gate (#882)

The testnet faucet is a testnet-only surface. It must never dispense funds on mainnet, and it must fail closed when the configured network is unknown or misconfigured.

- Gate rule: faucet requests are allowed only when the resolved network is `TESTNET`. Any other resolved network — `MAINNET`, unset, or unrecognized — is denied.
- Fail-closed on misconfig: an unknown/absent network is treated as denied, not as testnet. There is no default-allow path.
- Stable error codes: denials return a typed error with a stable code (e.g. `FAUCET_MAINNET_BLOCKED` for mainnet, `FAUCET_NETWORK_UNRESOLVED` for unknown/missing network) plus a correlation id so ops can trace the request without exposing secrets.
- Authz: the gate is enforced server-side after authz (owner/delegate/guardian/API-key/JWT). A caller cannot bypass the gate by presenting a valid credential — authorization and the network gate are independent checks, and both must pass.
- Idempotency: replayed/concurrent faucet requests are deduplicated by request id so a retry cannot double-dispense; the gate decision is evaluated before any dispense side effect.
- Dependency outage: if the network/config source (RPC/DB/Horizon) is unavailable, the gate fails closed and denies the request rather than assuming testnet.
- Observability: emit a metric/log on every gate denial with the stable error code and correlation id; never log raw key material, JWTs, or webhook secrets.
- Rollback: the gate is deny-by-default and requires no flag to be safe; disabling the faucet entirely is the rollback path if a regression is suspected.

Cross-links: see `test/testnet-faucet-mainnet-gate.e2e-spec.ts` for the end-to-end coverage of these invariants.

## Webhook delivery (retries / idempotency)

Outbound webhook delivery is a money-path-adjacent surface and is gated by the
same flag on mainnet.

- **Idempotency.** Every delivery carries a stable idempotency key derived from
  the event id. Replayed or concurrent deliveries with the same key are deduped
  so side effects happen at most once. Consumers should treat the key as the
  dedupe token.
- **Retries.** Failed deliveries are retried with exponential backoff, bounded
  attempts, and jitter. Exhausted deliveries are moved to the dead-letter queue
  as terminal failures; they are never retried unbounded.
- **Fail-closed on outage.** If RPC/DB/Horizon is unavailable, writes fail
  closed and deliveries are not acknowledged as delivered.
- **Adversarial input.** Oversized batches and spoofed webhooks are rejected
  before any side effect; signatures are verified and secrets are never logged.
- **Observability.** Delivery attempts, retries, dedupe hits, and terminal
  failures emit metrics and structured logs with correlation ids. Webhook
  secrets, JWTs, and key material are redacted.

## Invariants

1. Dry-run **never** submits to Stellar/Horizon. It only validates and returns
   a simulated result.
2. Dry-run and live payments share the same authz checks (owner / delegate /
   guardian / API-key / JWT). Dry-run cannot be used to bypass payment policy.
3. Every dry-run request carries a correlation id and is idempotent on
   `(account, idempotencyKey)`; replays return the original result.
4. On RPC/DB/Horizon outage, writes fail closed. Dry-run may return a
   validation error but must not mutate state.
5. No secrets (keys, JWTs, webhook secrets) are logged; only redacted
   identifiers and correlation ids.
6. The mainnet flag is evaluated **server-side only** and is never trusted from
   client input; a client cannot enable mainnet payments by sending a header,
   query param, or body field.

## Invisible Wallet Orchestration

This flag also gates the invisible-wallet orchestration money path. When the flag is off, orchestration entrypoints that would submit a mainnet spend (fee-bump submit, sponsored create, recovery submit) fail closed with HTTP 403 and the stable error code `MAINNET_PAYMENT_SUBMIT_DISABLED`; no wallet key material is decrypted and no Horizon/RPC call is made. Testnet orchestration is unaffected.

- Behavior and request/response contracts for orchestration are documented in `docs/WALLET-API.md`; this flag is the kill-switch for the mainnet-affecting subset of those flows.
- Authz for orchestration entrypoints is deny-by-default: owner/delegate/guardian/API-key/JWT must be present and valid, and revoked delegates are rejected before any spend is attempted.
- Replayed or concurrent orchestration requests are idempotent via the caller-supplied idempotency key; a duplicate key returns the original result rather than re-submitting.
- Errors carry a correlation id (request id) and the stable error codes above so ops can trace a failed orchestration without exposing secrets or raw key material.

## Kill-switch procedure

1. Set `PAYMENT_KILL_SWITCH=true` and roll the deployment.
2. Confirm rejection metrics: `payments_rejected_total{reason="kill_switch"}`
   increases and `payments_submitted_total` drops to zero.
3. Investigate using correlation ids from structured logs.
4. To restore, set `PAYMENT_KILL_SWITCH=false` and roll back.

## Rollback

- Disable dry-run: `PAYMENT_DRY_RUN_ENABLED=false`.
- Disable live mainnet: `PAYMENT_MAINNET_ENABLED=false`.
- Full stop: `PAYMENT_KILL_SWITCH=true`.
- Set `FEATURE_MAINNET_PAYMENT_SUBMIT=false` (or unset) to immediately stop all mainnet orchestration spends; testnet flows continue to work. No migration or redeploy of wallet state is required.

Each flag is independently reversible without a schema migration.

## Observability

- `payments_dry_run_total{result}` — dry-run outcomes.
- `payments_rejected_total{reason}` — authz/flag/idempotency rejections.
- `payments_submitted_total` — live submissions (must be 0 when gated).
- `payments_mainnet_flag_state{enabled}` — current mainnet flag state, emitted
  on startup and on every flag re-read so operators can alert on drift.
- Structured logs include `correlationId` and redacted account refs only.

## References

- [`PAYMENT-DRY-RUN.md`](./PAYMENT-DRY-RUN.md)
- [`SECURITY.md`](../SECURITY.md)
- `test/webhooks.integration.e2e-spec.ts`
- `README.md`

