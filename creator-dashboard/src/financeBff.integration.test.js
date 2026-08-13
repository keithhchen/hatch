import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";
import { signSandboxWebhook } from "../providerAdapters.mjs";

const WEBHOOK_SECRET = "finance-bff-webhook-secret";
const paidAgent = {
  creator_id: "2c4e6f90-0f29-4c8b-a7d1-5e9b4c1f8a33",
  creator_name: "Finance Creator",
  agent_id: "7d6b2e11-3c48-4f95-b2a0-8e1d6c7f9b44",
  product_id: "7d6b2e11-3c48-4f95-b2a0-8e1d6c7f9b44",
  product_name: "Finance Product",
  product_description: "A paid Agent used to verify the finance boundary.",
  product_promise: "One paid delivery.",
  product_boundaries: ["One delivery per purchase."],
  product_offer: {
    model: "per_delivery",
    amount_minor: 4_000,
    currency: "USD",
    included_units: 1
  },
  corpus_digest: "sha256:finance-corpus",
  published_at: "2026-08-01T00:00:00.000Z"
};

test("signed payment webhook completes a requires-action checkout exactly once and terminal success never regresses", async (context) => {
  const fixture = await createFinanceFixture(context);
  const checkout = await createCheckout(fixture.api, "requires-action-create");
  const confirmation = await confirmCheckout(
    fixture.api,
    checkout.checkout_session_id,
    "requires-action-confirm",
    "requires_action"
  );

  assert.equal(confirmation.response.status, 201, JSON.stringify(confirmation.body));
  assert.equal(confirmation.body.status, "requires_action");
  assert.equal(confirmation.body.order_id, null);
  assert.equal(confirmation.body.entitlement_id, null);
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 0);
  assert.equal(fixture.dashboard.commerce.listBuyerEntitlements("buyer-finance").length, 0);
  assert.equal(fixture.grants.length, 0);

  const payment = confirmation.body.payment;
  const succeededEvent = {
    payment_id: payment.payment_id,
    provider_event_id: "evt-payment-succeeded",
    provider_payment_id: payment.provider_payment_id,
    provider_sequence: 2,
    provider_occurred_at: "2026-08-12T02:00:00.000Z",
    status: "succeeded"
  };
  const succeeded = await postWebhook(fixture.api, "payment", succeededEvent, {
    idempotencyKey: "webhook-payment-succeeded"
  });
  assert.equal(succeeded.response.status, 200, JSON.stringify(succeeded.body));
  assert.equal(succeeded.body.payment_status, "succeeded");
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 1);
  assert.equal(fixture.dashboard.commerce.listBuyerEntitlements("buyer-finance").length, 1);
  assert.equal(fixture.grants.length, 1);

  const duplicate = await postWebhook(fixture.api, "payment", succeededEvent, {
    idempotencyKey: "webhook-payment-succeeded-duplicate"
  });
  assert.equal(duplicate.response.status, 200, JSON.stringify(duplicate.body));
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 1);
  assert.equal(fixture.dashboard.commerce.listBuyerEntitlements("buyer-finance").length, 1);
  assert.equal(fixture.grants.length, 1);
  assert.equal(
    fixture.dashboard.ledger.listEvents().filter((event) => event.event_type === "order.placed").length,
    1
  );

  const lateFailure = await postWebhook(fixture.api, "payment", {
    ...succeededEvent,
    provider_event_id: "evt-payment-late-failed",
    provider_sequence: 1,
    provider_occurred_at: "2026-08-12T01:59:00.000Z",
    status: "failed",
    failure_code: "late_decline"
  }, { idempotencyKey: "webhook-payment-late-failed" });
  assert.equal(lateFailure.response.status, 200, JSON.stringify(lateFailure.body));
  assert.equal(lateFailure.body.payment_status, "succeeded");
  assert.equal(fixture.dashboard.commerce.getPayment(payment.payment_id).status, "succeeded");
  assert.equal(fixture.grants.length, 1);

  const expired = await postWebhook(fixture.api, "payment", {
    ...succeededEvent,
    provider_event_id: "evt-expired-signature"
  }, {
    idempotencyKey: "webhook-expired-signature",
    timestamp: Math.floor(Date.now() / 1000) - 601
  });
  assert.equal(expired.response.status, 400);
  assert.equal(expired.body.error.code, "expired_webhook_signature");

  const signed = signSandboxWebhook({
    ...succeededEvent,
    provider_event_id: "evt-tampered-signature"
  }, WEBHOOK_SECRET);
  const tamperedResponse = await fetch(`${serverUrl(fixture.api)}/v1/provider-webhooks/payment`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "webhook-tampered-signature",
      "x-hatch-provider-signature": signed.signature
    },
    body: Buffer.concat([signed.rawBody, Buffer.from(" ")])
  });
  const tampered = await tamperedResponse.json();
  assert.equal(tamperedResponse.status, 400);
  assert.equal(tampered.error.code, "invalid_webhook_signature");
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 1);
});

test("provider failure text is reduced to a stable Buyer-safe category", async (context) => {
  const fixture = await createFinanceFixture(context);
  const checkout = await createCheckout(fixture.api, "private-failure-create");
  const confirmation = await confirmCheckout(
    fixture.api,
    checkout.checkout_session_id,
    "private-failure-confirm",
    "requires_action"
  );
  assert.equal(confirmation.response.status, 201, JSON.stringify(confirmation.body));

  const payment = confirmation.body.payment;
  const failed = await postWebhook(fixture.api, "payment", {
    payment_id: payment.payment_id,
    provider_event_id: "evt-private-payment-failure",
    provider_payment_id: payment.provider_payment_id,
    provider_sequence: 2,
    provider_occurred_at: "2026-08-12T02:10:00.000Z",
    status: "failed",
    failure_code: "card_declined",
    failure_message: "PAN 4242 and /Users/private/workspace must never leave the provider boundary"
  }, { idempotencyKey: "webhook-private-payment-failure" });
  assert.equal(failed.response.status, 200, JSON.stringify(failed.body));

  const stored = fixture.dashboard.commerce.getPayment(payment.payment_id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.failure.message, "The payment was declined. Use another payment method.");
  assert.doesNotMatch(JSON.stringify(stored), /4242|Users|workspace|provider boundary/i);
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 0);
  assert.equal(fixture.grants.length, 0);
});

test("production provider create success stays pending until its signed webhook arrives", async (context) => {
  const providerRequests = [];
  const provider = createServer(async (request, response) => {
    let content = "";
    for await (const chunk of request) content += chunk;
    providerRequests.push({
      pathname: new URL(request.url ?? "/", "http://provider.test").pathname,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body: JSON.parse(content)
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      provider: "provider_fixture",
      provider_payment_id: "provider-payment-authoritative-webhook",
      provider_event_id: "provider-create-reported-success",
      provider_sequence: 1,
      status: "succeeded"
    }));
  });
  await listen(provider);
  context.after(() => provider.close());
  const fixture = await createFinanceFixture(context, {
    paymentMode: "provider",
    providerBaseUrl: serverUrl(provider),
    providerApiToken: "provider-api-token",
    payoutReconcileAfterMs: 0
  });

  const checkout = await createCheckout(fixture.api, "provider-create-checkout");
  const confirmation = await confirmCheckout(
    fixture.api,
    checkout.checkout_session_id,
    "provider-create-confirm"
  );

  assert.equal(confirmation.response.status, 201, JSON.stringify(confirmation.body));
  assert.equal(confirmation.body.status, "pending");
  assert.equal(confirmation.body.order_id, null);
  assert.equal(confirmation.body.entitlement_id, null);
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 0);
  assert.equal(fixture.grants.length, 0);
  assert.equal(providerRequests.length, 1);
  assert.equal(providerRequests[0].pathname, "/v1/payments");
  assert.equal(providerRequests[0].authorization, "Bearer provider-api-token");
  assert.equal(
    providerRequests[0].idempotencyKey,
    `checkout:${checkout.checkout_session_id}:provider-payment`
  );

  const succeeded = await postWebhook(fixture.api, "payment", {
    payment_id: confirmation.body.payment.payment_id,
    provider_event_id: "provider-signed-payment-succeeded",
    provider_payment_id: "provider-payment-authoritative-webhook",
    provider_sequence: 2,
    provider_occurred_at: "2026-08-12T02:30:00.000Z",
    status: "succeeded"
  }, { idempotencyKey: "provider-signed-payment-succeeded" });

  assert.equal(succeeded.response.status, 200, JSON.stringify(succeeded.body));
  assert.equal(succeeded.body.payment_status, "succeeded");
  assert.equal(succeeded.body.checkout_status, "fulfilled");
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 1);
  assert.equal(fixture.dashboard.commerce.listBuyerEntitlements("buyer-finance").length, 1);
  assert.equal(fixture.grants.length, 1);
});

test("production HTTP provider bridge carries refund, payout onboarding, and transfer identities end to end", async (context) => {
  const providerRequests = [];
  let payoutStatusQueries = 0;
  const provider = createServer(async (request, response) => {
    let content = "";
    for await (const chunk of request) content += chunk;
    const pathname = new URL(request.url ?? "/", "http://provider.test").pathname;
    const body = content ? JSON.parse(content) : {};
    providerRequests.push({
      pathname,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body
    });
    response.setHeader("content-type", "application/json");
    if (pathname === "/v1/payments") {
      response.end(JSON.stringify({
        provider: "provider_fixture",
        provider_payment_id: `provider-${body.payment_id}`,
        provider_event_id: `provider-${body.payment_id}:requires-action`,
        provider_sequence: 1,
        status: "requires_action",
        redirect_url: "/provider/authorize"
      }));
      return;
    }
    if (pathname === "/v1/payout-account-sessions") {
      response.end(JSON.stringify({
        provider: "provider_fixture",
        account_id: `account-${body.creator_id}`,
        account_status: "active",
        session_url: "/provider/payout-onboarding",
        expires_at: "2026-08-12T05:00:00.000Z"
      }));
      return;
    }
    if (pathname === "/v1/payouts") {
      response.end(JSON.stringify({
        provider: "provider_fixture",
        provider_payout_id: body.provider_payout_id,
        provider_event_id: `${body.provider_payout_id}:submitted`,
        status: "in_transit"
      }));
      return;
    }
    if (pathname.startsWith("/v1/payouts/")) {
      const providerPayoutId = decodeURIComponent(pathname.slice("/v1/payouts/".length));
      payoutStatusQueries += 1;
      if (payoutStatusQueries === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ code: "temporarily_unavailable" }));
        return;
      }
      response.end(JSON.stringify({
        provider: "provider_fixture",
        provider_payout_id: providerPayoutId,
        provider_event_id: `${providerPayoutId}:status:paid`,
        status: "paid"
      }));
      return;
    }
    if (pathname === "/v1/refunds") {
      response.end(JSON.stringify({
        provider: "provider_fixture",
        provider_refund_id: `provider-${body.refund_id}`,
        provider_event_id: `${body.refund_id}:succeeded`,
        status: "succeeded"
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: "not_found" }));
  });
  await listen(provider);
  context.after(() => provider.close());
  const fixture = await createFinanceFixture(context, {
    paymentMode: "provider",
    providerBaseUrl: serverUrl(provider),
    providerApiToken: "provider-api-token",
    payoutReconcileAfterMs: 0
  });

  const checkout = await createCheckout(fixture.api, "provider-finance-create");
  const confirmation = await confirmCheckout(
    fixture.api,
    checkout.checkout_session_id,
    "provider-finance-confirm"
  );
  assert.equal(confirmation.body.status, "requires_action");
  const payment = confirmation.body.payment;
  const succeeded = await postWebhook(fixture.api, "payment", {
    payment_id: payment.payment_id,
    provider_event_id: "provider-finance-succeeded",
    provider_payment_id: payment.provider_payment_id,
    provider_sequence: 2,
    status: "succeeded"
  }, { idempotencyKey: "provider-finance-succeeded" });
  assert.equal(succeeded.response.status, 200, JSON.stringify(succeeded.body));

  const orderSummary = fixture.dashboard.commerce.listBuyerOrders("buyer-finance")[0];
  const order = fixture.dashboard.commerce.getOrder(orderSummary.order_id);
  const entitlement = order.entitlement;
  assert.ok(entitlement?.entitlement_id);
  const onboardingResponse = await fetch(`${serverUrl(fixture.api)}/v1/creator/payout-account-sessions`, {
    method: "POST",
    headers: mutationHeaders("creator-token", "provider-payout-onboarding"),
    body: JSON.stringify({ currency: "USD" })
  });
  const onboarding = await onboardingResponse.json();
  assert.equal(onboardingResponse.status, 201, JSON.stringify(onboarding));
  assert.equal(onboarding.account.status, "active");

  const completed = await recordDelivery(fixture.dashboard, { order, entitlement }, "provider-finance");
  assert.equal(completed.revenue_status, "recognized");
  const payouts = await fixture.dashboard.reconcilePayouts();
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].status, "in_transit");
  const uncertain = await fixture.dashboard.reconcilePayouts();
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].error, "provider_temporarily_unavailable");
  const pendingPayout = fixture.dashboard.commerce.getPayout(payouts[0].payout_id);
  assert.equal(pendingPayout.status, "in_transit");
  assert.equal(pendingPayout.reconciliation.retry_count, 1);
  assert.equal(pendingPayout.reconciliation.last_error.code, "provider_temporarily_unavailable");
  const settled = await fixture.dashboard.reconcilePayouts();
  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, "paid");

  const refundResponse = await fetch(
    `${serverUrl(fixture.api)}/v1/user/orders/${encodeURIComponent(order.order_id)}/refund-requests`,
    {
      method: "POST",
      headers: mutationHeaders("buyer-token", "provider-refund-order"),
      body: JSON.stringify({ reason: "buyer_requested_after_delivery" })
    }
  );
  const refund = await refundResponse.json();
  assert.equal(refundResponse.status, 201, JSON.stringify(refund));
  assert.equal(refund.order.status, "refunded");
  assert.equal(refund.order.revenue_reversals.length, 1);
  assert.equal(refund.order.payout_adjustments.length, 1);

  for (const request of providerRequests) {
    assert.equal(request.authorization, "Bearer provider-api-token");
    assert.notEqual(request.idempotencyKey, "undefined");
    assert.ok(request.idempotencyKey);
  }
  assert.deepEqual(providerRequests.map((request) => request.pathname), [
    "/v1/payments",
    "/v1/payout-account-sessions",
    "/v1/payouts",
    `/v1/payouts/${encodeURIComponent(payouts[0].provider_payout_id)}`,
    `/v1/payouts/${encodeURIComponent(payouts[0].provider_payout_id)}`,
    "/v1/refunds"
  ]);
  const payoutRequest = providerRequests.find((request) => request.pathname === "/v1/payouts");
  assert.equal(payoutRequest.body.provider_payout_id, payouts[0].provider_payout_id);
  const refundRequest = providerRequests.find((request) => request.pathname === "/v1/refunds");
  assert.equal(refundRequest.body.payment_id, order.payment_id);
  assert.equal(refundRequest.body.provider_payment_id, payment.provider_payment_id);
});

test("paid fulfillment that exceeds its recovery SLA is refunded exactly once instead of remaining captured", async (context) => {
  const fixture = await createFinanceFixture(context, {
    grantFailures: Number.POSITIVE_INFINITY,
    fulfillmentSlaMs: 0,
    fulfillmentMaxAttempts: 1
  });
  const checkout = await createCheckout(fixture.api, "fulfillment-compensation-create");
  const confirmation = await confirmCheckout(
    fixture.api,
    checkout.checkout_session_id,
    "fulfillment-compensation-confirm",
    "succeeded"
  );
  assert.equal(confirmation.response.status, 503, JSON.stringify(confirmation.body));
  assert.equal(
    fixture.dashboard.portalState.getCheckoutSession(checkout.checkout_session_id).status,
    "fulfillment_pending"
  );
  assert.equal(fixture.dashboard.commerce.listBuyerOrders("buyer-finance").length, 1);

  const reconciled = await fixture.dashboard.reconcilePendingCheckouts();
  assert.equal(reconciled[0].status, "refunded");
  const compensated = fixture.dashboard.portalState.getCheckoutSession(checkout.checkout_session_id);
  assert.equal(compensated.status, "refunded");
  assert.equal(compensated.payment_status, "refunded");
  const order = fixture.dashboard.commerce.getOrder(compensated.order_id);
  assert.equal(order.status, "refunded");
  assert.equal(order.payment_status, "refunded");
  assert.equal(order.refunds.length, 1);
  assert.equal(order.refunds[0].reason, "fulfillment_sla_exceeded");
  assert.equal(fixture.revocations.length, 1);

  const replay = await fixture.dashboard.reconcilePendingCheckouts();
  assert.equal(replay.length, 0);
  assert.equal(fixture.dashboard.commerce.getOrder(compensated.order_id).refunds.length, 1);
  assert.equal(fixture.revocations.length, 1);
});

test("a paid delivery refund creates one revenue reversal and linked payout adjustment", async (context) => {
  const fixture = await createFinanceFixture(context);
  const purchase = await completePaidCheckout(fixture.api, "delivered-refund");
  const completed = await recordDelivery(fixture.dashboard, purchase.body, "delivered-refund");
  assert.equal(completed.revenue_status, "recognized");
  assert.equal(completed.revenue.creator_share_minor, 3_600);

  const refundResponse = await fetch(
    `${serverUrl(fixture.api)}/v1/user/orders/${encodeURIComponent(purchase.body.order_id)}/refund-requests`,
    {
      method: "POST",
      headers: mutationHeaders("buyer-token", "buyer-delivered-refund"),
      body: JSON.stringify({ reason: "buyer_requested_after_delivery" })
    }
  );
  const refund = await refundResponse.json();
  assert.equal(refundResponse.status, 201, JSON.stringify(refund));
  assert.equal(refund.order.status, "refunded");
  assert.equal(refund.order.payment_status, "refunded");
  assert.equal(refund.order.revenue_reversals.length, 1);
  assert.equal(refund.order.payout_adjustments.length, 1);
  assert.equal(refund.order.payout_adjustments[0].amount_minor, -3_600);
  assert.equal(
    refund.order.payout_adjustments[0].source_id,
    refund.order.revenue_reversals[0].reversal_id
  );
  assert.deepEqual(fixture.revocations, [purchase.body.entitlement_id]);
  assert.equal(fixture.dashboard.commerce.getPayoutBalance(paidAgent.creator_id, "USD").available_minor, 0);

  const replayResponse = await fetch(
    `${serverUrl(fixture.api)}/v1/user/orders/${encodeURIComponent(purchase.body.order_id)}/refund-requests`,
    {
      method: "POST",
      headers: mutationHeaders("buyer-token", "buyer-delivered-refund"),
      body: JSON.stringify({ reason: "buyer_requested_after_delivery" })
    }
  );
  assert.equal(replayResponse.status, 201);
  assert.equal(
    fixture.dashboard.ledger.listEvents().filter((event) => event.event_type === "revenue.reversed").length,
    1
  );
  assert.equal(
    fixture.dashboard.ledger.listEvents().filter((event) => event.event_type === "payout.adjustment").length,
    1
  );
});

test("recognized revenue never submits a payout while the schedule policy is disabled", async (context) => {
  const fixture = await createFinanceFixture(context, { payoutSchedule: "disabled" });
  const onboardingResponse = await fetch(`${serverUrl(fixture.api)}/v1/creator/payout-account-sessions`, {
    method: "POST",
    headers: mutationHeaders("creator-token", "creator-payout-disabled-onboarding"),
    body: JSON.stringify({ currency: "USD" })
  });
  assert.equal(onboardingResponse.status, 201);
  const purchase = await completePaidCheckout(fixture.api, "creator-payout-disabled-revenue");
  const delivery = await recordDelivery(fixture.dashboard, purchase.body, "creator-payout-disabled-revenue");
  assert.equal(delivery.revenue_status, "recognized");

  assert.deepEqual(await fixture.dashboard.reconcilePayouts(), []);
  assert.equal(fixture.dashboard.commerce.listCreatorPayouts(paidAgent.creator_id, "USD").length, 0);
  const viewResponse = await fetch(`${serverUrl(fixture.api)}/v1/creator/payouts?currency=USD`, {
    headers: { authorization: "Bearer creator-token" }
  });
  const view = await viewResponse.json();
  assert.equal(viewResponse.status, 200, JSON.stringify(view));
  assert.equal(view.payout_schedule, "disabled");
  assert.equal(view.next_payout_at, null);
  assert.equal(view.available_minor, 3_600);
});

test("Creator payout onboarding, provider failure, retry replay, and stale-attempt webhook are idempotent", async (context) => {
  const fixture = await createFinanceFixture(context);
  const onboardingResponse = await fetch(`${serverUrl(fixture.api)}/v1/creator/payout-account-sessions`, {
    method: "POST",
    headers: mutationHeaders("creator-token", "creator-payout-onboarding"),
    body: JSON.stringify({ currency: "USD" })
  });
  const onboarding = await onboardingResponse.json();
  assert.equal(onboardingResponse.status, 201, JSON.stringify(onboarding));
  assert.equal(onboarding.account.status, "active");
  assert.match(onboarding.session_url, /setup=complete/);

  const purchase = await completePaidCheckout(fixture.api, "creator-payout-revenue");
  const delivery = await recordDelivery(fixture.dashboard, purchase.body, "creator-payout-revenue");
  assert.equal(delivery.revenue_status, "recognized");

  const reconciled = await fixture.dashboard.reconcilePayouts();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, "in_transit");
  assert.equal(reconciled[0].attempt, 1);
  const payoutId = reconciled[0].payout_id;
  const firstProviderPayoutId = reconciled[0].provider_payout_id;

  const failed = await postWebhook(fixture.api, "payout", {
    payout_id: payoutId,
    provider_event_id: "evt-payout-attempt-1-failed",
    provider_payout_id: firstProviderPayoutId,
    provider_occurred_at: "2026-08-12T03:00:00.000Z",
    status: "failed",
    failure_code: "bank_temporarily_unavailable"
  }, { idempotencyKey: "webhook-payout-attempt-1-failed" });
  assert.equal(failed.response.status, 200, JSON.stringify(failed.body));
  assert.equal(failed.body.payout.status, "failed");
  assert.equal(fixture.dashboard.commerce.getPayoutBalance(paidAgent.creator_id, "USD").available_minor, 3_600);

  const retryRequest = () => fetch(
    `${serverUrl(fixture.api)}/v1/creator/payouts/${encodeURIComponent(payoutId)}/retry`,
    {
      method: "POST",
      headers: mutationHeaders("creator-token", "creator-payout-retry-attempt-2"),
      body: JSON.stringify({ reason: "retry_after_temporary_bank_failure" })
    }
  );
  const retryResponse = await retryRequest();
  const retry = await retryResponse.json();
  assert.equal(retryResponse.status, 202, JSON.stringify(retry));
  assert.equal(retry.payout.status, "in_transit");
  assert.equal(retry.payout.attempt, 2);
  assert.notEqual(retry.payout.provider_payout_id, firstProviderPayoutId);

  const replayResponse = await retryRequest();
  const replay = await replayResponse.json();
  assert.equal(replayResponse.status, 202, JSON.stringify(replay));
  assert.equal(replay.payout.attempt, 2);
  assert.equal(replay.payout.provider_payout_id, retry.payout.provider_payout_id);
  assert.equal(
    fixture.dashboard.ledger.listEvents().filter((event) => event.event_type === "payout.retried").length,
    1
  );

  const stale = await postWebhook(fixture.api, "payout", {
    payout_id: payoutId,
    provider_event_id: "evt-payout-stale-attempt-1-failed",
    provider_payout_id: firstProviderPayoutId,
    provider_occurred_at: "2026-08-12T03:01:00.000Z",
    status: "failed",
    failure_code: "late_attempt_1_notification"
  }, { idempotencyKey: "webhook-payout-stale-attempt-1-failed" });
  assert.equal(stale.response.status, 200, JSON.stringify(stale.body));
  assert.equal(stale.body.payout.status, "in_transit");
  assert.equal(stale.body.payout.attempt, 2);
  assert.equal(stale.body.payout.provider_payout_id, retry.payout.provider_payout_id);
  assert.equal(fixture.dashboard.commerce.listCreatorPayouts(paidAgent.creator_id, "USD").length, 1);
});

async function createFinanceFixture(context, options = {}) {
  const grants = [];
  const revocations = [];
  const registry = registryFixture({ grants, revocations, grantFailures: options.grantFailures });
  await listen(registry);
  context.after(() => registry.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-finance-bff-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryAccessServiceToken: "registry-access-service",
    paymentMode: options.paymentMode ?? "sandbox",
    providerBaseUrl: options.providerBaseUrl,
    providerApiToken: options.providerApiToken,
    fulfillmentSlaMs: options.fulfillmentSlaMs,
    fulfillmentMaxAttempts: options.fulfillmentMaxAttempts,
    payoutReconcileAfterMs: options.payoutReconcileAfterMs,
    payoutSchedule: options.payoutSchedule ?? "immediate",
    payoutMinimumMinor: options.payoutMinimumMinor ?? 1,
    providerWebhookSecret: WEBHOOK_SECRET,
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  return { api, dashboard, grants, revocations };
}

async function createCheckout(api, idempotencyKey) {
  const detailResponse = await fetch(
    `${serverUrl(api)}/v1/public/products/${paidAgent.product_id}`
  );
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200, JSON.stringify(detail));
  const response = await fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers: mutationHeaders("buyer-token", idempotencyKey),
    body: JSON.stringify({
      product_id: paidAgent.product_id,
      offer_id: detail.product.offer.offer_id
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.checkout_session;
}

async function confirmCheckout(api, checkoutSessionId, idempotencyKey, scenario) {
  const response = await fetch(
    `${serverUrl(api)}/v1/checkout-sessions/${encodeURIComponent(checkoutSessionId)}/confirm`,
    {
      method: "POST",
      headers: mutationHeaders("buyer-token", idempotencyKey),
      body: JSON.stringify({ sandbox_scenario: scenario })
    }
  );
  return { response, body: await response.json() };
}

async function completePaidCheckout(api, prefix) {
  const checkout = await createCheckout(api, `${prefix}-create`);
  const confirmation = await confirmCheckout(api, checkout.checkout_session_id, `${prefix}-confirm`, "succeeded");
  assert.equal(confirmation.response.status, 201, JSON.stringify(confirmation.body));
  assert.equal(confirmation.body.payment.status, "succeeded");
  return confirmation;
}

async function postWebhook(api, kind, payload, options = {}) {
  const signed = signSandboxWebhook(payload, WEBHOOK_SECRET, options.timestamp);
  const response = await fetch(`${serverUrl(api)}/v1/provider-webhooks/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": options.idempotencyKey,
      "x-hatch-provider-signature": signed.signature
    },
    body: signed.rawBody
  });
  return { response, body: await response.json() };
}

async function recordDelivery(app, checkout, prefix) {
  const taskId = `task-${prefix}`;
  const artifactId = `artifact-${prefix}`;
  const deliveryId = `delivery-${prefix}`;
  const reservation = await app.commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: taskId,
    task_id: taskId,
    idempotency_key: `reserve:${prefix}`
  });
  const identity = {
    order_id: checkout.order.order_id,
    buyer_id: checkout.order.buyer_id,
    creator_id: checkout.order.creator_id,
    agent_id: checkout.order.agent_id,
    product_id: checkout.order.product_id,
    corpus_digest: checkout.order.corpus_digest
  };
  await app.ledger.append("task.started", {
    ...identity,
    entitlement_id: checkout.entitlement.entitlement_id,
    task_id: taskId
  }, { idempotencyKey: `task:${prefix}` });
  await app.ledger.append("artifact.created", {
    ...identity,
    task_id: taskId,
    artifact_id: artifactId,
    artifact_digest: `sha256:${"d".repeat(64)}`
  }, { idempotencyKey: `artifact:${prefix}` });
  return app.commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    task_id: taskId,
    artifact_id: artifactId,
    artifact_type: "pdf",
    delivery_id: deliveryId,
    idempotency_key: `delivery:${prefix}`
  });
}

function registryFixture({ grants, revocations, grantFailures = 0 }) {
  let grantAttempts = 0;
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");

    if (url.pathname === "/health" || url.pathname === "/readyz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/v1/auth/me") {
      const token = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (token === "buyer-token") {
        response.end(JSON.stringify({
          id: "buyer-finance",
          role: "user",
          email: "buyer@example.test",
          display_name: "Finance Buyer"
        }));
        return;
      }
      if (token === "creator-token") {
        response.end(JSON.stringify({
          id: paidAgent.creator_id,
          role: "creator",
          email: "creator@example.test",
          display_name: paidAgent.creator_name
        }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ detail: "invalid token" }));
      return;
    }
    if (url.pathname === "/v1/public/products" || url.pathname === "/v1/creator/products") {
      response.end(JSON.stringify([paidAgent]));
      return;
    }
    if (url.pathname === "/v1/user/product-access" && request.method === "GET") {
      response.end(JSON.stringify([]));
      return;
    }
    if (url.pathname === `/v1/user/products/${paidAgent.product_id}/access`
      && request.method === "POST") {
      const body = JSON.parse(content);
      grantAttempts += 1;
      if (grantAttempts <= grantFailures) {
        response.statusCode = 503;
        response.end(JSON.stringify({ detail: "temporary Registry outage" }));
        return;
      }
      grants.push(body);
      response.end(JSON.stringify({
        ...body,
        creator_id: paidAgent.creator_id,
        agent_id: paidAgent.agent_id,
        product_id: paidAgent.product_id,
        status: "active"
      }));
      return;
    }
    const revokeMatch = url.pathname.match(/^\/v1\/user\/product-access\/([^/]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      revocations.push(decodeURIComponent(revokeMatch[1]));
      response.end(JSON.stringify({
        entitlement_id: decodeURIComponent(revokeMatch[1]),
        status: "revoked"
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
}

function mutationHeaders(token, idempotencyKey) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
