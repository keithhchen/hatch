# Access ledger operations runbook

The Access ledger (`packages/commerce`) holds My library entitlements (the
free, unmetered grants saved when an account starts a Run) and Creator
earnings/payout accounting. Ledger events and read models are authoritative.
Never edit `commerce_events`, Portal state, or a JSONL ledger by hand.

There is no purchase, checkout or buyer-refund flow, and no operations
snapshot or manual reconcile route: the Runtime's only internal Dashboard calls
are `POST /v1/internal/library/save` and
`GET /v1/internal/access/users/{id}/entitlements`, both authenticated with
`HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN` and never routed by Caddy.

Before any repair, verify `/healthz` and `/readyz` for Dashboard, Registry, and
Runtime. If readiness is failing, restore that dependency first.

## Automated reconciliation

Dashboard runs these loops automatically:

- transactional Commerce outbox dispatch every 2 seconds;
- expired reservation, pending revenue, and payout reconciliation every 30 seconds;
- interrupted publish/rollback reconciliation every 5 seconds.

Restarting Dashboard is safe: commands use durable idempotency keys and the
PostgreSQL event/outbox/inbox transaction.

Payout reconciliation starts after `HATCH_PAYOUT_RECONCILE_AFTER_MS` (default
one minute). It queries the provider by the immutable provider payout attempt
ID, applies only `in_transit`, `paid`, or `failed` through the durable provider
event identity, and records query failures separately without releasing money
whose provider outcome is still unknown.

## Alert playbooks

### `outbox_pending`

SLA: 5 minutes or three failed attempts.

1. Identify the topic and downstream dependency without logging the payload.
2. Restore the dependency and let the dispatcher retry the durable row.
3. Verify the consumer inbox/projection applied it once. Never delete an
   outbox row to silence the alert.

### `payout_attention`

SLA: failed immediately; submitted/in-transit after 3 days.

1. Confirm the payout account is active, the currency matches, and the
   provider payout ID belongs to the current attempt.
2. For a provider-declared failure, use the Creator payout retry action with a
   reason. Retry keeps the payout identity and increments its attempt.
3. Ignore late webhooks for older provider payout IDs; they must not regress
   the current attempt.
4. Verify balance reserve/release and that no duplicate transfer was created.

## Provider webhook replay

Only payout events arrive (`POST /v1/provider-webhooks/payout`). Replay the
provider's original raw body and signature through that signed endpoint.
Duplicate provider event IDs are safe; a duplicate ID with different content is
an idempotency conflict and requires provider investigation.

## Exit criteria

Close the incident only when the durable read models agree, the downstream
projection is correct, and a same-key replay produces no new entitlement,
revenue, grant, or payout event. Attach only IDs, timestamps, statuses, and
error categories to the incident record.
