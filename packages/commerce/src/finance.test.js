import assert from "node:assert/strict";
import test from "node:test";
import {
  CommerceInvariantError,
  CommerceLedger,
  CommerceService,
  projectCreatorDashboard
} from "./index.js";

test("a delivered refund links payment, revenue reversal and payout adjustment without rewriting history", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger);
  const completed = await createRecognizedOrder(commerce, ledger, "refund");
  assert.equal(completed.revenue.creator_share_minor, 3600);
  assert.equal(commerce.getPayoutBalance("creator_refund", "USD").available_minor, 3600);

  const order = await commerce.refundOrder({
    order_id: "order_refund",
    provider_refund_id: "provider_refund_finance",
    provider_refund_status: "succeeded",
    reason: "buyer_request",
    idempotency_key: "refund:finance"
  });
  assert.equal(order.status, "refunded");
  assert.equal(order.payment_status, "refunded");
  assert.equal(order.payment.status, "succeeded");
  assert.equal(order.payment.settlement_status, "refunded");
  assert.equal(order.revenue[0].status, "reversed");
  assert.equal(order.revenue_reversals.length, 1);
  assert.equal(order.payout_adjustments.length, 1);
  assert.equal(order.refunds[0].revenue_reversal_ids.length, 1);
  assert.equal(order.refunds[0].payout_adjustment_ids.length, 1);
  assert.equal(commerce.getPayoutBalance("creator_refund", "USD").available_minor, 0);
  assert.equal(projectCreatorDashboard(ledger.listEvents(), "creator_refund").metrics.creator_share_minor, 0);
});

test("R32 payout failure releases funds and retry never creates a duplicate payout", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger);
  await createRecognizedOrder(commerce, ledger, "payout");
  await commerce.updatePayoutAccount({
    creator_id: "creator_payout",
    currency: "USD",
    provider: "stripe",
    provider_account_id: "acct_creator_payout",
    status: "active",
    idempotency_key: "payout-account:active"
  });

  const reserved = await commerce.createPayout({
    creator_id: "creator_payout",
    currency: "USD",
    batch_id: "batch_2026_08",
    amount_minor: 3000,
    idempotency_key: "payout:create"
  });
  const replay = await commerce.createPayout({
    creator_id: "creator_payout",
    currency: "USD",
    batch_id: "batch_2026_08",
    amount_minor: 3000,
    idempotency_key: "payout:create"
  });
  assert.equal(replay.payout_id, reserved.payout_id);
  assert.equal(commerce.listCreatorPayouts("creator_payout", "USD").length, 1);
  await assert.rejects(
    commerce.createPayout({
      creator_id: "creator_payout",
      currency: "USD",
      batch_id: "batch_2026_08",
      amount_minor: 500,
      idempotency_key: "payout:create"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );

  await commerce.submitPayout({
    payout_id: reserved.payout_id,
    provider_payout_id: "po_attempt_1",
    idempotency_key: "payout:submit:1"
  });
  const reconciliationFailure = await commerce.recordPayoutReconciliationFailure({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_payout_id: "po_attempt_1",
    failure_code: "provider_status_unavailable",
    idempotency_key: "payout:reconcile-failure:1"
  });
  assert.equal(reconciliationFailure.status, "submitted");
  assert.equal(reconciliationFailure.reconciliation.retry_count, 1);
  assert.equal(reconciliationFailure.reconciliation.last_error.code, "provider_status_unavailable");
  const reconciliationReplay = await commerce.recordPayoutReconciliationFailure({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_payout_id: "po_attempt_1",
    failure_code: "provider_status_unavailable",
    idempotency_key: "payout:reconcile-failure:1"
  });
  assert.equal(reconciliationReplay.reconciliation.retry_count, 1);
  const failed = await commerce.recordPayoutProviderEvent({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_event_id: "evt_payout_failed",
    provider_payout_id: "po_attempt_1",
    status: "failed",
    failure_code: "bank_unavailable"
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reconciliation.last_error, null);
  assert.equal(commerce.getPayoutBalance("creator_payout", "USD").available_minor, 3600);
  await commerce.recordPayoutProviderEvent({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_event_id: "evt_payout_failed",
    provider_payout_id: "po_attempt_1",
    status: "failed",
    failure_code: "bank_unavailable"
  });

  const retried = await commerce.retryPayout({
    payout_id: reserved.payout_id,
    idempotency_key: "payout:retry:1"
  });
  assert.equal(retried.status, "reserved");
  assert.equal(retried.attempt, 2);
  const retryReplay = await commerce.retryPayout({
    payout_id: reserved.payout_id,
    idempotency_key: "payout:retry:1"
  });
  assert.equal(retryReplay.attempt, 2);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "payout.retried").length, 1);
  assert.equal(commerce.getPayoutBalance("creator_payout", "USD").available_minor, 600);
  const staleAttempt = await commerce.recordPayoutProviderEvent({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_event_id: "evt_payout_stale_attempt_1",
    provider_payout_id: "po_attempt_1",
    status: "failed"
  });
  assert.equal(staleAttempt.status, "reserved");
  await commerce.submitPayout({
    payout_id: reserved.payout_id,
    provider_payout_id: "po_attempt_2",
    idempotency_key: "payout:submit:2"
  });
  await commerce.recordPayoutProviderEvent({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_event_id: "evt_payout_paid",
    provider_payout_id: "po_attempt_2",
    status: "paid"
  });
  const lateFailure = await commerce.recordPayoutProviderEvent({
    payout_id: reserved.payout_id,
    provider: "stripe",
    provider_event_id: "evt_payout_late_failure",
    provider_payout_id: "po_attempt_2",
    status: "failed"
  });
  assert.equal(lateFailure.status, "paid");
  assert.equal(commerce.getPayoutBalance("creator_payout", "USD").paid_minor, 3000);
  assert.equal(commerce.listCreatorPayouts("creator_payout", "USD").length, 1);
});

async function createRecognizedOrder(commerce, ledger, suffix) {
  const values = identity(suffix);
  const checkout = await commerce.confirmCheckout({
    ...values,
    order_id: `order_${suffix}`,
    entitlement_id: `entitlement_${suffix}`,
    payment_id: `payment_${suffix}`,
    payment_status: "paid",
    gross_minor: 3999,
    currency: "USD",
    idempotency_key: `checkout:${suffix}`
  });
  await commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    reservation_id: `reservation_${suffix}`,
    run_id: `task_${suffix}`,
    idempotency_key: `reserve:${suffix}`
  });
  await ledger.append("task.started", {
    ...values,
    task_id: `task_${suffix}`,
    order_id: checkout.order.order_id,
    entitlement_id: checkout.entitlement.entitlement_id
  }, { idempotencyKey: `task:${suffix}` });
  await ledger.append("artifact.created", {
    ...values,
    artifact_id: `artifact_${suffix}`,
    task_id: `task_${suffix}`,
    order_id: checkout.order.order_id,
    artifact_digest: `sha256:${"b".repeat(64)}`
  }, { idempotencyKey: `artifact:${suffix}` });
  return commerce.completeDelivery({
    reservation_id: `reservation_${suffix}`,
    artifact_id: `artifact_${suffix}`,
    delivery_id: `delivery_${suffix}`,
    idempotency_key: `delivery:${suffix}`
  });
}

function identity(suffix) {
  return {
    buyer_id: `buyer_${suffix}`,
    creator_id: `creator_${suffix}`,
    agent_id: `agent_${suffix}`,
    product_id: `product_${suffix}`,
    corpus_digest: `sha256:${"a".repeat(64)}`
  };
}
