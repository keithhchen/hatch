# Commerce V2 operations runbook

This runbook covers the recoverable states exposed by Commerce V2. Commerce
events and read models are authoritative; Registry access is a projection.
Never edit `commerce_events`, Portal state, Registry access rows, or a JSONL
ledger by hand.

## Access and first response

The operational snapshot is internal-only and requires the Runtime Commerce
service token. Run it inside the Dashboard container or private application
network; it is intentionally not routed by Caddy.

```bash
curl --fail --silent --show-error \
  -H "Authorization: Bearer $HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN" \
  http://127.0.0.1:8500/v1/internal/commerce/operations
```

Record the response `generated_at`, alert `category`, `resource_id`, `age_ms`,
`retry_count`, and `last_error_category` in the incident. Do not copy Buyer
prompts, files, Workspace paths, provider secrets, or raw exception text into
the incident record.

The same response includes a `funnel` object containing allowlisted event
counts only. It never includes event attributes or Buyer/Creator content, so it
can feed conversion and failure-rate dashboards without widening the incident
data boundary.

Before repair, verify `/healthz` and `/readyz` for Dashboard, Registry, and
Runtime. If readiness is failing, restore that dependency first. Re-run the
snapshot after every repair and require the alert count to converge to zero.

## Automated reconciliation

Dashboard runs these loops automatically:

- checkout/access reconciliation every 5 seconds;
- transactional Commerce outbox dispatch every 2 seconds;
- expired reservation, pending revenue, and payout reconciliation every 30 seconds;
- interrupted publish/rollback reconciliation every 5 seconds.

Restarting Dashboard is safe: commands use durable idempotency keys and the
PostgreSQL event/outbox/inbox transaction. A restart is not a substitute for
checking the resulting order, entitlement, payment, refund, or payout read
model.

Payout reconciliation starts after `HATCH_PAYOUT_RECONCILE_AFTER_MS` (default
one minute). It queries the provider by the immutable provider payout attempt
ID, applies only `in_transit`, `paid`, or `failed` through the durable provider
event identity, and records query failures separately without releasing money
whose provider outcome is still unknown.

## Alert playbooks

### `fulfillment_pending` or `captured_without_order`

SLA: 5 minutes.

1. Confirm the Payment aggregate is `succeeded` and the checkout quote still
   references the same Buyer, product, offer revision, release, amount, and
   currency.
2. Confirm there is no existing order before retrying. Never create a second
   payment intent.
3. Let the checkout reconciler replay the original checkout/session command.
   If Registry is unavailable, restore Registry and let the Commerce outbox
   replay the access projection.
4. Verify exactly one order, one entitlement, and one active Registry grant.
5. After both the configured SLA and retry limit are exhausted, Dashboard
   automatically issues one provider-confirmed compensating refund with reason
   `fulfillment_sla_exceeded`, revokes the entitlement through the durable
   outbox, and changes the checkout to `refunded`. Do not mark the payment
   refunded locally or attempt a second refund.

### `stale_reservation`

Reservation leases expire after 15 minutes unless explicitly configured.

1. Confirm no completed delivery already consumes the reservation.
2. Trigger the authenticated reconciler if the scheduled loop is not running:

   ```bash
   curl --fail --silent --show-error -X POST \
     -H "Authorization: Bearer $HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: ops-reservations-$(date -u +%Y%m%dT%H%M)" \
     --data '{}' \
     http://127.0.0.1:8500/v1/internal/commerce/reconcile-reservations
   ```

3. Verify the reservation is released once and the remaining unit count is
   restored. A completed delivery must never be reversed by this repair.

### `revenue_pending`

SLA: 5 minutes. Delivery success is durable and must not be changed to failed.

1. Verify the delivery and artifact receipt exist and the order is paid.
2. Trigger revenue reconciliation:

   ```bash
   curl --fail --silent --show-error -X POST \
     -H "Authorization: Bearer $HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: ops-revenue-$(date -u +%Y%m%dT%H%M)" \
     --data '{}' \
     http://127.0.0.1:8500/v1/internal/commerce/reconcile-revenue
   ```

3. Verify one `revenue.recognized` event and the Creator balance. For a free
   order, revenue must remain `not_applicable`; do not synthesize zero revenue.

### `refund_projection_lag` or access projection lag

1. Treat the Commerce refund and entitlement status as authoritative.
2. Verify the provider refund is confirmed for a paid order. A local provider
   error must remain pending/failed, not `refunded`.
3. Restore Registry and allow the Commerce outbox to replay revoke. Delayed or
   out-of-order grant messages must not reactivate a revoked entitlement.
4. Verify the existing and a new Runtime connection both deny the revoked
   entitlement. For a post-delivery refund, also verify one revenue reversal
   and its linked payout adjustment.

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

Only replay the provider's original raw body and signature through the signed
webhook endpoint. Never convert a browser redirect or a payment-intent creation
response into `succeeded`. Duplicate provider event IDs are safe; a duplicate
ID with different content is an idempotency conflict and requires provider
investigation.

## Legacy UAT isolation

- zero-value orders are projected as `payment_status=not_required` with no
  payment ID, including old `pay_zero_*` fixtures;
- Registry access without both an order ID and a valid immutable purchased
  Corpus digest is not projected to Runtime;
- legacy access must be reissued only through a real checkout/migration that
  chooses explicit units, validity, version policy, and release digest;
- old audit events remain readable, but they are never upgraded into paid or
  lifetime entitlement by inference.

## Exit criteria

Close the incident only when the operational snapshot has no matching alert,
the durable read models agree, the downstream projection is correct, and a
same-key replay produces no new order, entitlement, delivery, revenue, refund,
grant, or payout event. Attach only IDs, timestamps, statuses, and error
categories to the incident record.
