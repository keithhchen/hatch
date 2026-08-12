import assert from "node:assert/strict";
import test from "node:test";
import {
  CommerceInvariantError,
  CommerceLedger,
  CommerceService,
  projectCreatorDashboard
} from "./index.js";

test("R23-R25 payment provider events are idempotent and out-of-order notifications cannot regress checkout", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger);
  await commerce.createPayment({
    payment_id: "payment_provider_v2",
    buyer_id: "buyer_finance",
    creator_id: "creator_finance",
    product_id: "product_finance",
    amount_minor: 3999,
    currency: "usd",
    provider: "stripe",
    idempotency_key: "payment:create:finance"
  });

  await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_requires_action",
    provider_sequence: 2,
    provider_occurred_at: "2026-08-12T08:00:02.000Z",
    status: "requires_action"
  });
  const oldPending = await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_old_pending",
    provider_sequence: 1,
    provider_occurred_at: "2026-08-12T08:00:01.000Z",
    status: "pending"
  });
  assert.equal(oldPending.applied, false);
  assert.equal(oldPending.payment.status, "requires_action");
  await assert.rejects(
    commerce.confirmCheckout({
      ...identity("finance"),
      payment_id: "payment_provider_v2",
      gross_minor: 3999,
      currency: "USD",
      idempotency_key: "checkout:before-capture"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "payment_required"
  );
  assert.equal(ledger.listEvents().some((event) => event.event_type === "entitlement.granted"), false);

  const failed = await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_failed",
    provider_sequence: 3,
    provider_occurred_at: "2026-08-12T08:00:03.000Z",
    status: "failed",
    failure_code: "card_declined"
  });
  assert.equal(failed.payment.status, "failed");
  const recovered = await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_retry_pending",
    provider_sequence: 4,
    provider_occurred_at: "2026-08-12T08:00:04.000Z",
    status: "pending"
  });
  assert.equal(recovered.payment.status, "pending");

  await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_succeeded",
    provider_sequence: 5,
    provider_occurred_at: "2026-08-12T08:00:05.000Z",
    status: "succeeded"
  });
  const lateFailure = await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_late_failure",
    provider_sequence: 6,
    provider_occurred_at: "2026-08-12T08:00:06.000Z",
    status: "failed"
  });
  assert.equal(lateFailure.applied, false);
  assert.equal(lateFailure.payment.status, "succeeded");

  const replay = await commerce.recordPaymentProviderEvent({
    payment_id: "payment_provider_v2",
    provider: "stripe",
    provider_event_id: "evt_succeeded",
    provider_sequence: 5,
    provider_occurred_at: "2026-08-12T08:00:05.000Z",
    status: "succeeded"
  });
  assert.equal(replay.payment.provider_events.filter((event) => event.provider_event_id === "evt_succeeded").length, 1);
  await assert.rejects(
    commerce.recordPaymentProviderEvent({
      payment_id: "payment_provider_v2",
      provider: "stripe",
      provider_event_id: "evt_succeeded",
      provider_sequence: 5,
      provider_occurred_at: "2026-08-12T08:00:05.000Z",
      status: "failed"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );

  const checkout = await commerce.confirmCheckout({
    ...identity("finance"),
    payment_id: "payment_provider_v2",
    gross_minor: 3999,
    currency: "USD",
    idempotency_key: "checkout:provider:finance"
  });
  assert.equal(checkout.order.payment_status, "succeeded");
  assert.equal(checkout.order.payment.status, "succeeded");
  assert.equal(checkout.entitlement.status, "active");
  await assert.rejects(
    commerce.confirmCheckout({
      ...identity("finance"),
      order_id: "order_duplicate_provider_event",
      entitlement_id: "entitlement_duplicate_provider_event",
      payment_id: "payment_provider_v2",
      gross_minor: 3999,
      currency: "USD",
      idempotency_key: "checkout:provider:duplicate"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "payment_already_consumed"
  );
});

test("provider mode can disable the legacy paid confirmation adapter", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger, { allowLegacyPaymentConfirmation: false });
  await assert.rejects(
    commerce.confirmCheckout({
      ...identity("strict_provider"),
      payment_id: "untrusted_browser_payment",
      payment_status: "paid",
      gross_minor: 1200,
      currency: "USD",
      idempotency_key: "checkout:strict-provider"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "payment_required"
  );
  assert.equal(ledger.listEvents().length, 0);
});

test("provider success atomically commits its Payment, order, and entitlement and rolls all three back on conflict", async () => {
  const ledger = new CommerceLedger();
  const commerce = new CommerceService(ledger, { allowLegacyPaymentConfirmation: false });
  const values = identity("atomic_provider");
  await commerce.createPayment({
    payment_id: "payment_atomic_provider",
    buyer_id: values.buyer_id,
    creator_id: values.creator_id,
    product_id: values.product_id,
    amount_minor: 2400,
    currency: "USD",
    provider: "provider_fixture",
    idempotency_key: "payment:create:atomic-provider"
  });
  const providerEvent = {
    payment_id: "payment_atomic_provider",
    provider: "provider_fixture",
    provider_event_id: "event_atomic_provider_succeeded",
    provider_sequence: 2,
    status: "succeeded"
  };
  const checkout = {
    ...values,
    payment_id: "payment_atomic_provider",
    gross_minor: 2400,
    subtotal_minor: 2500,
    discount_minor: 200,
    tax_minor: 100,
    total_minor: 2400,
    currency: "USD",
    idempotency_key: "checkout:atomic-provider"
  };

  const first = await commerce.confirmCheckoutFromProviderEvent(providerEvent, checkout);
  const replay = await commerce.confirmCheckoutFromProviderEvent(providerEvent, checkout);
  assert.equal(first.payment.status, "succeeded");
  assert.equal(first.order.order_id, replay.order.order_id);
  assert.deepEqual(
    [first.order.subtotal_minor, first.order.discount_minor, first.order.tax_minor, first.order.total_minor],
    [2500, 200, 100, 2400]
  );
  assert.equal(first.entitlement.entitlement_id, replay.entitlement.entitlement_id);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "payment.status_changed").length, 1);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "order.placed").length, 1);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "entitlement.granted").length, 1);

  const conflictingValues = identity("atomic_conflict");
  await commerce.confirmCheckout({
    ...conflictingValues,
    order_id: "order_reserved_by_another_checkout",
    gross_minor: 0,
    currency: "USD",
    idempotency_key: "checkout:reserved-order"
  });
  await commerce.createPayment({
    payment_id: "payment_atomic_conflict",
    buyer_id: conflictingValues.buyer_id,
    creator_id: conflictingValues.creator_id,
    product_id: conflictingValues.product_id,
    amount_minor: 1800,
    currency: "USD",
    provider: "provider_fixture",
    idempotency_key: "payment:create:atomic-conflict"
  });
  await assert.rejects(
    commerce.confirmCheckoutFromProviderEvent({
      payment_id: "payment_atomic_conflict",
      provider: "provider_fixture",
      provider_event_id: "event_atomic_conflict_succeeded",
      status: "succeeded"
    }, {
      ...conflictingValues,
      order_id: "order_reserved_by_another_checkout",
      payment_id: "payment_atomic_conflict",
      gross_minor: 1800,
      currency: "USD",
      idempotency_key: "checkout:atomic-conflict"
    }),
    (error) => error instanceof CommerceInvariantError && error.code === "entitlement_already_granted"
  );
  assert.equal(commerce.getPayment("payment_atomic_conflict").status, "pending");
  assert.equal(ledger.listEvents().some((event) => (
    event.provider_event_id === "event_atomic_conflict_succeeded"
  )), false);
});

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
