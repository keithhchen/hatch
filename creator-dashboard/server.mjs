import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommerceLedger,
  CommerceService,
  PostgresCommerceLedger
} from "../packages/commerce/src/index.js";
import { PortalStateStore, stateError } from "./portalState.mjs";
import { createProviderAdapter } from "./providerAdapters.mjs";
import {
  createDefaultMetadata,
  createProductMetadata,
  createProductNoScriptFallback,
  createUnavailableProductMetadata,
  injectProductMetadata,
  injectProductNoScriptFallback
} from "./publicMetadata.mjs";
import { PortalTelemetryStore } from "./telemetry.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
const CORPUS_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CREATOR_FACTORY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;

export async function createDashboardApp(options = {}) {
  const commerceDatabaseUrl = options.commerceDatabaseUrl
    ?? process.env.HATCH_COMMERCE_DATABASE_URL
    ?? "";
  const ledgerPath = options.ledgerPath
    ?? process.env.HATCH_COMMERCE_LEDGER_PATH
    ?? path.join(currentDirectory, ".local-uat", "ledger.jsonl");
  const registryUrl = options.registryUrl
    ?? process.env.HATCH_REGISTRY_URL
    ?? "http://127.0.0.1:8100";
  const publicOrigin = options.publicOrigin
    ?? process.env.HATCH_PUBLIC_ORIGIN
    ?? (process.env.NODE_ENV === "production" ? "https://hatch.tokenquadrant.cn" : "http://127.0.0.1:8500");
  let PostgresPool = options.PostgresPool;
  let ledger = options.ledger;
  if (!ledger && commerceDatabaseUrl) {
    if (!PostgresPool) ({ Pool: PostgresPool } = await import("pg"));
    ledger = await PostgresCommerceLedger.open({
      Pool: PostgresPool,
      connectionString: commerceDatabaseUrl,
      poolOptions: { max: Number(options.commercePoolSize ?? process.env.HATCH_COMMERCE_POOL_SIZE ?? 10) }
    });
  }
  if (!ledger) {
    if (process.env.NODE_ENV === "production" && options.allowFileLedger !== true) {
      throw new Error("HATCH_COMMERCE_DATABASE_URL is required in production; the JSONL ledger is development-only.");
    }
    ledger = await CommerceLedger.open({ filePath: ledgerPath });
  }
  if (commerceDatabaseUrl && !PostgresPool) ({ Pool: PostgresPool } = await import("pg"));
  const portalStatePath = options.portalStatePath
    ?? process.env.HATCH_PORTAL_STATE_PATH
    ?? `${ledgerPath}.portal.json`;
  const portalState = options.portalState ?? await PortalStateStore.open(commerceDatabaseUrl
    ? {
        Pool: PostgresPool,
        connectionString: commerceDatabaseUrl,
        poolOptions: { max: Math.max(2, Math.min(5, Number(options.commercePoolSize ?? process.env.HATCH_COMMERCE_POOL_SIZE ?? 10))) }
      }
    : { filePath: portalStatePath });
  const telemetry = options.telemetry ?? await PortalTelemetryStore.open(commerceDatabaseUrl
    ? {
        Pool: PostgresPool,
        connectionString: commerceDatabaseUrl,
        poolOptions: { max: 2 }
      }
    : {
        filePath: options.telemetryPath
          ?? process.env.HATCH_PORTAL_TELEMETRY_PATH
          ?? `${portalStatePath}.telemetry.jsonl`
      });
  const recordTelemetry = (eventName, attributes, idempotencyKey) => telemetry
    .record(eventName, attributes, { idempotencyKey })
    .catch(() => undefined);
  const analyticsRateLimit = Math.max(1, Number(options.analyticsRateLimit
    ?? process.env.HATCH_ANALYTICS_RATE_LIMIT_PER_MINUTE
    ?? 120));
  const analyticsRateWindowMs = Math.max(1_000, Number(options.analyticsRateWindowMs ?? 60_000));
  const analyticsRateWindows = new Map();
  const fetchImpl = options.fetchImpl ?? fetch;
  const factoryRequestMaxBytes = options.factoryRequestMaxBytes ?? CREATOR_FACTORY_JSON_BODY_MAX_BYTES;
  const configuredPaymentMode = options.paymentMode ?? process.env.HATCH_COMMERCE_PAYMENT_MODE ?? "disabled";
  const paymentProvider = createProviderAdapter({
    adapter: options.paymentProvider,
    mode: configuredPaymentMode,
    production: process.env.NODE_ENV === "production",
    paidLaunchApproved: options.paidLaunchApproved
      ?? process.env.HATCH_COMMERCE_PAID_LAUNCH_APPROVED === "true",
    allowSandboxInProduction: options.allowSandboxInProduction,
    baseUrl: options.providerBaseUrl ?? process.env.HATCH_PAYMENT_PROVIDER_BASE_URL,
    apiToken: options.providerApiToken ?? process.env.HATCH_PAYMENT_PROVIDER_API_TOKEN,
    webhookSecret: options.providerWebhookSecret ?? process.env.HATCH_PAYMENT_PROVIDER_WEBHOOK_SECRET,
    sandboxScenario: options.paymentSandboxScenario,
    fetchImpl: options.fetchImpl
  });
  const paymentMode = paymentProvider.mode;
  const payoutSchedule = String(options.payoutSchedule
    ?? process.env.HATCH_PAYOUT_SCHEDULE
    ?? "disabled").trim().toLowerCase();
  if (!new Set(["disabled", "immediate"]).has(payoutSchedule)) {
    throw new Error("HATCH_PAYOUT_SCHEDULE must be disabled or immediate");
  }
  const payoutMinimumMinor = Number(options.payoutMinimumMinor
    ?? process.env.HATCH_PAYOUT_MINIMUM_MINOR
    ?? 1);
  if (!Number.isSafeInteger(payoutMinimumMinor) || payoutMinimumMinor <= 0) {
    throw new Error("HATCH_PAYOUT_MINIMUM_MINOR must be a positive integer");
  }
  const commerce = new CommerceService(ledger, {
    // The BFF always materializes an authoritative Payment aggregate before a
    // paid order. Keep the pre-V2 compatibility adapter disabled here even in
    // sandbox mode so no browser-shaped `payment_status=paid` can grant access.
    allowLegacyPaymentConfirmation: false
  });
  const exposeBearerTokens = options.exposeBearerTokens === true;
  const registryAccessServiceToken = options.registryAccessServiceToken
    ?? process.env.HATCH_REGISTRY_ACCESS_SERVICE_TOKEN
    ?? process.env.HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN
    ?? "";
  const registryDeploymentServiceToken = options.registryDeploymentServiceToken
    ?? process.env.HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN
    ?? "";
  const commerceRuntimeServiceToken = options.commerceRuntimeServiceToken
    ?? process.env.HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN
    ?? "";
  const fulfillmentSlaMs = Math.max(0, Number(options.fulfillmentSlaMs
    ?? process.env.HATCH_FULFILLMENT_SLA_MS
    ?? 5 * 60_000));
  const fulfillmentMaxAttempts = Math.max(1, Number(options.fulfillmentMaxAttempts
    ?? process.env.HATCH_FULFILLMENT_MAX_ATTEMPTS
    ?? 12));
  const payoutReconcileAfterMs = Math.max(0, Number(options.payoutReconcileAfterMs
    ?? process.env.HATCH_PAYOUT_RECONCILE_AFTER_MS
    ?? 60_000));

  const compensateFailedCheckout = async (session) => {
    const amountMinor = Number(session.totals?.total_minor ?? session.offer_snapshot?.amount_minor ?? 0);
    const startedAt = Date.parse(session.fulfillment_started_at ?? session.created_at ?? "");
    const ageMs = Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
    if (session.status !== "fulfillment_pending"
      || amountMinor <= 0
      || Number(session.reconcile_attempts ?? 0) < fulfillmentMaxAttempts
      || ageMs < fulfillmentSlaMs) return null;
    const order = commerce.getOrder(session.order_id);
    if (!order || order.status === "refunded" || order.deliveries.length > 0) return null;
    const idempotencyKey = `fulfillment-compensation:${session.checkout_session_id}`;
    const providerRefund = await confirmedProviderRefund(paymentProvider, order, {
      actor_id: "fulfillment-reconciler",
      reason: "fulfillment_sla_exceeded",
      idempotency_key: idempotencyKey
    });
    const refunded = await commerce.refundOrder({
      order_id: order.order_id,
      buyer_id: order.buyer_id,
      actor_id: "fulfillment-reconciler",
      service_name: "dashboard-bff",
      reason: "fulfillment_sla_exceeded",
      ...providerRefund
    }, { idempotencyKey });
    const entitlementId = refunded.entitlement?.entitlement_id ?? session.entitlement_id;
    if (registryAccessServiceToken && entitlementId) {
      try {
        await registryRequest(registryUrl, `/v1/user/product-access/${encodeURIComponent(entitlementId)}`, {
          method: "DELETE",
          body: JSON.stringify({ user_id: order.buyer_id }),
          fetchImpl,
          headers: { authorization: `Bearer ${registryAccessServiceToken}` }
        });
      } catch {
        // The refund is already authoritative. Its transactional outbox keeps
        // the Registry revocation retryable without undoing compensation.
      }
    }
    const compensated = await portalState.markCheckoutCompensated(session.checkout_session_id, {
      order_id: refunded.order_id,
      entitlement_id: entitlementId,
      refund_id: refunded.refunds.at(-1)?.refund_id ?? null
    });
    dispatchCommerceOutbox().catch(() => undefined);
    return {
      checkout_session_id: session.checkout_session_id,
      order_id: refunded.order_id,
      refund_id: compensated.refund_id,
      status: "refunded",
      reason: "fulfillment_sla_exceeded"
    };
  };

  const reconcilePendingCheckouts = async () => {
    if (!registryAccessServiceToken) return [];
    await portalState.refresh?.();
    const results = [];
    for (const original of portalState.listCheckoutSessions()) {
      let session = original;
      if (!new Set(["open", "payment_pending", "requires_action", "fulfillment_pending"]).has(session.status)) {
        continue;
      }
      try {
        if (session.status === "open") {
          const orderEvent = ledger.findByIdempotencyKey(`checkout:${session.checkout_session_id}:confirm:order`);
          const entitlementEvent = ledger.findByIdempotencyKey(`checkout:${session.checkout_session_id}:confirm:entitlement`);
          if (!orderEvent || !entitlementEvent) continue;
          session = await portalState.markCheckoutFulfillmentPending(session.checkout_session_id, {
            order_id: orderEvent.order_id,
            entitlement_id: entitlementEvent.entitlement_id,
            payment_status: orderEvent.payment_status
          });
        }
        if (session.status !== "fulfillment_pending"
          && Number(session.totals?.total_minor ?? 0) > 0) {
          const payment = commerce.getPayment(session.payment_id ?? stablePaymentId(session.checkout_session_id));
          if (payment?.status === "succeeded") {
            const outcome = await finalizeCheckoutOrder({
              session,
              authentication: {
                profile: session.buyer ?? {
                  id: session.buyer_id,
                  display_name: session.buyer_display_name ?? "Hatch buyer"
                }
              },
              registryUrl,
              fetchImpl,
              commerce,
              portalState,
              registryAccessServiceToken,
              payment
            });
            results.push({
              checkout_session_id: session.checkout_session_id,
              status: outcome.body.status,
              payment_status: payment.status
            });
            continue;
          }
        }
        if (session.status !== "fulfillment_pending") continue;
        const order = commerce.getOrder(session.order_id);
        const entitlement = commerce.getEntitlement(session.entitlement_id);
        if (!order || !entitlement) continue;
        await provisionCheckoutAccess({
          session,
          order,
          entitlement,
          registryUrl,
          fetchImpl,
          portalState,
          registryAccessServiceToken
        });
        results.push({ checkout_session_id: session.checkout_session_id, status: "completed" });
      } catch (error) {
        const failedSession = await portalState.noteCheckoutReconcileFailure?.(session.checkout_session_id, error).catch(() => null);
        if (failedSession) {
          try {
            const compensation = await compensateFailedCheckout(failedSession);
            if (compensation) {
              results.push(compensation);
              continue;
            }
          } catch (compensationError) {
            await portalState.noteCheckoutReconcileFailure?.(
              session.checkout_session_id,
              compensationError
            ).catch(() => undefined);
          }
        }
        results.push({
          checkout_session_id: session.checkout_session_id,
          status: "pending",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
  };

  const dispatchCommerceOutbox = async () => {
    if (typeof ledger.dispatchOutbox !== "function") return { claimed: 0, dispatched: 0, failed: 0, errors: [] };
    return ledger.dispatchOutbox(async (event) => {
      if (event.event_type === "entitlement.granted") {
        if (!registryAccessServiceToken) throw new Error("Registry access service token is not configured");
        const grant = await registryRequest(
          registryUrl,
          `/v1/user/products/${encodeURIComponent(event.agent_id)}/access`,
          {
            method: "POST",
            body: JSON.stringify({
              user_id: event.buyer_id,
              creator_id: event.creator_id,
              order_id: event.order_id,
              entitlement_id: event.entitlement_id,
              purchased_corpus_digest: event.purchased_corpus_digest ?? event.corpus_digest,
              version_policy: event.version_policy ?? "pinned"
            }),
            fetchImpl,
            headers: { authorization: `Bearer ${registryAccessServiceToken}` }
          }
        );
        if (grant.entitlement_id !== event.entitlement_id) {
          throw new Error("Registry returned a different entitlement projection");
        }
      }
      if (event.event_type === "entitlement.revoked") {
        if (!registryAccessServiceToken) throw new Error("Registry access service token is not configured");
        await registryRequest(
          registryUrl,
          `/v1/user/product-access/${encodeURIComponent(event.entitlement_id)}`,
          {
            method: "DELETE",
            body: JSON.stringify({ user_id: event.buyer_id }),
            fetchImpl,
            headers: { authorization: `Bearer ${registryAccessServiceToken}` }
          }
        );
      }
    });
  };

  const reconcileCreatorPayout = async (creatorId, currency) => {
    if (!paymentProvider.configured || payoutSchedule !== "immediate") return null;
    await ledger.refresh?.();
    const account = commerce.getPayoutAccount(creatorId, currency);
    const balance = commerce.getPayoutBalance(creatorId, currency);
    if (account.status !== "active" || balance.available_minor < payoutMinimumMinor) return null;
    const batchIdentity = [
      creatorId,
      currency,
      balance.available_minor,
      balance.recognized_minor,
      balance.reversed_minor,
      balance.adjustments_minor
    ].join(":");
    const batchId = `batch_${createHash("sha256").update(batchIdentity).digest("hex").slice(0, 24)}`;
    const payout = await commerce.createPayout({
      creator_id: creatorId,
      currency,
      batch_id: batchId,
      amount_minor: balance.available_minor,
      actor_id: "payout-reconciler",
      service_name: "dashboard-bff",
      reason: "scheduled_payout",
      idempotency_key: `payout:${batchId}`
    });
    return submitReservedPayout(payout, paymentProvider, commerce, `payout:${batchId}:attempt:${payout.attempt}`);
  };

  const reconcilePendingPayout = async (payout) => {
    if (!paymentProvider.configured || typeof paymentProvider.retrievePayout !== "function") return null;
    if (!new Set(["submitted", "in_transit"]).has(payout.status) || !payout.provider_payout_id) return null;
    const submittedAt = Date.parse(payout.submitted_at ?? payout.created_at ?? "");
    if (Number.isFinite(submittedAt) && Date.now() - submittedAt < payoutReconcileAfterMs) return null;
    const attempt = Number(payout.reconciliation?.retry_count ?? 0) + 1;
    try {
      const result = await paymentProvider.retrievePayout({
        payout_id: payout.payout_id,
        provider_payout_id: payout.provider_payout_id,
        provider: payout.provider,
        attempt: payout.attempt,
        idempotency_key: `payout:${payout.payout_id}:attempt:${payout.attempt}:status`
      });
      if (result.provider && result.provider !== payout.provider) {
        throw stateError("payout_provider_identity_mismatch", "Payout status came from a different provider.", 502);
      }
      if (result.provider_payout_id !== payout.provider_payout_id) {
        throw stateError("payout_provider_identity_mismatch", "Payout provider returned a different attempt identity.", 502);
      }
      if (!new Set(["in_transit", "paid", "failed"]).has(result.status) || !result.provider_event_id) {
        throw stateError("payout_provider_response_invalid", "Payout provider returned an invalid status result.", 502);
      }
      return commerce.recordPayoutProviderEvent({
        payout_id: payout.payout_id,
        provider: payout.provider,
        provider_payout_id: payout.provider_payout_id,
        provider_event_id: String(result.provider_event_id),
        status: result.status,
        provider_occurred_at: result.provider_occurred_at,
        failure_code: result.failure_code,
        failure_message: providerFailureMessage(result.failure_code, result.status, "payout"),
        actor_id: payout.provider,
        service_name: "payout-provider"
      });
    } catch (error) {
      await commerce.recordPayoutReconciliationFailure({
        payout_id: payout.payout_id,
        provider: payout.provider,
        provider_payout_id: payout.provider_payout_id,
        failure_code: error.code ?? "provider_status_unavailable",
        actor_id: "payout-reconciler",
        service_name: "dashboard-bff",
        idempotency_key: `payout:${payout.payout_id}:attempt:${payout.attempt}:reconcile-failure:${attempt}`
      });
      throw error;
    }
  };

  const reconcilePayouts = async () => {
    if (!paymentProvider.configured) return [];
    await ledger.refresh?.();
    const results = [];
    for (const account of commerce.listPayoutAccounts()) {
      for (const pending of commerce.listCreatorPayouts(account.creator_id, account.currency)) {
        try {
          const payout = await reconcilePendingPayout(pending);
          if (payout) results.push(payout);
        } catch (error) {
          results.push({
            payout_id: pending.payout_id,
            creator_id: account.creator_id,
            currency: account.currency,
            status: pending.status,
            error: error.code ?? "provider_status_unavailable"
          });
        }
      }
      try {
        const payout = await reconcileCreatorPayout(account.creator_id, account.currency);
        if (payout) results.push(payout);
      } catch (error) {
        results.push({
          creator_id: account.creator_id,
          currency: account.currency,
          error: typeof error?.code === "string" ? error.code : "payout_reconciliation_failed"
        });
      }
    }
    return results;
  };

  const reconcileFinance = async () => ({
    reservations: await commerce.reconcileExpiredReservations(new Date()),
    revenue: await commerce.reconcilePendingRevenue(),
    payouts: await reconcilePayouts()
  });

  const reconcileDeployments = async () => {
    if (!registryDeploymentServiceToken) return [];
    await portalState.refresh?.();
    const results = [];
    for (const state of portalState.listCreatorProducts()) {
      const operation = state.publish_operation ?? state.rollback_operation;
      if (!operation) continue;
      try {
        const completed = state.publish_operation
          ? await resumePublishDeployment({
              creatorId: state.creator_id,
              productId: state.product_id,
              state,
              portalState,
              commerce,
              registryUrl,
              fetchImpl,
              registryDeploymentServiceToken
            })
          : await resumeRollbackDeployment({
              creatorId: state.creator_id,
              productId: state.product_id,
              state,
              portalState,
              commerce,
              registryUrl,
              fetchImpl,
              registryDeploymentServiceToken
            });
        results.push({ operation_id: operation.operation_id, status: completed.status });
      } catch (error) {
        await portalState.noteDeploymentFailure(
          state.creator_id,
          state.product_id,
          operation.operation_id,
          error
        ).catch(() => undefined);
        results.push({ operation_id: operation.operation_id, status: "pending", error: error.code ?? "deployment_failed" });
      }
    }
    return results;
  };

  const handler = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://dashboard.local");
    const requestId = normalizedRequestId(request.headers["x-request-id"]);
    try {
      if (request.method === "OPTIONS") return send(response, 204, undefined);
      response.__hatchRequestId = requestId;
      response.__includeRequestId = url.pathname.startsWith("/v1/");
      response.setHeader("x-request-id", requestId);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        try {
          if (process.env.NODE_ENV === "production"
            && (!registryAccessServiceToken || !registryDeploymentServiceToken || !commerceRuntimeServiceToken)) {
            throw new Error("Dashboard service credentials are not configured");
          }
          await ledger.refresh?.();
          await portalState.ready?.();
          await telemetry.ready?.();
          const registryHealth = await fetchImpl(new URL("/readyz", registryUrl), {
            signal: AbortSignal.timeout(2_000)
          });
          if (!registryHealth.ok) throw new Error(`Registry health returned ${registryHealth.status}`);
          return send(response, 200, { ok: true, commerce: "ready", registry: "ready" });
        } catch {
          return send(response, 503, {
            ok: false,
            error: {
              code: "dashboard_not_ready",
              message: "Dashboard dependencies are not ready."
            }
          });
        }
      }
      if (url.pathname.startsWith("/v1/")) await portalState.refresh?.();
      if (request.method === "POST" && url.pathname === "/v1/analytics/events") {
        const originError = crossSiteMutationError(request);
        if (originError) return send(response, originError.status, originError.body);
        const rate = consumeFixedWindowRateLimit(
          analyticsRateWindows,
          request.socket?.remoteAddress ?? "unknown",
          analyticsRateLimit,
          analyticsRateWindowMs
        );
        if (!rate.allowed) {
          response.setHeader("retry-after", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))));
          return send(response, 429, { error: { code: "analytics_rate_limited", message: "Too many analytics events." } });
        }
        const body = await readJson(request);
        // The HTTP request id is response metadata, not part of the durable
        // analytics intent. Omitting a generated id here lets a browser retry
        // the same Idempotency-Key after response loss without a false conflict.
        const event = await telemetry.record(body.event_name, body.attributes ?? {}, {
          idempotencyKey: requireCommandKey(request, body)
        });
        return send(response, 202, { accepted: true, event_id: event.event_id });
      }
      const providerWebhookMatch = url.pathname.match(/^\/v1\/provider-webhooks\/(payment|payout)$/);
      if (request.method === "POST" && providerWebhookMatch) {
        if (!paymentProvider.configured) {
          return send(response, 404, { error: { code: "not_found", message: "Provider webhook route is not configured." } });
        }
        const rawBody = await readRawBody(request, DEFAULT_JSON_BODY_MAX_BYTES);
        const event = paymentProvider.verifyWebhook(rawBody, request.headers);
        if (providerWebhookMatch[1] === "payment") {
          const current = commerce.getPayment(String(event.payment_id ?? ""));
          if (!current) return send(response, 404, { error: { code: "payment_not_found", message: "Payment was not found." } });
          const session = portalState.findCheckoutSessionByPaymentId(current.payment_id);
          const providerCommand = {
            payment_id: current.payment_id,
            provider: current.provider,
            provider_event_id: String(event.provider_event_id),
            provider_payment_id: event.provider_payment_id,
            provider_sequence: event.provider_sequence,
            provider_occurred_at: event.provider_occurred_at,
            status: event.status,
            next_action: event.next_action,
            failure_code: event.failure_code,
            failure_message: providerFailureMessage(event.failure_code, event.status, "payment"),
            actor_id: current.provider,
            service_name: "payment-provider"
          };
          let transaction = null;
          const recorded = event.status === "succeeded" && session
            ? (transaction = await commerce.confirmCheckoutFromProviderEvent(
              providerCommand,
              checkoutCommerceInput(session, { profile: session.buyer }, current)
            ))
            : await commerce.recordPaymentProviderEvent(providerCommand);
          let checkoutStatus = session?.status ?? null;
          if (session) {
            const updated = await portalState.markCheckoutPayment(session.checkout_session_id, {
              payment_id: current.payment_id,
              provider: current.provider,
              status: recorded.payment.status,
              redirect_url: recorded.payment.next_action?.redirect_url
            });
            checkoutStatus = updated.status;
            if (recorded.payment.status === "succeeded" && !["completed", "fulfillment_pending"].includes(updated.status)) {
              const outcome = await finalizeCheckoutOrder({
                session: updated,
                authentication: { profile: updated.buyer },
                registryUrl,
                fetchImpl,
                commerce,
                portalState,
                registryAccessServiceToken,
                payment: recorded.payment,
                transaction
              });
              checkoutStatus = outcome.body.status;
              await recordCheckoutTelemetry(recordTelemetry, outcome.body, updated, requestId);
            } else if (["failed", "cancelled"].includes(recorded.payment.status)) {
              await recordCheckoutTelemetry(recordTelemetry, {
                status: recorded.payment.status,
                payment: recorded.payment
              }, updated, requestId);
            }
          }
          return send(response, 200, {
            received: true,
            applied: recorded.applied,
            payment_status: recorded.payment.status,
            checkout_status: checkoutStatus
          });
        }
        const current = commerce.getPayout(String(event.payout_id ?? ""));
        if (!current) return send(response, 404, { error: { code: "payout_not_found", message: "Payout was not found." } });
        const payout = await commerce.recordPayoutProviderEvent({
          payout_id: current.payout_id,
          provider: current.provider,
          provider_event_id: String(event.provider_event_id),
          provider_payout_id: event.provider_payout_id ?? current.provider_payout_id,
          provider_occurred_at: event.provider_occurred_at,
          status: event.status,
          failure_code: event.failure_code,
          failure_message: providerFailureMessage(event.failure_code, event.status, "payout"),
          actor_id: current.provider,
          service_name: "payout-provider"
        });
        return send(response, 200, { received: true, payout });
      }
      if (url.pathname.startsWith("/v1/internal/commerce/")) {
        if (!commerceRuntimeServiceToken) {
          return send(response, 503, { error: { code: "commerce_service_unavailable", message: "Internal Commerce commands are not configured." } });
        }
        const serviceToken = bearerTokenFromAuthorization(request);
        if (!serviceToken || !safeEqual(serviceToken, commerceRuntimeServiceToken)) {
          return send(response, 403, { error: { code: "forbidden", message: "A Commerce Runtime service credential is required." } });
        }
        const idempotencyMatch = url.pathname.match(/^\/v1\/internal\/commerce\/idempotency\/(.+)$/);
        if (request.method === "GET" && idempotencyMatch) {
          const event = ledger.findByIdempotencyKey(decodeURIComponent(idempotencyMatch[1]));
          return event
            ? send(response, 200, { event })
            : send(response, 404, { error: { code: "event_not_found", message: "Commerce event was not found." } });
        }
        if (request.method === "POST" && url.pathname === "/v1/internal/commerce/events") {
          const body = await readJson(request);
          if (!["task.started", "artifact.created"].includes(body.type)) {
            return send(response, 400, { error: { code: "unsupported_event", message: "Runtime may append only task and artifact facts through this endpoint." } });
          }
          assertNoPrivateCommerceFields(body.payload);
          const event = await ledger.append(body.type, body.payload ?? {}, {
            idempotencyKey: requireCommandKey(request, body)
          });
          return send(response, 201, { event });
        }
      if (request.method === "POST" && new Set([
        "/v1/internal/commerce/reservations",
        "/v1/internal/commerce/authorize-and-reserve"
      ]).has(url.pathname)) {
          const body = await readJson(request);
          assertNoPrivateCommerceFields(body);
          const result = await commerce.authorizeAndReserve(body, {
            idempotencyKey: requireCommandKey(request, body)
          });
          await recordTelemetry("delivery_reserved", {
            creator_id: result.entitlement.creator_id,
            product_id: result.entitlement.product_id,
            request_id: requestId
          }, `delivery-reserved:${result.reservation.reservation_id}`);
          return send(response, 201, result);
        }
        const entitlementAuthorizationMatch = url.pathname.match(/^\/v1\/internal\/commerce\/entitlements\/([^/]+)\/authorization$/);
        if (request.method === "GET" && entitlementAuthorizationMatch) {
          const entitlement = commerce.getEntitlement(decodeURIComponent(entitlementAuthorizationMatch[1]));
          return entitlement
            ? send(response, 200, { authorization: entitlementAuthorization(entitlement) })
            : send(response, 404, { error: { code: "entitlement_not_found", message: "Entitlement was not found." } });
        }
        const internalEntitlementMatch = url.pathname.match(/^\/v1\/internal\/commerce\/entitlements\/([^/]+)$/);
        if (request.method === "GET" && internalEntitlementMatch) {
          const entitlement = commerce.getEntitlement(decodeURIComponent(internalEntitlementMatch[1]));
          return entitlement
            ? send(response, 200, { entitlement })
            : send(response, 404, { error: { code: "entitlement_not_found", message: "Entitlement was not found." } });
        }
        const authorizeReservationMatch = url.pathname.match(/^\/v1\/internal\/commerce\/entitlements\/([^/]+)\/authorize-and-reserve$/);
        if (request.method === "POST" && authorizeReservationMatch) {
          const body = await readJson(request);
          assertNoPrivateCommerceFields(body);
          return send(response, 201, await commerce.authorizeAndReserve({
            ...body,
            entitlement_id: decodeURIComponent(authorizeReservationMatch[1])
          }, { idempotencyKey: requireCommandKey(request, body) }));
        }
        const advanceEntitlementMatch = url.pathname.match(/^\/v1\/internal\/commerce\/entitlements\/([^/]+)\/advance-version$/);
        if (request.method === "POST" && advanceEntitlementMatch) {
          const body = await readJson(request);
          assertNoPrivateCommerceFields(body);
          const entitlementId = decodeURIComponent(advanceEntitlementMatch[1]);
          const current = commerce.getEntitlement(entitlementId);
          if (!current) {
            throw stateError("entitlement_not_found", "Entitlement was not found.", 404);
          }
          const commandKey = requireCommandKey(request, body);
          const authority = await verifyEntitlementVersionAuthority({
            entitlement: current,
            body,
            commandKey,
            ledger,
            registryUrl,
            fetchImpl,
            registryDeploymentServiceToken
          });
          const entitlement = await commerce.advanceEntitlementVersion({
            entitlement_id: entitlementId,
            from_digest: authority.from_digest,
            to_digest: authority.to_digest,
            from_release_id: authority.from_release_id,
            to_release_id: authority.to_release_id,
            compatibility_declaration_id: authority.compatibility_declaration_id,
            reason: "compatible_release_published"
          }, { idempotencyKey: commandKey });
          return send(response, 200, { entitlement });
        }
        const releaseReservationMatch = url.pathname.match(/^\/v1\/internal\/commerce\/reservations\/([^/]+)\/release$/);
        if (request.method === "POST" && releaseReservationMatch) {
          const body = await readJson(request);
          return send(response, 200, await commerce.releaseReservation({
            ...body,
            reservation_id: decodeURIComponent(releaseReservationMatch[1])
          }, { idempotencyKey: requireCommandKey(request, body) }));
        }
        if (request.method === "POST" && url.pathname === "/v1/internal/commerce/deliveries") {
          const body = await readJson(request);
          assertNoPrivateCommerceFields(body);
          const result = await commerce.completeDelivery(body, {
            idempotencyKey: requireCommandKey(request, body)
          });
          await recordTelemetry("delivery_completed", {
            creator_id: result.delivery.creator_id,
            product_id: result.delivery.product_id,
            request_id: requestId
          }, `delivery-completed:${result.delivery.delivery_id}`);
          return send(response, 201, result);
        }
        if (request.method === "POST" && url.pathname === "/v1/internal/commerce/reconcile-reservations") {
          const body = await readJson(request);
          return send(response, 200, {
            reservations: await commerce.reconcileExpiredReservations(body.now ? new Date(body.now) : new Date())
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/internal/commerce/reconcile-revenue") {
          return send(response, 200, await commerce.reconcilePendingRevenue());
        }
        if (request.method === "GET" && url.pathname === "/v1/internal/commerce/operations") {
          return send(response, 200, await commerceOperationsSnapshot({ ledger, commerce, portalState, telemetry }));
        }
        return send(response, 404, { error: { code: "not_found", message: "Internal Commerce route not found." } });
      }
      if (url.pathname === "/portal" || url.pathname.startsWith("/portal/") || url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
        return send(response, 404, { error: { code: "route_not_found", message: "That route is no longer available." } });
      }
      if (request.method === "GET" && (url.pathname === "/assets" || url.pathname.startsWith("/assets/"))) {
        return servePortalAsset(url.pathname, response);
      }
      if (request.method === "GET" && isPublicPortalRoute(url.pathname)) {
        let metadata = createDefaultMetadata(publicOrigin, "/explore");
        let portalStatus = 200;
        let noScriptFallback;
        const productRoute = url.pathname.match(/^\/products\/([^/]+)$/);
        const creatorRoute = url.pathname.match(/^\/creators\/([^/]+)$/);
        if (url.pathname.startsWith("/creators/") && !creatorRoute) {
          return send(response, 404, { error: { code: "creator_not_found", message: "Creator URL must use one UUID v4 segment." } });
        }
        if (creatorRoute && !UUID_V4_PATTERN.test(decodeURIComponent(creatorRoute[1]))) {
          return send(response, 404, { error: { code: "creator_not_found", message: "Creator URL must use a UUID v4." } });
        }
        if (productRoute) {
          const productSelector = decodeURIComponent(productRoute[1]);
          if (!UUID_V4_PATTERN.test(productSelector)) {
            return send(response, 404, { error: { code: "product_not_found", message: "Product URL must use a UUID v4." } });
          }
          try {
            await portalState.refresh?.();
            const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
            const agent = findCatalogAgent(catalog, undefined, productSelector);
            const state = agent ? portalState.getCreatorProduct(agent.creator_id, agent.product_id) : undefined;
            if (agent && state?.status !== "withdrawn") {
              const canonicalPath = publicProductPath(agent);
              if (canonicalPath !== url.pathname) {
                return send(response, 404, { error: { code: "product_not_found", message: "Product URL must use its canonical UUID v4." } });
              }
              const activeOffer = await authoritativeProductOffer(commerce, agent, state);
              const product = publicCatalogAgent(
                agent,
                state,
                paymentMode,
                activeOffer
              );
              metadata = createProductMetadata({
                origin: publicOrigin,
                creatorId: agent.creator_id,
                productId: agent.product_id,
                routePrefix: "/products",
                productName: product.product_name ?? product.name,
                creatorName: product.creator_name ?? product.creator_display_name ?? agent.creator_id,
                description: product.promise ?? product.description,
                imageUrl: product.image_url ?? product.presentation?.image_url
              });
              noScriptFallback = createProductNoScriptFallback({
                creatorId: product.creator_id,
                creatorName: product.creator_name ?? product.creator_display_name,
                productId: product.product_id,
                productName: product.product_name ?? product.name,
                description: product.promise ?? product.description,
                amountMinor: product.offer?.amount_minor
              });
            } else {
              metadata = createUnavailableProductMetadata(publicOrigin, productSelector, productSelector, "/products");
              portalStatus = 404;
            }
          } catch {
            // Product metadata is an enhancement to the public shell. Registry
            // outages must not turn an otherwise cached SPA shell into a 5xx.
          }
        }
        return servePortalIndex(response, metadata, portalStatus, noScriptFallback);
      }
      if (request.method === "POST" && ["/v1/auth/login", "/v1/auth/sign-in"].includes(url.pathname)) {
        const originError = crossSiteMutationError(request);
        if (originError) return send(response, originError.status, originError.body);
        const body = await readJson(request);
        await recordTelemetry("auth_started", { request_id: requestId }, `auth-started:${requestId}`);
        const auth = await registryRequest(registryUrl, "/v1/auth/signin", {
          method: "POST",
          body: JSON.stringify({ email: body.email, password: body.password }),
          fetchImpl
        });
        const profile = publicProfile(auth.account);
        const webSession = await portalState.createWebSession(auth.token, profile);
        await recordTelemetry("auth_completed", { request_id: requestId }, `auth-completed:${webSession.session_id}`);
        setWebSessionCookies(request, response, webSession.session_id);
        return send(response, 200, {
          ...(exposeBearerTokens ? { token: auth.token } : {}),
          profile
        });
      }
      if (request.method === "POST" && ["/v1/auth/signup", "/v1/auth/sign-up"].includes(url.pathname)) {
        const originError = crossSiteMutationError(request);
        if (originError) return send(response, originError.status, originError.body);
        const body = await readJson(request);
        await recordTelemetry("auth_started", { request_id: requestId }, `auth-started:${requestId}`);
        const auth = await registryRequest(registryUrl, "/v1/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            email: body.email,
            password: body.password,
            display_name: body.display_name,
            role: "user"
          }),
          fetchImpl
        });
        const profile = publicProfile(auth.account);
        const webSession = await portalState.createWebSession(auth.token, profile);
        await recordTelemetry("auth_completed", { request_id: requestId }, `auth-completed:${webSession.session_id}`);
        setWebSessionCookies(request, response, webSession.session_id);
        return send(response, 201, {
          ...(exposeBearerTokens ? { token: auth.token } : {}),
          profile
        });
      }
      if (request.method === "POST" && ["/v1/auth/logout", "/v1/auth/sign-out"].includes(url.pathname)) {
        const csrfError = cookieCsrfError(request);
        if (csrfError) return send(response, csrfError.status, csrfError.body);
        const webSessionId = requestCookies(request).hatch_web_session;
        if (webSessionId) await portalState.deleteWebSession(webSessionId);
        clearWebSessionCookies(request, response);
        return send(response, 204, undefined);
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        const authentication = await authenticate(request, registryUrl, undefined, fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        return send(response, 200, authentication.profile);
      }

      if (request.method === "GET" && url.pathname === "/v1/public/products") {
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const buyer = await optionalBuyer(request, registryUrl, fetchImpl, portalState);
        const entitlements = buyer ? commerce.listBuyerEntitlements(buyer.id) : [];
        await recordTelemetry("catalog_viewed", { request_id: requestId }, `catalog-viewed:${requestId}`);
        const visible = catalog.filter((agent) => portalState.getCreatorProduct(agent.creator_id, agent.product_id)?.status !== "withdrawn");
        const products = await Promise.all(visible.map(async (agent) => {
          const state = portalState.getCreatorProduct(agent.creator_id, agent.product_id);
          return withBuyerAccess(
            publicCatalogAgent(
              agent,
              state,
              paymentMode,
              await authoritativeProductOffer(commerce, agent, state)
            ),
            entitlements
          );
        }));
        return send(response, 200, products);
      }

      if (request.method === "GET" && url.pathname === "/v1/public/creators") {
        const creators = await registryRequest(registryUrl, "/v1/public/creators", { fetchImpl });
        return send(response, 200, Array.isArray(creators) ? creators : []);
      }

      const publicCreatorMatch = url.pathname.match(/^\/v1\/public\/creators\/([^/]+)$/);
      if (request.method === "GET" && publicCreatorMatch) {
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const creatorSelector = decodeURIComponent(publicCreatorMatch[1]);
        if (!UUID_V4_PATTERN.test(creatorSelector)) return send(response, 404, { error: { code: "creator_not_found", message: "Creator was not found." } });
        const creatorProducts = catalog.filter((entry) => (
          String(entry.creator_id) === String(creatorSelector)
          && portalState.getCreatorProduct(entry.creator_id, entry.product_id)?.status !== "withdrawn"
        ));
        if (!creatorProducts.length) return send(response, 404, { error: { code: "creator_not_found", message: "Creator was not found." } });
        const products = await Promise.all(creatorProducts.map(async (entry) => {
          const state = portalState.getCreatorProduct(entry.creator_id, entry.product_id);
          return publicCatalogAgent(entry, state, paymentMode, await authoritativeProductOffer(commerce, entry, state));
        }));
        const first = products[0];
        return send(response, 200, {
          creator: {
            id: first.creator_id,
            name: first.creator_name ?? first.creator_display_name ?? first.creator_id,
            verified: Boolean(first.creator_verified)
          },
          products
        });
      }

      const publicProductMatch = url.pathname.match(/^\/v1\/public\/products\/([^/]+)$/);
      if (request.method === "GET" && publicProductMatch) {
        const detailSelectors = [publicProductMatch[1]];
        if (!UUID_V4_PATTERN.test(decodeURIComponent(detailSelectors[0]))) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const agent = findCatalogAgent(catalog, undefined, decodeURIComponent(detailSelectors[0]));
        const creatorState = agent ? portalState.getCreatorProduct(agent.creator_id, agent.product_id) : undefined;
        if (!agent || creatorState?.status === "withdrawn") return send(response, 404, { error: { code: "agent_unavailable", message: "The published Agent could not be found." } });
        const buyer = await optionalBuyer(request, registryUrl, fetchImpl, portalState);
        const entitlements = buyer ? commerce.listBuyerEntitlements(buyer.id) : [];
        const activeOffer = await authoritativeProductOffer(commerce, agent, creatorState);
        await recordTelemetry("product_viewed", {
          creator_id: agent.creator_id,
          product_id: agent.product_id,
          offer_id: activeOffer?.offer_id,
          release_id: creatorState?.release?.release_id ?? agent.corpus_digest,
          request_id: requestId
        }, `product-viewed:${requestId}`);
        return send(response, 200, {
          product: withBuyerAccess(
            publicCatalogAgent(
              agent,
              creatorState,
              paymentMode,
              activeOffer
            ),
            entitlements
          )
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/checkout-sessions") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const body = await readJson(request);
        const commandKey = requireCommandKey(request, body);
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const requestedProductId = String(body.product_id ?? "").trim();
        if (!UUID_V4_PATTERN.test(requestedProductId)) return send(response, 400, { error: { code: "invalid_product_id", message: "product_id must be a UUID v4." } });
        const candidates = catalog.filter((entry) => (
          entry.product_id === requestedProductId
        ));
        if (candidates.length > 1) {
          return send(response, 409, { error: { code: "ambiguous_product", message: "This product id is not globally unique. Use the current public product link." } });
        }
        const agent = candidates[0];
        if (!agent) return send(response, 404, { error: { code: "agent_unavailable", message: "The published Agent could not be found." } });
        const creatorState = portalState.getCreatorProduct(agent.creator_id, agent.product_id);
        const product = publicCatalogAgent(
          agent,
          creatorState,
          paymentMode,
          await authoritativeProductOffer(commerce, agent, creatorState)
        );
        if (!product.offer || product.availability !== "published") {
          return send(response, 409, { error: { code: "not_for_sale", message: "This Agent does not have an active offer." } });
        }
        if (product.offer.purchase_model === "subscription" || product.offer.model === "subscription") {
          return send(response, 409, { error: { code: "subscription_unavailable", message: "Subscriptions are not available yet." } });
        }
        if (String(body.offer_id ?? "") !== String(product.offer.offer_id ?? "")) {
          return send(response, 409, {
            error: {
              code: "offer_changed",
              message: "The selected offer is no longer active.",
              details: { requested_offer_id: body.offer_id ?? null, current_offer: product.offer }
            }
          });
        }
        const requestKey = commandKey;
        const existing = portalState.findCheckoutSessionByRequest(authentication.profile.id, requestKey);
        const session = existing ?? await portalState.createCheckoutSession({
          request_key: requestKey,
          buyer_id: authentication.profile.id,
          buyer: authentication.profile,
          product,
          creator: { id: product.creator_id, name: product.creator_name },
          release: {
            release_id: product.release_id ?? product.corpus_digest,
            corpus_digest: product.corpus_digest
          },
          offer_snapshot: product.offer,
          totals: {
            subtotal_minor: product.offer.amount_minor,
            discount_minor: 0,
            tax_minor: null,
            total_minor: product.offer.amount_minor,
            currency: product.offer.currency
          },
          entitlement_scope: {
            unit: product.offer.unit ?? "delivery",
            included_units: product.offer.included_units ?? 1,
            version_policy: product.offer.version_policy ?? "pinned"
          }
        });
        await recordTelemetry("checkout_started", {
          creator_id: product.creator_id,
          product_id: product.product_id,
          offer_id: product.offer.offer_id,
          offer_revision: product.offer.revision,
          release_id: product.release_id,
          request_id: requestId
        }, `checkout-started:${session.checkout_session_id}`);
        return send(response, existing ? 200 : 201, { checkout_session: session });
      }

      const checkoutSessionMatch = url.pathname.match(/^\/v1\/checkout-sessions\/([^/]+)$/);
      if (request.method === "GET" && checkoutSessionMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const session = portalState.getCheckoutSession(decodeURIComponent(checkoutSessionMatch[1]));
        if (!session || session.buyer_id !== authentication.profile.id) {
          return send(response, 404, { error: { code: "checkout_not_found", message: "Checkout session was not found." } });
        }
        return send(response, 200, { checkout_session: session });
      }

      const checkoutConfirmMatch = url.pathname.match(/^\/v1\/checkout-sessions\/([^/]+)\/confirm$/);
      if (request.method === "POST" && checkoutConfirmMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const body = await readJson(request);
        const commandKey = requireCommandKey(request, body);
        const session = portalState.getCheckoutSession(decodeURIComponent(checkoutConfirmMatch[1]));
        if (!session || session.buyer_id !== authentication.profile.id) {
          return send(response, 404, { error: { code: "checkout_not_found", message: "Checkout session was not found." } });
        }
        const outcome = await confirmCheckoutSession({
          session,
          authentication,
          request,
          registryUrl,
          fetchImpl,
          commerce,
          portalState,
          paymentMode,
          paymentProvider,
          commandKey,
          paymentScenario: body.sandbox_scenario,
          registryAccessServiceToken
        });
        await recordCheckoutTelemetry(recordTelemetry, outcome.body, session, requestId);
        return send(response, outcome.replayed ? 200 : 201, outcome.body);
      }

      if (request.method === "GET" && url.pathname === "/v1/user/product-access") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const [access, catalog] = await Promise.all([
          registryRequest(registryUrl, "/v1/user/product-access", {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          }),
          authoritativeCatalog(registryUrl, fetchImpl, portalState)
        ]);
        return send(response, 200, { creator_agents: mergeRegistryAgents(access, catalog) });
      }

      if (request.method === "GET" && ["/v1/user/orders", "/v1/orders"].includes(url.pathname)) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const status = url.searchParams.get("status");
        const orders = commerce.listBuyerOrders(authentication.profile.id)
          .map((order) => orderDetail(order))
          .filter((order) => !status || status === "all" || order.status === status);
        const page = paginate(orders, url);
        return send(response, 200, { orders: page.items, next_cursor: page.next_cursor });
      }

      const buyerOrderMatch = url.pathname.match(/^\/v1\/(?:user\/orders|orders)\/([^/]+)$/);
      if (request.method === "GET" && buyerOrderMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const order = resolveOrderIdentifier(commerce, decodeURIComponent(buyerOrderMatch[1]), authentication.profile.id);
        if (order && order.buyer_id && order.buyer_id !== authentication.profile.id) {
          return send(response, 404, { error: { code: "order_not_found", message: "Order was not found." } });
        }
        if (!order) return send(response, 404, { error: { code: "order_not_found", message: "Order was not found." } });
        return send(response, 200, { order: orderDetail(order) });
      }

      const buyerRefundMatch = url.pathname.match(/^\/v1\/(?:user\/orders|orders)\/([^/]+)\/(refund-requests|cancel)$/);
      if (request.method === "POST" && buyerRefundMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const requestedOrder = decodeURIComponent(buyerRefundMatch[1]);
        const current = resolveOrderIdentifier(commerce, requestedOrder, authentication.profile.id);
        if (!current || (current.buyer_id && current.buyer_id !== authentication.profile.id)) {
          return send(response, 404, { error: { code: "order_not_found", message: "Order was not found." } });
        }
        const orderId = current.order_id;
        const isCancel = buyerRefundMatch[2] === "cancel";
        if (isCancel && current.gross_minor !== 0) {
          return send(response, 409, {
            error: {
              code: "paid_cancel_not_supported",
              message: "Paid cancellation is not available yet."
            }
          });
        }
        if (current.gross_minor === 0 && current.deliveries.length > 0) {
          return send(response, 409, {
            error: {
              code: "free_access_already_consumed",
              message: "Free access cannot be removed after its delivery has completed."
            }
          });
        }
        const body = await readJson(request);
        const commandKey = requireCommandKey(request, body);
        const providerRefund = await confirmedProviderRefund(paymentProvider, current, {
          actor_id: authentication.profile.id,
          reason: String(body.reason ?? "buyer_request"),
          idempotency_key: commandKey
        });
        const order = await commerce.refundOrder({
          order_id: orderId,
          buyer_id: authentication.profile.id,
          actor_id: authentication.profile.id,
          reason: String(body.reason ?? "buyer_request"),
          ...providerRefund
        }, { idempotencyKey: commandKey });
        let accessStatus = "not_applicable";
        if (order.entitlement?.entitlement_id) {
          if (!registryAccessServiceToken) throw stateError("access_service_unavailable", "Registry access provisioning is not configured.", 503);
          try {
            await registryRequest(registryUrl, `/v1/user/product-access/${encodeURIComponent(order.entitlement.entitlement_id)}`, {
              method: "DELETE",
              body: JSON.stringify({ user_id: authentication.profile.id }),
              fetchImpl,
              headers: { authorization: `Bearer ${registryAccessServiceToken}` }
            });
            accessStatus = "revoked";
          } catch {
            // Commerce is authoritative; its durable outbox will retry the
            // Registry projection without making a successful refund look lost.
            accessStatus = "syncing";
            dispatchCommerceOutbox().catch(() => undefined);
          }
        }
        return send(response, 201, { refund: order.refunds.at(-1), order: orderDetail(order), access_status: accessStatus });
      }

      if (request.method === "POST" && url.pathname === "/v1/user/checkout") {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const body = await readJson(request);
        const commandKey = requireCommandKey(request, body);
        const creatorId = String(body.creator_id ?? "").trim();
        const productId = String(body.product_id ?? "").trim();
        if (!creatorId || !productId) {
          return send(response, 400, { error: { code: "invalid_checkout", message: "creator_id and product_id are required." } });
        }
        // A completed legacy intent must remain replayable even if its offer
        // is later changed or withdrawn. Resolve the durable intent before
        // consulting today's catalog; only a fresh intent is quoted anew.
        const requestKey = `legacy-checkout:${commandKey}`;
        const existing = portalState.findCheckoutSessionByRequest(authentication.profile.id, requestKey);
        if (existing) {
          if (!checkoutSessionMatchesSelector(existing, creatorId, productId)) {
            throw stateError("idempotency_conflict", "This Idempotency-Key was already used for a different checkout intent.", 409);
          }
          const outcome = await confirmCheckoutSession({
            session: existing,
            authentication,
            registryUrl,
            fetchImpl,
            commerce,
            portalState,
            paymentMode,
            paymentProvider,
            registryAccessServiceToken,
            commandKey
          });
          return send(response, outcome.replayed ? 200 : 201, outcome.body);
        }
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const agent = catalog.find((entry) => entry.creator_id === creatorId && entry.product_id === productId);
        if (!agent) {
          return send(response, 404, { error: { code: "agent_unavailable", message: "The published Agent could not be found." } });
        }
        const product = publicCatalogAgent(
          agent,
          portalState.getCreatorProduct(agent.creator_id, agent.product_id),
          paymentMode,
          await authoritativeProductOffer(
            commerce,
            agent,
            portalState.getCreatorProduct(agent.creator_id, agent.product_id)
          )
        );
        if (!product.offer || product.availability !== "published") {
          return send(response, 409, { error: { code: "not_for_sale", message: "This Agent does not have an active offer." } });
        }
        if (product.offer.purchase_model === "subscription" || product.offer.model === "subscription") {
          return send(response, 409, { error: { code: "subscription_unavailable", message: "Subscriptions are not available yet." } });
        }
        // The key identifies one Buyer intent, not a permanent
        // Buyer/product pair. Replaying the same intent is idempotent while a
        // fresh key creates a fresh checkout and can legitimately buy another
        // delivery unit for the same product.
        const session = await portalState.createCheckoutSession({
          request_key: requestKey,
          buyer_id: authentication.profile.id,
          buyer: authentication.profile,
          product,
          creator: { id: product.creator_id, name: product.creator_name },
          release: { release_id: product.release_id ?? product.corpus_digest, corpus_digest: product.corpus_digest },
          offer_snapshot: product.offer,
          totals: {
            subtotal_minor: product.offer.amount_minor,
            discount_minor: 0,
            tax_minor: null,
            total_minor: product.offer.amount_minor,
            currency: product.offer.currency
          },
          entitlement_scope: {
            unit: product.offer.unit ?? "delivery",
            included_units: product.offer.included_units ?? 1,
            version_policy: product.offer.version_policy ?? "pinned"
          }
        });
        if (!checkoutSessionMatchesSelector(session, creatorId, productId)) {
          throw stateError("idempotency_conflict", "This Idempotency-Key was already used for a different checkout intent.", 409);
        }
        const outcome = await confirmCheckoutSession({
          session,
          authentication,
          registryUrl,
          fetchImpl,
          commerce,
          portalState,
          paymentMode,
          paymentProvider,
          registryAccessServiceToken,
          commandKey
        });
        return send(response, outcome.replayed ? 200 : 201, outcome.body);
      }

      const accessMatch = url.pathname.match(/^\/v1\/user\/products\/([^/]+)\/access$/);
      if (request.method === "POST" && accessMatch) {
        return send(response, 404, { error: { code: "not_found", message: "Route not found." } });
      }

      if (request.method === "GET" && url.pathname === "/v1/creator/products") {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        requireCapability(authentication.profile, "product:read");
        return send(response, 200, await registryRequest(registryUrl, "/v1/creator/products", {
          fetchImpl,
          headers: { authorization: `Bearer ${bearerToken(request)}` }
        }));
      }

      if (request.method === "POST" && url.pathname === "/v1/creator/factory-drafts") {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        requireCapability(authentication.profile, "product:edit");
        const body = await readJson(request, factoryRequestMaxBytes);
        const commandKey = requireCommandKey(request, body);
        const draftId = stableFactoryDraftId(authentication.profile.id, commandKey);
        const draft = await portalState.saveFactoryDraft(
          authentication.profile.id,
          draftId,
          body,
          body.expected_version ?? 0,
          commandKey
        );
        return send(response, 201, { draft });
      }

      const factoryDraftStartMatch = url.pathname.match(/^\/v1\/creator\/factory-drafts\/([^/]+)\/start$/);
      if (request.method === "POST" && factoryDraftStartMatch) {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        requireCapability(authentication.profile, "product:edit");
        const body = await readJson(request, factoryRequestMaxBytes);
        const commandKey = requireCommandKey(request, body);
        const draftId = decodeURIComponent(factoryDraftStartMatch[1]);
        const started = await portalState.beginFactoryDraftStart(
          authentication.profile.id,
          draftId,
          body.expected_version,
          commandKey
        );
        if (started.receipt.status === "completed") {
          return send(response, 202, {
            run: started.receipt.run,
            draft_id: draftId,
            draft_version: started.draft.version
          });
        }
        const draft = started.draft;
        const run = await registryRequest(registryUrl, "/v1/creator/factory-runs", {
          method: "POST",
          body: JSON.stringify({
            task_name: draft.task_name,
            task_brief: draft.task_brief,
            sources: draft.sources
          }),
          fetchImpl,
          headers: {
            authorization: `Bearer ${bearerToken(request)}`,
            "idempotency-key": commandKey
          }
        });
        await portalState.completeFactoryDraftStart(authentication.profile.id, draftId, commandKey, run);
        return send(response, 202, { run, draft_id: draftId, draft_version: draft.version });
      }

      const factoryDraftMatch = url.pathname.match(/^\/v1\/creator\/factory-drafts\/([^/]+)$/);
      if (factoryDraftMatch) {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const draftId = decodeURIComponent(factoryDraftMatch[1]);
        if (request.method === "GET") {
          requireCapability(authentication.profile, "product:read");
          return send(response, 200, { draft: portalState.getFactoryDraft(authentication.profile.id, draftId) });
        }
        if (request.method === "PUT" || request.method === "PATCH") {
          requireCapability(authentication.profile, "product:edit");
          const body = await readJson(request, factoryRequestMaxBytes);
          const draft = await portalState.saveFactoryDraft(
            authentication.profile.id,
            draftId,
            body,
            body.expected_version,
            requireCommandKey(request, body)
          );
          await recordTelemetry(draft.version === 1 ? "factory_draft_started" : "factory_draft_saved", {
            creator_id: authentication.profile.id,
            request_id: requestId
          }, `factory-draft:${authentication.profile.id}:${draft.draft_id}:${draft.version}`);
          return send(response, 200, { draft });
        }
      }

      if (url.pathname.startsWith("/v1/creator/factory-runs")) {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        requireCapability(authentication.profile, request.method === "GET" ? "product:read" : "product:edit");
        const body = request.method === "GET"
          ? undefined
          : JSON.stringify(await readJson(request, factoryRequestMaxBytes));
        const payload = await registryRequest(registryUrl, url.pathname, {
          method: request.method,
          ...(body === undefined ? {} : { body }),
          fetchImpl,
          headers: {
            authorization: `Bearer ${bearerToken(request)}`,
            ...(request.headers["idempotency-key"] ? { "idempotency-key": String(request.headers["idempotency-key"]) } : {})
          }
        });
        if (request.method === "POST" && url.pathname === "/v1/creator/factory-runs") {
          await portalState.clearFactoryDraft(authentication.profile.id, "default");
        }
        return send(response, request.method === "GET" ? 200 : 202, payload);
      }

      if (url.pathname.startsWith("/v1/creator/")) {
        const authentication = await authenticate(request, registryUrl, "creator", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const profile = authentication.profile;
        const projection = commerce.getCreatorDashboard(profile.id);
        const creatorOrders = commerce.listCreatorOrders(profile.id).map((order) => orderDetail(order));
        let creatorAgentsPromise;
        const creatorAgents = async () => {
          creatorAgentsPromise ??= registryRequest(registryUrl, "/v1/creator/products", {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          });
          const agents = await creatorAgentsPromise;
          return Array.isArray(agents) ? agents : [];
        };
        const creatorProducts = async () => {
          const agents = await creatorAgents();
          let runs = [];
          try {
            const payload = await registryRequest(registryUrl, "/v1/creator/factory-runs", {
              fetchImpl,
              headers: { authorization: `Bearer ${bearerToken(request)}` }
            });
            runs = payload.runs ?? [];
          } catch {
            // Registry deployments predating Factory listing remain usable.
          }
          return creatorProductViews(
            agents,
            runs,
            portalState.listCreatorProducts(profile.id),
            profile.id
          ).map((product) => {
            const state = portalState.getCreatorProduct(profile.id, product.product_id);
            return {
              ...product,
              readiness: publishReadiness(product, state, paymentMode),
              paid_offers_enabled: isPaidMode(paymentMode),
              commerce_capabilities: {
                free_per_delivery: true,
                paid_per_delivery: isPaidMode(paymentMode),
                subscription: false
              }
            };
          });
        };
        if (request.method === "GET" && url.pathname === "/v1/creator/me") {
          return send(response, 200, publicProfile(profile));
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/overview") {
          requireCapability(profile, "product:read");
          requireCapability(profile, "commerce:read");
          return send(response, 200, {
            metrics: projection.metrics,
            products: await creatorProducts(),
            recent_orders: creatorOrders.slice(0, 5)
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/products") {
          requireCapability(profile, "product:read");
          return send(response, 200, { products: await creatorProducts() });
        }

        const creatorProductMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)$/);
        if (request.method === "GET" && creatorProductMatch) {
          requireCapability(profile, "product:read");
          const product = (await creatorProducts()).find((entry) => entry.product_id === decodeURIComponent(creatorProductMatch[1]));
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          return send(response, 200, { product });
        }

        const creatorReleasesMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/releases$/);
        if (request.method === "GET" && creatorReleasesMatch) {
          requireCapability(profile, "product:read");
          const productId = decodeURIComponent(creatorReleasesMatch[1]);
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          const releases = Array.isArray(product.releases) ? product.releases : [];
          return send(response, 200, { releases, active_release: product.release ?? product.active_release ?? null });
        }

        const withdrawMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/withdraw$/);
        if (request.method === "POST" && withdrawMatch) {
          const body = await readJson(request);
          requireCapability(profile, "release:publish");
          const commandKey = requireCommandKey(request, body);
          const productId = decodeURIComponent(withdrawMatch[1]);
          const state = await portalState.withdrawProduct(profile.id, productId, body.expected_version, {
            ...body,
            command_key: commandKey
          });
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          return send(response, 200, { product: creatorProductView(product, state), withdrawn_at: state.withdrawn_at });
        }

        const candidateMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/candidates\/([^/]+)$/);
        if (request.method === "GET" && candidateMatch) {
          requireCapability(profile, "product:read");
          const productId = decodeURIComponent(candidateMatch[1]);
          const candidateId = decodeURIComponent(candidateMatch[2]);
          const run = await registryRequest(registryUrl, `/v1/creator/factory-runs/${encodeURIComponent(candidateId)}`, {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          });
          const candidate = candidateFromFactoryRun(run, productId);
          candidate.resource_version = portalState.getCreatorProduct(profile.id, productId)?.version ?? 0;
          await recordTelemetry("candidate_ready", {
            creator_id: profile.id,
            product_id: productId,
            release_version: candidate.version
          }, `candidate-ready:${candidateId}:${candidate.report_digest}`);
          return send(response, 200, { candidate });
        }

        const candidateActionMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/candidates\/([^/]+)\/(approve|reject)$/);
        if (request.method === "POST" && candidateActionMatch) {
          const body = await readJson(request);
          requireCapability(profile, "release:approve");
          const commandKey = requireCommandKey(request, body);
          const productId = decodeURIComponent(candidateActionMatch[1]);
          const candidateId = decodeURIComponent(candidateActionMatch[2]);
          // Factory-only products also expose their candidate digest in the
          // merged Creator view. Only a current Registry Agent is evidence of
          // an already-live legacy release that must be migrated into Portal
          // and Commerce state before a new candidate is reviewed.
          const existingPublishedAgent = (await creatorAgents()).find((entry) => (
            entry.creator_id === profile.id && entry.product_id === productId
          ));
          if (existingPublishedAgent?.corpus_digest) {
            const seeded = await portalState.seedPublishedProduct(
              profile.id,
              productId,
              publicAgentSnapshot(existingPublishedAgent),
              normalizeOffer(existingPublishedAgent.product_offer, existingPublishedAgent)
            );
            if (seeded?.offer_active && !commerce.getActiveOffer(profile.id, productId)) {
              await activatePublishedOffer(
                commerce,
                seeded,
                profile.id,
                productId,
                seeded.active_deployment_id
              );
            }
          }
          if (candidateActionMatch[3] === "reject") {
            const product = await portalState.rejectCandidate(profile.id, productId, candidateId, body.expected_version, {
              reason: body.reason ?? "creator_rejection",
              command_key: commandKey
            });
            await recordTelemetry("candidate_rejected", {
              creator_id: profile.id,
              product_id: productId,
              request_id: requestId,
              error_category: String(body.reason ?? "creator_rejection")
            }, `candidate-rejected:${commandKey}`);
            return send(response, 200, {
              product
            });
          }
          const run = await registryRequest(registryUrl, `/v1/creator/factory-runs/${encodeURIComponent(candidateId)}`, {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          });
          const candidate = candidateFromFactoryRun(run, productId);
          const failedCritical = candidate.critical_gates.filter((gate) => gate.passed === false);
          if (!candidate.corpus_verified || failedCritical.length) {
            return send(response, 409, { error: { code: "candidate_incomplete", message: "Candidate has a failed critical gate." } });
          }
          if (String(body.report_digest ?? "") !== candidate.report_digest) {
            return send(response, 409, { error: { code: "candidate_report_changed", message: "The evaluation report changed. Review it again before approving." } });
          }
          const acknowledgements = new Set(Array.isArray(body.acknowledgements) ? body.acknowledgements.map(String) : []);
          const missingAcknowledgement = candidate.known_losses.find((loss) => !acknowledgements.has(String(loss.id)));
          if (missingAcknowledgement) {
            return send(response, 409, { error: { code: "candidate_loss_unacknowledged", message: "Acknowledge every known non-critical loss before approving." } });
          }
          const approvedProduct = await portalState.approveCandidate(profile.id, productId, candidate, body.expected_version, {
              reason: body.reason ?? "creator_approval",
              command_key: commandKey,
              acknowledgements: [...acknowledgements].sort()
            });
          await recordTelemetry("candidate_approved", {
            creator_id: profile.id,
            product_id: productId,
            release_version: candidate.version,
            request_id: requestId
          }, `candidate-approved:${commandKey}`);
          return send(response, 200, {
            product: approvedProduct,
            candidate
          });
        }

        const offerMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/offer-draft$/);
        if (request.method === "PUT" && offerMatch) {
          const body = await readJson(request);
          requireCapability(profile, "product:edit");
          const productId = decodeURIComponent(offerMatch[1]);
          if (Number(body.amount_minor) > 0 && !isPaidMode(paymentMode)) {
            return send(response, 409, { error: { code: "paid_offers_unavailable", message: "Paid offers stay disabled until an authoritative payment provider is configured." } });
          }
          const commandKey = requireCommandKey(request, body);
          const eventKey = `${commandKey}:offer-revision`;
          const existingEvent = ledger.findByIdempotencyKey(eventKey);
          const current = portalState.getCreatorProduct(profile.id, productId);
          const revision = existingEvent?.revision ?? ((current?.offer_revision ?? 0) + 1);
          const offerId = existingEvent?.offer_id ?? current?.offer_draft?.offer_id ?? stableOfferId(profile.id, productId);
          // Always pass the command through Commerce. The ledger returns the
          // original result for an exact replay and rejects the same key with
          // changed amount/policy instead of silently returning the old offer.
          const offer = await commerce.createOfferRevision({
            ...body,
            offer_id: offerId,
            revision,
            creator_id: profile.id,
            product_id: productId,
            idempotency_key: commandKey
          });
          if (current?.offer_draft?.offer_id === offer.offer_id && current.offer_draft.revision === offer.revision) {
            const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
            await recordTelemetry("offer_saved", {
              creator_id: profile.id,
              product_id: productId,
              offer_id: offer.offer_id,
              offer_revision: offer.revision
            }, `offer-saved:${offer.offer_id}:${offer.revision}`);
            return send(response, 200, { product });
          }
          const savedProduct = await portalState.saveOffer(profile.id, productId, {
            ...body,
            offer_id: offer.offer_id,
            revision: offer.revision
          }, body.expected_version);
          await recordTelemetry("offer_saved", {
            creator_id: profile.id,
            product_id: productId,
            offer_id: offer.offer_id,
            offer_revision: offer.revision,
            request_id: requestId
          }, `offer-saved:${offer.offer_id}:${offer.revision}`);
          return send(response, 200, {
            product: savedProduct
          });
        }

        const previewMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/storefront-preview$/);
        if (request.method === "GET" && previewMatch) {
          requireCapability(profile, "product:read");
          const productId = decodeURIComponent(previewMatch[1]);
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          const state = portalState.getCreatorProduct(profile.id, productId);
          await recordTelemetry("preview_viewed", {
            creator_id: profile.id,
            product_id: productId,
            offer_id: state?.offer_draft?.offer_id,
            offer_revision: state?.offer_draft?.revision,
            release_id: state?.release?.release_id,
            request_id: requestId
          }, `preview-viewed:${requestId}`);
          return send(response, 200, storefrontPreview(product, profile, state, paymentMode));
        }

        const publishMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/publish$/);
        if (request.method === "POST" && publishMatch) {
          const body = await readJson(request);
          requireCapability(profile, "release:publish");
          const commandKey = requireCommandKey(request, body);
          const productId = decodeURIComponent(publishMatch[1]);
          const current = portalState.getCreatorProduct(profile.id, productId);
          if (current) portalState.validatePublishCommand(profile.id, productId, { ...body, command_key: commandKey });
          const replay = !current?.publish_operation
            && current?.status === "published"
            && current.release?.candidate_id === (body.candidate_id ?? current.release?.candidate_id)
            && Number(current.offer_active?.revision) === Number(body.offer_revision ?? current.offer_active?.revision);
          if (replay) {
            await activatePublishedOffer(
              commerce,
              current,
              profile.id,
              productId,
              current.active_deployment_id,
              current.last_publish_operation?.previous_deployment_id ?? null
            );
            if (registryDeploymentServiceToken && current.release?.catalog_snapshot?.agent_id) {
              await activateRegistryDeployment({
                registryUrl,
                fetchImpl,
                registryDeploymentServiceToken,
                creatorId: profile.id,
                operation: {
                  operation_id: current.active_deployment_id,
                  agent_id: current.release.catalog_snapshot.agent_id,
                  release_id: current.release.release_id,
                  previous_corpus_digest: current.release.corpus_digest
                },
                corpusDigest: current.release.corpus_digest
              });
            }
            const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
            await recordTelemetry("publish_succeeded", {
              creator_id: profile.id,
              product_id: productId,
              offer_id: current.offer_active?.offer_id,
              offer_revision: current.offer_active?.revision,
              release_id: current.release?.release_id
            }, `publish-succeeded:${current.release?.release_id}`);
            return send(response, 200, { product, release: current.release, public_url: current.public_url, canonical_url: canonicalPublicUrl(current.public_url) });
          }
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          if (!current?.publish_operation
            && current?.approval?.status === "approved"
            && !approvalMatchesCandidate(current.approval, product.candidate)) {
            await portalState.markCandidateChanged(profile.id, productId, product.candidate, {
              reason: "factory_candidate_changed"
            });
            return send(response, 409, {
              error: {
                code: "candidate_changed",
                message: "The Factory candidate changed. Review it again before publishing."
              }
            });
          }
          const readiness = current?.publish_operation ? { ready: true, blockers: [] } : publishReadiness(product, current, paymentMode);
          if (!readiness.ready) {
            return send(response, 409, {
              error: {
                code: "publish_not_ready",
                message: `Publish is blocked: ${readiness.blockers.join(", ")}.`
              }
            });
          }
          // Persist a publish intent before the external Registry side effect.
          // The intent locks candidate/offer revisions and makes a retry resume
          // the same operation instead of creating another release.
          const pending = await portalState.beginPublishProduct(profile.id, productId, {
            ...body,
            command_key: commandKey,
            agent_id: product.agent_id ?? product.candidate?.agent_id,
            // The merged Factory view exposes the candidate digest as
            // `product.corpus_digest`; it is not a serving pointer. Registry
            // CAS must compare only against Portal's stable live release.
            previous_corpus_digest: current?.release?.corpus_digest ?? null,
            previous_release_id: current?.release?.release_id ?? null
          });
          const operation = pending.publish_operation;
          await recordTelemetry("publish_started", {
            creator_id: profile.id,
            product_id: productId,
            offer_id: operation.offer_id,
            offer_revision: operation.offer_revision,
            request_id: requestId
          }, `publish-started:${operation.operation_id}`);
          const state = await resumePublishDeployment({
            creatorId: profile.id,
            productId,
            state: pending,
            portalState,
            commerce,
            registryUrl,
            fetchImpl,
            registryDeploymentServiceToken,
            creatorBearer: bearerToken(request)
          });
          await recordTelemetry("publish_succeeded", {
            creator_id: profile.id,
            product_id: productId,
            offer_id: state.offer_active?.offer_id,
            offer_revision: state.offer_active?.revision,
            release_id: state.release?.release_id,
            request_id: requestId
          }, `publish-succeeded:${state.release?.release_id}`);
          return send(response, 201, {
            product: creatorProductView(
              state.release?.catalog_snapshot ?? (await creatorProducts()).find((entry) => entry.product_id === productId),
              state
            ),
            release: state.release,
            public_url: state.public_url,
            canonical_url: canonicalPublicUrl(state.public_url)
          });
        }

        const rollbackMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/releases\/([^/]+)\/rollback$/);
        if (request.method === "POST" && rollbackMatch) {
          const body = await readJson(request);
          requireCapability(profile, "release:rollback");
          const commandKey = requireCommandKey(request, body);
          const productId = decodeURIComponent(rollbackMatch[1]);
          const releaseId = decodeURIComponent(rollbackMatch[2]);
          const current = portalState.getCreatorProduct(profile.id, productId);
          if (current) {
            portalState.validateRollbackCommand(
              profile.id,
              productId,
              releaseId,
              body.expected_version,
              { ...body, command_key: commandKey }
            );
          }
          if (!current?.rollback_operation && current?.release?.release_id === releaseId) {
            await activatePublishedOffer(
              commerce,
              current,
              profile.id,
              productId,
              current.active_deployment_id,
              current.last_rollback_operation?.previous_deployment_id
                ?? current.last_publish_operation?.previous_deployment_id
                ?? null
            );
            const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
            if (registryDeploymentServiceToken && product?.agent_id) {
              await activateRegistryDeployment({
                registryUrl,
                fetchImpl,
                registryDeploymentServiceToken,
                creatorId: profile.id,
                operation: {
                  operation_id: current.active_deployment_id,
                  agent_id: product.agent_id,
                  release_id: current.release.release_id,
                  previous_corpus_digest: current.release.corpus_digest
                },
                corpusDigest: current.release.corpus_digest
              });
            }
          return send(response, 200, { product, release: current.release, public_url: current.public_url, canonical_url: canonicalPublicUrl(current.public_url) });
          }
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          if (!product?.agent_id) throw stateError("product_not_found", "Product Agent was not found.", 404);
          const pending = await portalState.beginRollbackProduct(
            profile.id,
            productId,
            releaseId,
            body.expected_version,
            { ...body, command_key: commandKey, agent_id: product.agent_id }
          );
          const state = await resumeRollbackDeployment({
            creatorId: profile.id,
            productId,
            state: pending,
            portalState,
            commerce,
            registryUrl,
            fetchImpl,
            registryDeploymentServiceToken,
            creatorBearer: bearerToken(request)
          });
          const rolledBackProduct = creatorProductView(product, state);
          return send(response, 200, { product: rolledBackProduct, release: state.release, public_url: state.public_url, canonical_url: canonicalPublicUrl(state.public_url) });
        }

        if (request.method === "GET" && url.pathname === "/v1/creator/orders") {
          requireCapability(profile, "commerce:read");
          const filtered = filterCreatorOrders(creatorOrders, url);
          const page = paginate(filtered, url);
          return send(response, 200, { orders: page.items, next_cursor: page.next_cursor });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/orders/export") {
          requireCapability(profile, "commerce:export");
          const rows = filterCreatorOrders(creatorOrders, url).map(creatorOrderExportRow);
          return sendCsv(response, "hatch-creator-orders.csv", rows);
        }
        const creatorOrderMatch = url.pathname.match(/^\/v1\/creator\/orders\/([^/]+)$/);
        if (request.method === "GET" && creatorOrderMatch) {
          requireCapability(profile, "commerce:read");
          const identifier = decodeURIComponent(creatorOrderMatch[1]);
          const order = creatorOrders.find((entry) => entry.order_id === identifier || entry.order_number === identifier);
          if (!order) return send(response, 404, { error: { code: "order_not_found", message: "Order was not found." } });
          return send(response, 200, { order });
        }
        const creatorRefundMatch = url.pathname.match(/^\/v1\/creator\/orders\/([^/]+)\/(?:refund-requests|refund)$/);
        if (request.method === "POST" && creatorRefundMatch) {
          const body = await readJson(request);
          requireCapability(profile, "refund:create");
          const commandKey = requireCommandKey(request, body);
          const identifier = decodeURIComponent(creatorRefundMatch[1]);
          const current = creatorOrders.find((entry) => entry.order_id === identifier || entry.order_number === identifier);
          if (!current || current.creator_id !== profile.id) {
            return send(response, 404, { error: { code: "order_not_found", message: "Order was not found." } });
          }
          const orderId = current.order_id;
          const reason = String(body.reason ?? "").trim();
          if (!reason) throw stateError("audit_reason_required", "Explain why this order is being refunded.", 422);
          const providerRefund = await confirmedProviderRefund(paymentProvider, current, {
            actor_id: profile.id,
            reason,
            idempotency_key: commandKey
          });
          const order = await commerce.refundOrder({
            order_id: orderId,
            actor_id: profile.id,
            reason,
            ...providerRefund
          }, { idempotencyKey: commandKey });
          dispatchCommerceOutbox().catch(() => undefined);
          return send(response, 201, { refund: order.refunds.at(-1), order: orderDetail(order), access_status: "syncing" });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/payouts") {
          requireCapability(profile, "payout:read");
          const currency = normalizedCurrency(url.searchParams.get("currency") ?? "USD");
          return send(response, 200, creatorPayoutView(commerce, profile.id, currency, paymentProvider, payoutSchedule));
        }
        const payoutDetailMatch = url.pathname.match(/^\/v1\/creator\/payouts\/([^/]+)$/);
        if (request.method === "GET" && payoutDetailMatch) {
          requireCapability(profile, "payout:read");
          const payout = commerce.getPayout(decodeURIComponent(payoutDetailMatch[1]));
          if (!payout || payout.creator_id !== profile.id) {
            return send(response, 404, { error: { code: "payout_not_found", message: "Payout was not found." } });
          }
          return send(response, 200, { payout, balance: commerce.getPayoutBalance(profile.id, payout.currency) });
        }
        if (request.method === "POST" && url.pathname === "/v1/creator/payout-account-sessions") {
          const body = await readJson(request);
          requireCapability(profile, "payout:manage");
          const commandKey = requireCommandKey(request, body);
          const currency = normalizedCurrency(body.currency ?? "USD");
          const providerSession = await paymentProvider.createPayoutAccountSession({
            creator_id: profile.id,
            currency,
            return_url: "/studio/payouts",
            idempotency_key: commandKey
          });
          const account = await commerce.updatePayoutAccount({
            creator_id: profile.id,
            currency,
            provider: String(providerSession.provider ?? paymentProvider.provider ?? "configured_provider"),
            provider_account_id: providerSession.account_id,
            status: providerSession.account_status ?? "pending",
            requirements: providerSession.requirements ?? [],
            actor_id: profile.id,
            service_name: "dashboard-bff",
            reason: "creator_payout_onboarding",
            idempotency_key: commandKey
          });
          if (account.status === "active") reconcileCreatorPayout(profile.id, currency).catch(() => undefined);
          return send(response, 201, {
            account,
            session_url: providerSession.session_url,
            expires_at: providerSession.expires_at
          });
        }
        const payoutRetryMatch = url.pathname.match(/^\/v1\/creator\/payouts\/([^/]+)\/retry$/);
        if (request.method === "POST" && payoutRetryMatch) {
          const body = await readJson(request);
          requireCapability(profile, "payout:manage");
          const commandKey = requireCommandKey(request, body);
          const payoutId = decodeURIComponent(payoutRetryMatch[1]);
          const current = commerce.getPayout(payoutId);
          if (!current || current.creator_id !== profile.id) {
            return send(response, 404, { error: { code: "payout_not_found", message: "Payout was not found." } });
          }
          const reason = String(body.reason ?? "").trim();
          if (!reason) throw stateError("audit_reason_required", "Explain why this payout is being retried.", 422);
          const retried = await commerce.retryPayout({
            payout_id: payoutId,
            actor_id: profile.id,
            reason,
            idempotency_key: commandKey
          });
          const payout = await submitReservedPayout(retried, paymentProvider, commerce, commandKey);
          return send(response, 202, { payout });
        }
      }

      if (request.method === "GET" && ["/v1/buyer/entitlements", "/v1/user/entitlements", "/v1/library"].includes(url.pathname)) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const status = url.searchParams.get("status");
        const entitlements = enrichEntitlements(
          commerce.listBuyerEntitlements(authentication.profile.id),
          catalog,
          commerce.listDeliveries({ buyerId: authentication.profile.id })
        ).filter((entitlement) => entitlementMatchesStatus(entitlement, status));
        const page = paginate(entitlements, url);
        return send(response, 200, {
          buyer_id: authentication.profile.id,
          entitlements: page.items,
          next_cursor: page.next_cursor
        });
      }

      const libraryIdMatch = url.pathname.match(/^\/v1\/library\/([^/]+)$/);
      if (request.method === "GET" && libraryIdMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const entitlement = enrichEntitlements(
          commerce.listBuyerEntitlements(authentication.profile.id),
          catalog,
          commerce.listDeliveries({ buyerId: authentication.profile.id })
        ).find((entry) => entry.entitlement_id === decodeURIComponent(libraryIdMatch[1]));
        if (!entitlement) return send(response, 404, { error: { code: "entitlement_not_found", message: "Access record was not found." } });
        return send(response, 200, { entitlement });
      }

      const buyerEntitlementMatch = url.pathname.match(/^\/v1\/(?:buyer|user)\/entitlements\/([^/]+)$/);
      if (request.method === "GET" && buyerEntitlementMatch) {
        const authentication = await authenticate(request, registryUrl, "user", fetchImpl, portalState);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const entitlement = enrichEntitlements(
          commerce.listBuyerEntitlements(authentication.profile.id),
          catalog,
          commerce.listDeliveries({ buyerId: authentication.profile.id })
        ).find((entry) => entry.entitlement_id === decodeURIComponent(buyerEntitlementMatch[1]));
        if (!entitlement) return send(response, 404, { error: { code: "entitlement_not_found", message: "Access record was not found." } });
        return send(response, 200, { entitlement });
      }
      return send(response, 404, { error: { code: "not_found", message: "Route not found." } });
    } catch (error) {
      const failedPublish = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/publish$/);
      if (request.method === "POST" && failedPublish) {
        await recordTelemetry("publish_failed", {
          product_id: decodeURIComponent(failedPublish[1]),
          request_id: requestId,
          error_category: error.code ?? "internal_error"
        }, `publish-failed:${requestId}`);
      }
      const failure = publicRequestError(error);
      return send(response, failure.status, { error: failure.error });
    }
  };

  return {
    handler,
    ledger,
    commerce,
    portalState,
    telemetry,
    reconcilePendingCheckouts,
    dispatchCommerceOutbox,
    reconcilePayouts,
    reconcileFinance,
    reconcileDeployments
  };
}

export async function startDashboardServer(options = {}) {
  const app = await createDashboardApp(options);
  const port = Number(options.port ?? process.env.HATCH_CREATOR_DASHBOARD_API_PORT ?? 8500);
  const host = options.host ?? process.env.HATCH_CREATOR_DASHBOARD_API_HOST ?? "127.0.0.1";
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(port, host, resolve));
  const reconcileTimer = setInterval(() => {
    app.reconcilePendingCheckouts().catch(() => undefined);
  }, 5_000);
  reconcileTimer.unref?.();
  const outboxTimer = setInterval(() => {
    app.dispatchCommerceOutbox().catch(() => undefined);
  }, 2_000);
  outboxTimer.unref?.();
  const financeTimer = setInterval(() => {
    app.reconcileFinance().catch(() => undefined);
  }, 30_000);
  financeTimer.unref?.();
  const deploymentTimer = setInterval(() => {
    app.reconcileDeployments().catch(() => undefined);
  }, 5_000);
  deploymentTimer.unref?.();
  server.once("close", () => {
    clearInterval(reconcileTimer);
    clearInterval(outboxTimer);
    clearInterval(financeTimer);
    clearInterval(deploymentTimer);
    app.ledger.close?.().catch(() => undefined);
    app.portalState.close?.().catch(() => undefined);
    app.telemetry.close?.().catch(() => undefined);
  });
  app.reconcilePendingCheckouts().catch(() => undefined);
  app.dispatchCommerceOutbox().catch(() => undefined);
  app.reconcileFinance().catch(() => undefined);
  app.reconcileDeployments().catch(() => undefined);
  return { ...app, server, port, host };
}

async function registryRequest(registryUrl, pathname, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { fetchImpl: _fetchImpl, ...requestOptions } = options;
  const response = await fetchImpl(new URL(pathname, registryUrl), {
    ...requestOptions,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.detail ?? "Registry rejected the Agent request.");
    error.status = response.status;
    error.code = payload.code ?? "registry_rejected_agent_request";
    if (payload.details !== undefined) error.details = payload.details;
    throw error;
  }
  return payload;
}

async function verifyEntitlementVersionAuthority({
  entitlement,
  body,
  commandKey,
  ledger,
  registryUrl,
  fetchImpl,
  registryDeploymentServiceToken
}) {
  if (!registryDeploymentServiceToken) {
    throw stateError(
      "version_authority_unavailable",
      "Registry version authority is not configured.",
      503
    );
  }
  if (entitlement.version_policy !== "track_current_compatible") {
    throw stateError("version_policy_pinned", "Pinned entitlements cannot advance versions.", 409);
  }
  const fromDigest = requiredVersionAuthorityString(body.from_digest, "from_digest");
  const toDigest = requiredVersionAuthorityString(body.to_digest, "to_digest");
  const fromReleaseId = requiredVersionAuthorityString(body.from_release_id, "from_release_id");
  const toReleaseId = requiredVersionAuthorityString(body.to_release_id, "to_release_id");
  const declarationId = requiredVersionAuthorityString(
    body.compatibility_declaration_id,
    "compatibility_declaration_id"
  );
  if (!CORPUS_DIGEST_PATTERN.test(fromDigest) || !CORPUS_DIGEST_PATTERN.test(toDigest)) {
    throw stateError("invalid_version_digest", "Version digests must be canonical sha256 digests.", 400);
  }
  if (fromDigest === toDigest) {
    throw stateError("version_unchanged", "A version advance requires a different target digest.", 409);
  }
  // Runtime currently identifies immutable releases by their Corpus digests.
  // Requiring the same values prevents a caller from attaching a false human-
  // readable release identity to an otherwise valid compatibility event.
  if (fromReleaseId !== fromDigest || toReleaseId !== toDigest) {
    throw stateError(
      "version_release_identity_invalid",
      "Version release ids must identify the exact immutable Corpus releases.",
      409
    );
  }
  const expectedDeclarationId = `corpus-compatibility:${entitlement.creator_id}:${entitlement.agent_id}:${toDigest}`;
  if (declarationId !== expectedDeclarationId) {
    throw stateError(
      "compatibility_declaration_invalid",
      "The compatibility declaration does not identify the authoritative target release.",
      409
    );
  }
  if (body.reason !== undefined && body.reason !== "compatible_release_published") {
    throw stateError(
      "version_reason_invalid",
      "Only an authoritative compatible-release publication may advance an entitlement version.",
      409
    );
  }

  // Commerce checks the effective digest again while appending. The one
  // exception here is a byte-for-byte replay of an event already committed
  // under this key: Commerce intentionally returns its later projection for
  // that replay, which Runtime uses when another compatible hop won the race.
  const replay = ledger.findByIdempotencyKey(`${commandKey}:version-advance`);
  const sameReplay = replay?.event_type === "entitlement.version_advanced"
    && replay.entitlement_id === entitlement.entitlement_id
    && replay.from_digest === fromDigest
    && replay.to_digest === toDigest
    && replay.from_release_id === fromReleaseId
    && replay.to_release_id === toReleaseId
    && replay.compatibility_declaration_id === declarationId
    && replay.reason === "compatible_release_published";
  if (fromDigest !== entitlement.effective_corpus_digest && !sameReplay) {
    throw stateError(
      "version_chain_broken",
      `from_digest must equal current effective digest ${entitlement.effective_corpus_digest}.`,
      409
    );
  }

  let release;
  try {
    release = await registryRequest(
      registryUrl,
      `/v1/internal/deployments/agent-corpora/${encodeURIComponent(entitlement.creator_id)}/${encodeURIComponent(entitlement.agent_id)}/releases/${encodeURIComponent(toDigest)}`,
      {
        method: "GET",
        fetchImpl,
        headers: { authorization: `Bearer ${registryDeploymentServiceToken}` }
      }
    );
  } catch (error) {
    if (error.status === 404 || error.status === 400) {
      throw stateError(
        "version_release_unavailable",
        "The target Agent Corpus release is not available from Registry authority.",
        409
      );
    }
    throw stateError(
      "version_authority_unavailable",
      "Registry version authority could not verify the target release.",
      503
    );
  }
  if (release.creator_id !== entitlement.creator_id
    || release.agent_id !== entitlement.agent_id
    || release.product_id !== entitlement.product_id
    || release.corpus_digest !== toDigest
    || release.status !== "published") {
    throw stateError(
      "version_release_binding_mismatch",
      "The target release is not bound to this entitlement's Creator, Agent, and product.",
      409
    );
  }
  if (release.backward_compatible_with !== fromDigest) {
    throw stateError(
      "version_lineage_unverified",
      "Registry does not declare the target release directly compatible with the effective release.",
      409
    );
  }
  return {
    from_digest: fromDigest,
    to_digest: toDigest,
    from_release_id: fromReleaseId,
    to_release_id: toReleaseId,
    compatibility_declaration_id: declarationId
  };
}

function requiredVersionAuthorityString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw stateError("invalid_version_authority_request", `${field} is required.`, 400);
  }
  return value.trim();
}

async function authenticate(request, registryUrl, expectedRole, fetchImpl, portalState) {
  const explicitToken = bearerTokenFromAuthorization(request);
  const webSessionId = requestCookies(request).hatch_web_session;
  const webSession = !explicitToken && webSessionId ? portalState?.getWebSession(webSessionId) : undefined;
  const token = explicitToken ?? webSession?.registry_token;
  if (!token) {
    return { error: { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } } } };
  }
  const csrfError = cookieCsrfError(request, webSessionId);
  if (csrfError) return { error: csrfError };
  try {
    const account = await registryRequest(registryUrl, "/v1/auth/me", {
      fetchImpl,
      headers: { authorization: `Bearer ${token}` }
    });
    const profile = publicProfile(account);
    if (expectedRole && profile.role !== expectedRole) {
      return { error: { status: 403, body: { error: { code: `${expectedRole}_only`, message: `This area is for ${expectedRole}s.` } } } };
    }
    request.__registryToken = token;
    return { profile, token };
  } catch {
    return { error: { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } } } };
  }
}

async function optionalBuyer(request, registryUrl, fetchImpl, portalState) {
  if (!bearerTokenFromAuthorization(request) && !requestCookies(request).hatch_web_session) return undefined;
  const authentication = await authenticate(request, registryUrl, undefined, fetchImpl, portalState);
  return authentication.profile?.role === "user" ? authentication.profile : undefined;
}

function publicProfile(profile) {
  const displayName = profile.display_name ?? profile.name ?? "Hatch account";
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "U";
  return {
    id: profile.id,
    role: profile.role,
    display_name: displayName,
    handle: profile.handle ?? `@${profile.id}`,
    initials,
    capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.map(String) : []
  };
}

const ROLE_CAPABILITIES = Object.freeze({
  creator: new Set([
    "product:read",
    "product:edit",
    "release:approve",
    "release:publish",
    "release:rollback",
    "commerce:read",
    "commerce:export",
    "refund:create",
    "payout:read",
    "payout:manage"
  ]),
  user: new Set(["catalog:read", "checkout:create", "order:read", "entitlement:read"])
});

function requireCapability(profile, capability) {
  const explicit = Array.isArray(profile?.capabilities) ? profile.capabilities : [];
  const allowed = explicit.length ? explicit.includes(capability) : ROLE_CAPABILITIES[profile?.role]?.has(capability);
  if (!allowed) throw stateError("capability_required", `The ${capability} capability is required.`, 403);
}

function mergeRegistryAgents(access, catalog) {
  if (!Array.isArray(access) || !Array.isArray(catalog)) return [];
  const catalogByAgent = new Map(catalog.map((entry) => [
    `${entry?.creator_id}:${entry?.product_id ?? entry?.agent_id}`,
    entry
  ]));
  return access.flatMap((grant) => {
    const entry = catalogByAgent.get(`${grant?.creator_id}:${grant?.product_id ?? grant?.agent_id}`);
    if (!entry) return [];
    const {
      agent_id: _agentId,
      creator_slug: _creatorSlug,
      product_slug: _productSlug,
      creator_slug_aliases: _creatorAliases,
      product_slug_aliases: _productAliases,
      ...publicGrant
    } = grant;
    return [{
      ...publicGrant,
      product_id: grant.product_id ?? grant.agent_id,
      creator: { id: entry.creator_id, name: entry.creator_name },
      product: {
        id: entry.product_id,
        name: entry.product_name,
        description: entry.product_description || "Work with this Creator Agent in your own files and context.",
        promise: entry.product_promise || entry.product_description || ""
      },
      presentation: entry.presentation ?? {}
    }];
  });
}

async function recordCheckoutTelemetry(recordTelemetry, outcome, session, requestId) {
  const product = session?.product ?? {};
  const offer = session?.offer_snapshot ?? {};
  const release = session?.release ?? {};
  const attributes = {
    creator_id: product.creator_id,
    product_id: product.product_id,
    offer_id: offer.offer_id,
    offer_revision: offer.revision,
    release_id: release.release_id,
    request_id: requestId
  };
  const checkoutId = session?.checkout_session_id;
  const paymentStatus = outcome?.payment?.status ?? outcome?.status;
  const tasks = [];

  if (outcome?.order_id) {
    tasks.push(recordTelemetry(
      "checkout_confirmed",
      attributes,
      `checkout-confirmed:${checkoutId}`
    ));
  }
  if (paymentStatus === "succeeded") {
    tasks.push(recordTelemetry(
      "payment_succeeded",
      attributes,
      `payment-succeeded:${checkoutId}`
    ));
  } else if (["failed", "cancelled"].includes(paymentStatus)) {
    tasks.push(recordTelemetry(
      "payment_failed",
      { ...attributes, error_category: outcome?.payment?.failure?.code ?? paymentStatus },
      `payment-failed:${checkoutId}:${paymentStatus}`
    ));
  }
  if (outcome?.entitlement_id && outcome?.entitlement?.status !== "revoked") {
    tasks.push(recordTelemetry(
      "entitlement_activated",
      attributes,
      `entitlement-activated:${outcome.entitlement_id}`
    ));
  }
  await Promise.all(tasks);
}

async function confirmCheckoutSession({ session, authentication, registryUrl, fetchImpl, commerce, portalState, paymentMode, paymentProvider, registryAccessServiceToken, commandKey, paymentScenario }) {
  if (session.status === "completed" && session.order_id) {
    const order = commerce.getOrder(session.order_id);
    return { replayed: true, body: checkoutOutcomeBody(session, order, order?.entitlement) };
  }
  if (session.status === "fulfillment_pending" && session.order_id) {
    const order = commerce.getOrder(session.order_id);
    const entitlement = order?.entitlement ?? (session.entitlement_id ? commerce.getEntitlement(session.entitlement_id) : null);
    if (!order || !entitlement) {
      throw stateError("checkout_recovery_failed", "The confirmed order could not be recovered.", 503);
    }
    const completed = await provisionCheckoutAccess({
      session,
      order,
      entitlement,
      registryUrl,
      fetchImpl,
      portalState,
      registryAccessServiceToken
    });
    return { replayed: true, body: checkoutOutcomeBody(completed, order, entitlement) };
  }
  const amountMinor = Number(session.totals?.total_minor ?? session.offer_snapshot?.amount_minor ?? 0);
  if (["payment_pending", "requires_action", "payment_failed"].includes(session.status) && session.payment_id) {
    const payment = commerce.getPayment(session.payment_id);
    if (!payment) throw stateError("payment_recovery_failed", "The payment record could not be recovered.", 503);
    if (payment.status === "succeeded") {
      return finalizeCheckoutOrder({ session, authentication, registryUrl, fetchImpl, commerce, portalState, registryAccessServiceToken, payment });
    }
    return { replayed: true, body: pendingPaymentOutcome(session, payment) };
  }
  if (session.status === "expired" || session.status === "offer_changed" || Date.parse(session.expires_at) <= Date.now()) {
    throw stateError("checkout_expired", "Checkout session has expired. Review the current offer again.", 409);
  }
  if (session.status !== "open") {
    throw stateError("checkout_not_confirmable", "Checkout session cannot be confirmed in its current state.", 409);
  }
  if (!registryAccessServiceToken) {
    throw stateError("access_service_unavailable", "Registry access provisioning is not configured.", 503);
  }
  if (amountMinor > 0 && !isPaidMode(paymentMode)) {
    throw stateError(
      "payment_provider_unavailable",
      "Paid checkout is not enabled. Choose a free offer or configure a payment provider.",
      409
    );
  }
  const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
  const currentAgent = findCatalogAgent(catalog, session.product.creator_id, session.product.product_id);
  const currentState = currentAgent
    ? portalState.getCreatorProduct(currentAgent.creator_id, currentAgent.product_id)
    : undefined;
  const currentProduct = currentAgent
    ? publicCatalogAgent(
      currentAgent,
      currentState,
      paymentMode,
      await authoritativeProductOffer(commerce, currentAgent, currentState)
    )
    : null;
  if (!checkoutQuoteIsCurrent(session, currentProduct)) {
    const changed = await portalState.markCheckoutQuoteChanged(session.checkout_session_id, currentProduct);
    throw stateError(
      "offer_changed",
      "The active offer or release changed. Review the latest product before confirming.",
      409,
      changed.quote_change
    );
  }
  if (amountMinor > 0) {
    const paymentId = stablePaymentId(session.checkout_session_id);
    const providerResult = await paymentProvider.createPayment({
      payment_id: paymentId,
      checkout_session_id: session.checkout_session_id,
      buyer_id: authentication.profile.id,
      creator_id: session.product.creator_id,
      product_id: session.product.product_id,
      amount_minor: amountMinor,
      currency: session.totals?.currency ?? session.offer_snapshot.currency,
      return_url: `/checkout/${encodeURIComponent(session.checkout_session_id)}`,
      idempotency_key: `checkout:${session.checkout_session_id}:provider-payment`,
      ...(paymentMode === "sandbox" && paymentScenario ? { scenario: paymentScenario } : {})
    });
    const provider = String(providerResult.provider ?? paymentProvider.provider ?? "configured_provider");
    const createdPayment = await commerce.createPayment({
      payment_id: paymentId,
      checkout_session_id: session.checkout_session_id,
      buyer_id: authentication.profile.id,
      creator_id: session.product.creator_id,
      product_id: session.product.product_id,
      amount_minor: amountMinor,
      currency: session.totals?.currency ?? session.offer_snapshot.currency,
      provider,
      provider_payment_id: providerResult.provider_payment_id,
      actor_id: authentication.profile.id,
      service_name: "dashboard-bff",
      request_id: commandKey,
      idempotency_key: `checkout:${session.checkout_session_id}:payment`
    });
    // A provider's create-intent response is not settlement authority. In
    // production provider mode, a synchronous `succeeded` response remains
    // pending until the separately signed webhook is durably ingested. The
    // sandbox keeps its direct-success path for deterministic local UAT.
    const recorded = paymentMode === "provider" && providerResult.status === "succeeded"
      ? { payment: createdPayment, applied: false }
      : await commerce.recordPaymentProviderEvent({
        payment_id: paymentId,
        provider,
        provider_event_id: String(providerResult.provider_event_id),
        provider_payment_id: providerResult.provider_payment_id,
        provider_sequence: providerResult.provider_sequence,
        provider_occurred_at: providerResult.provider_occurred_at,
        status: providerResult.status,
        next_action: providerResult.redirect_url ? { redirect_url: providerResult.redirect_url } : providerResult.next_action,
        failure_code: providerResult.failure_code,
        failure_message: providerFailureMessage(providerResult.failure_code, providerResult.status, "payment"),
        actor_id: provider,
        service_name: "payment-provider"
      });
    const paymentSession = await portalState.markCheckoutPayment(session.checkout_session_id, {
      payment_id: paymentId,
      provider,
      status: recorded.payment.status,
      redirect_url: providerResult.redirect_url ?? recorded.payment.next_action?.redirect_url
    });
    if (recorded.payment.status !== "succeeded") {
      return { replayed: false, body: pendingPaymentOutcome(paymentSession, recorded.payment) };
    }
    return finalizeCheckoutOrder({
      session: paymentSession,
      authentication,
      registryUrl,
      fetchImpl,
      commerce,
      portalState,
      registryAccessServiceToken,
      payment: recorded.payment
    });
  }
  return finalizeCheckoutOrder({
    session,
    authentication,
    registryUrl,
    fetchImpl,
    commerce,
    portalState,
    registryAccessServiceToken,
    payment: null
  });
}

async function finalizeCheckoutOrder({ session, authentication, registryUrl, fetchImpl, commerce, portalState, registryAccessServiceToken, payment, transaction: committedTransaction }) {
  const amountMinor = Number(session.totals?.total_minor ?? session.offer_snapshot?.amount_minor ?? 0);
  const paymentStatus = amountMinor === 0 ? "not_required" : "paid";
  const paymentId = payment?.payment_id ?? null;
  const transaction = committedTransaction ?? await commerce.confirmCheckout(
    checkoutCommerceInput(session, authentication, payment)
  );
  const { order, entitlement } = transaction;
  const pending = await portalState.markCheckoutFulfillmentPending(session.checkout_session_id, {
    order_id: order.order_id,
    entitlement_id: entitlement.entitlement_id,
    payment_status: paymentStatus
  });
  const completed = await provisionCheckoutAccess({
    session: pending,
    order,
    entitlement,
    registryUrl,
    fetchImpl,
    portalState,
    registryAccessServiceToken
  });
  return {
    replayed: false,
    body: checkoutOutcomeBody(completed, order, entitlement, {
      payment_id: paymentId,
      status: amountMinor === 0 ? "not_required" : "succeeded",
      amount_minor: amountMinor,
      currency: order.currency,
      mode: amountMinor > 0 ? payment?.provider ?? "provider" : "not_required",
      provider_payment_id: payment?.provider_payment_id ?? null
    })
  };
}

function checkoutCommerceInput(session, authentication, payment) {
  const amountMinor = Number(session.totals?.total_minor ?? session.offer_snapshot?.amount_minor ?? 0);
  const paymentStatus = amountMinor === 0 ? "not_required" : "paid";
  const paymentId = payment?.payment_id ?? null;
  const product = session.product;
  return {
    buyer_id: authentication.profile.id,
    buyer_display_name: authentication.profile.display_name,
    creator_id: product.creator_id,
    creator_display_name: product.creator_name,
    // `agent_id` is an internal Commerce compatibility alias only. It never
    // crosses the public product response boundary.
    agent_id: product.agent_id ?? product.product_id,
    product_id: product.product_id,
    product_name: product.product_name,
    creator_snapshot: session.creator,
    product_snapshot: {
      product_id: product.product_id,
      product_name: product.product_name,
      promise: product.promise,
      description: product.description
    },
    release_snapshot: session.release,
    offer_snapshot: session.offer_snapshot,
    corpus_digest: session.release?.corpus_digest ?? product.corpus_digest,
    release_id: session.release?.release_id ?? product.corpus_digest,
    offer_id: session.offer_snapshot.offer_id,
    offer_revision: session.offer_snapshot.revision ?? 1,
    subtotal_minor: Number(session.totals?.subtotal_minor ?? amountMinor),
    discount_minor: Number(session.totals?.discount_minor ?? 0),
    tax_minor: session.totals?.tax_minor == null ? null : Number(session.totals.tax_minor),
    total_minor: Number(session.totals?.total_minor ?? amountMinor),
    purchase_model: session.offer_snapshot.purchase_model ?? session.offer_snapshot.model ?? "per_delivery",
    included_units: session.entitlement_scope?.included_units ?? 1,
    gross_minor: amountMinor,
    currency: session.totals?.currency ?? session.offer_snapshot.currency,
    payment_status: paymentStatus,
    ...(paymentId ? { payment_id: paymentId } : {}),
    refund_policy_version: session.offer_snapshot.refund_policy_version,
    version_policy: session.entitlement_scope?.version_policy ?? "pinned",
    idempotency_key: `checkout:${session.checkout_session_id}:confirm`
  };
}

function pendingPaymentOutcome(session, payment) {
  return {
    checkout_session: session,
    checkout_session_id: session.checkout_session_id,
    status: payment.status,
    order_id: null,
    entitlement_id: null,
    redirect_url: session.payment_redirect_url ?? payment.next_action?.redirect_url ?? null,
    payment
  };
}

function stableFactoryDraftId(creatorId, commandKey) {
  return `draft_${createHash("sha256").update(`${creatorId}\0${commandKey}`).digest("hex").slice(0, 24)}`;
}

function stablePaymentId(checkoutSessionId) {
  return stableAuthorityUuid(`payment:${checkoutSessionId}`);
}

function creatorPayoutView(commerce, creatorId, currency, provider, payoutSchedule) {
  const account = commerce.getPayoutAccount(creatorId, currency);
  const balance = commerce.getPayoutBalance(creatorId, currency);
  const connected = account.status === "active";
  return {
    account_status: account.status,
    setup_status: !provider.configured ? "unavailable" : connected ? "complete" : "required",
    balance_status: connected ? "available" : "unavailable",
    setup_available: provider.configured,
    account_action_url: null,
    available_minor: connected ? balance.available_minor : null,
    pending_minor: connected ? balance.pending_minor : null,
    in_transit_minor: connected ? balance.in_transit_minor : null,
    paid_minor: connected ? balance.paid_minor : null,
    adjustments_minor: connected ? balance.adjustments_minor : null,
    reserved_minor: connected ? balance.reserved_minor : null,
    recognized_minor: connected ? balance.recognized_minor : null,
    reversed_minor: connected ? balance.reversed_minor : null,
    currency,
    payout_schedule: payoutSchedule,
    next_payout_at: null,
    payouts: balance.payouts,
    account
  };
}

async function submitReservedPayout(payout, provider, commerce, idempotencyKey) {
  const providerPayoutId = `provider_payout_${createHash("sha256").update(`${payout.payout_id}\0${payout.attempt}`).digest("hex").slice(0, 24)}`;
  const submitted = await commerce.submitPayout({
    payout_id: payout.payout_id,
    provider_payout_id: providerPayoutId,
    actor_id: "payout-reconciler",
    service_name: "dashboard-bff",
    idempotency_key: `${idempotencyKey}:submit`
  });
  try {
    const result = await provider.createPayout({
      payout_id: submitted.payout_id,
      batch_id: submitted.batch_id,
      creator_id: submitted.creator_id,
      provider_account_id: submitted.provider_account_id,
      provider_payout_id: providerPayoutId,
      amount_minor: submitted.amount_minor,
      currency: submitted.currency,
      attempt: submitted.attempt,
      idempotency_key: `${idempotencyKey}:provider`
    });
    if (result.provider_payout_id && result.provider_payout_id !== providerPayoutId) {
      throw stateError("payout_provider_identity_mismatch", "Payout provider returned a different attempt identity.", 502);
    }
    return commerce.recordPayoutProviderEvent({
      payout_id: submitted.payout_id,
      provider: submitted.provider,
      provider_payout_id: providerPayoutId,
      provider_event_id: String(result.provider_event_id),
      status: result.status === "paid" ? "paid" : result.status === "failed" ? "failed" : "in_transit",
      provider_occurred_at: result.provider_occurred_at,
      failure_code: result.failure_code,
      failure_message: providerFailureMessage(result.failure_code, result.status, "payout"),
      actor_id: submitted.provider,
      service_name: "payout-provider"
    });
  } catch (error) {
    await commerce.recordPayoutProviderEvent({
      payout_id: submitted.payout_id,
      provider: submitted.provider,
      provider_payout_id: providerPayoutId,
      provider_event_id: `provider-failure:${providerPayoutId}`,
      status: "failed",
      failure_code: error.code ?? "provider_temporarily_unavailable",
      failure_message: providerFailureMessage(error.code, "failed", "payout"),
      actor_id: submitted.provider,
      service_name: "payout-provider"
    });
    throw error;
  }
}

function providerFailureMessage(code, status, kind) {
  if (!new Set(["failed", "cancelled"]).has(String(status ?? "").toLowerCase())) return undefined;
  const category = String(code ?? "").toLowerCase();
  if (kind === "payment") {
    if (category.includes("declin")) return "The payment was declined. Use another payment method.";
    if (category.includes("cancel")) return "The payment was cancelled.";
    return "The payment provider could not complete this payment.";
  }
  if (category.includes("account") || category.includes("kyc")) {
    return "The payout account needs attention before another transfer can be submitted.";
  }
  return "The payout provider could not complete this transfer.";
}

function normalizedCurrency(value) {
  const currency = String(value ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw stateError("invalid_currency", "Currency must be a three-letter ISO code.", 400);
  return currency;
}

function entitlementAuthorization(entitlement) {
  const authorized = entitlement.status === "active" && Number(entitlement.remaining_units ?? 0) > 0;
  return {
    authorized,
    reason: authorized
      ? "authorized"
      : entitlement.status === "active"
        ? "units_exhausted"
        : `entitlement_${entitlement.status}`,
    entitlement_id: entitlement.entitlement_id,
    order_id: entitlement.order_id,
    order_line_id: entitlement.order_line_id,
    buyer_id: entitlement.buyer_id,
    creator_id: entitlement.creator_id,
    agent_id: entitlement.agent_id,
    product_id: entitlement.product_id,
    purchased_release_id: entitlement.purchased_release_id ?? entitlement.release_id,
    purchased_corpus_digest: entitlement.purchased_corpus_digest ?? entitlement.corpus_digest,
    effective_corpus_digest: entitlement.effective_corpus_digest ?? entitlement.corpus_digest,
    version_policy: entitlement.version_policy,
    valid_from: entitlement.valid_from,
    valid_until: entitlement.valid_until ?? null,
    remaining_units: entitlement.remaining_units,
    status: entitlement.status
  };
}

async function confirmedProviderRefund(paymentProvider, order, input) {
  if (Number(order.gross_minor) === 0) return {};
  const refundId = `refund_${createHash("sha256").update(`provider-refund\0${order.order_id}\0${input.idempotency_key}`).digest("hex").slice(0, 24)}`;
  const result = await paymentProvider.refundPayment({
    refund_id: refundId,
    order_id: order.order_id,
    payment_id: order.payment_id,
    provider_payment_id: order.payment?.provider_payment_id,
    amount_minor: order.gross_minor,
    currency: order.currency,
    reason: input.reason,
    actor_id: input.actor_id,
    idempotency_key: input.idempotency_key
  });
  if (result.status !== "succeeded" || !result.provider_refund_id) {
    throw stateError("provider_refund_not_confirmed", "The payment provider has not confirmed this refund.", 409);
  }
  return {
    refund_id: refundId,
    provider_refund_id: result.provider_refund_id,
    provider_refund_status: "succeeded"
  };
}

async function provisionCheckoutAccess({ session, order, entitlement, registryUrl, fetchImpl, portalState, registryAccessServiceToken }) {
  if (!registryAccessServiceToken) {
    throw stateError("access_service_unavailable", "Registry access provisioning is not configured.", 503);
  }
  const product = session.product;
  const purchasedCorpusDigest = session.release?.corpus_digest ?? entitlement.corpus_digest ?? order.corpus_digest;
  const grant = await registryRequest(
    registryUrl,
    `/v1/user/products/${encodeURIComponent(product.product_id)}/access`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: session.buyer_id,
        creator_id: product.creator_id,
        order_id: order.order_id,
        entitlement_id: entitlement.entitlement_id,
        purchased_corpus_digest: purchasedCorpusDigest,
        version_policy: entitlement.version_policy ?? session.entitlement_scope?.version_policy ?? "pinned"
      }),
      fetchImpl,
      headers: { authorization: `Bearer ${registryAccessServiceToken}` }
    }
  );
  if (grant.entitlement_id !== entitlement.entitlement_id
    || (grant.purchased_corpus_digest && grant.purchased_corpus_digest !== purchasedCorpusDigest)) {
    throw stateError("entitlement_provisioning_mismatch", "Registry access did not bind the confirmed entitlement and release.", 502);
  }
  return portalState.completeCheckout(session.checkout_session_id, {
    order_id: order.order_id,
    entitlement_id: entitlement.entitlement_id,
    payment_status: order.payment_status
  });
}

async function resumePublishDeployment({
  creatorId,
  productId,
  state,
  portalState,
  commerce,
  registryUrl,
  fetchImpl,
  registryDeploymentServiceToken,
  creatorBearer
}) {
  let current = state;
  let operation = current?.publish_operation;
  if (!operation) return current;
  if (!operation.catalog_snapshot) {
    let response;
    try {
      response = registryDeploymentServiceToken
        ? await registryRequest(
            registryUrl,
            `/v1/internal/deployments/factory-runs/${encodeURIComponent(operation.candidate_id)}/stage`,
            {
              method: "POST",
              body: JSON.stringify({
                creator_id: creatorId,
                operation_id: operation.operation_id,
                corpus_digest: operation.candidate_digest
              }),
              fetchImpl,
              headers: { authorization: `Bearer ${registryDeploymentServiceToken}` }
            }
          )
        : await registryRequest(
            registryUrl,
            `/v1/creator/factory-runs/${encodeURIComponent(operation.candidate_id)}/publish`,
            {
              method: "POST",
              body: JSON.stringify({
                corpus_digest: operation.candidate_digest,
                publish_operation_id: operation.operation_id,
                activate: false
              }),
              fetchImpl,
              headers: { authorization: `Bearer ${creatorBearer}` }
            }
          );
    } catch (error) {
      if (error.code === "candidate_changed") {
        await portalState.abandonUnmaterializedPublish(creatorId, productId, operation.operation_id, "factory_candidate_changed");
      }
      throw error;
    }
    const staged = response.agent_corpus ?? response;
    if (staged.creator_id !== creatorId
      || staged.product_id !== productId
      || staged.corpus_digest !== operation.candidate_digest
      || (operation.agent_id && staged.agent_id !== operation.agent_id)) {
      throw stateError("deployment_target_mismatch", "Registry materialized a different release than the approved deployment.", 409);
    }
    const snapshot = publicAgentSnapshot(staged);
    current = await portalState.markPublishMaterialized(creatorId, productId, operation.operation_id, snapshot);
    operation = current.publish_operation;
    // A legacy Registry implementation publishes and activates in one call.
    // Production always configures the deployment token and uses stage-only.
    if (!registryDeploymentServiceToken && response.current !== false) {
      current = await portalState.markPublishRegistryActivated(creatorId, productId, operation.operation_id);
      operation = current.publish_operation;
    }
  }
  if (!operation.offer_activated_at) {
    const activeOffer = await activatePublishedOffer(commerce, {
      offer_active: operation.offer_snapshot,
      release: {
        release_id: operation.release_id,
        corpus_digest: operation.candidate_digest
      }
    }, creatorId, productId, operation.operation_id, operation.previous_deployment_id ?? null);
    if (activeOffer.operation_id !== operation.operation_id
      || activeOffer.release_id !== operation.release_id
      || activeOffer.corpus_digest !== operation.candidate_digest) {
      throw stateError("deployment_target_mismatch", "Commerce activated a different deployment tuple.", 409);
    }
    current = await portalState.markPublishOfferActivated(creatorId, productId, operation.operation_id);
    operation = current.publish_operation;
  }
  if (!operation.registry_activated_at) {
    await activateRegistryDeployment({
      registryUrl,
      fetchImpl,
      registryDeploymentServiceToken,
      creatorBearer,
      creatorId,
      operation,
      corpusDigest: operation.candidate_digest
    });
    current = await portalState.markPublishRegistryActivated(creatorId, productId, operation.operation_id);
    operation = current.publish_operation;
  }
  return portalState.commitPublishProduct(creatorId, productId, operation.operation_id);
}

async function resumeRollbackDeployment({
  creatorId,
  productId,
  state,
  portalState,
  commerce,
  registryUrl,
  fetchImpl,
  registryDeploymentServiceToken,
  creatorBearer
}) {
  let current = state;
  let operation = current?.rollback_operation;
  if (!operation) return current;
  if (!operation.offer_activated_at) {
    const activeOffer = await activatePublishedOffer(commerce, {
      offer_active: operation.offer_snapshot,
      release: {
        release_id: operation.release_id,
        corpus_digest: operation.corpus_digest
      }
    }, creatorId, productId, operation.operation_id, operation.previous_deployment_id ?? null);
    if (activeOffer.operation_id !== operation.operation_id
      || activeOffer.release_id !== operation.release_id
      || activeOffer.corpus_digest !== operation.corpus_digest) {
      throw stateError("deployment_target_mismatch", "Commerce activated a different rollback tuple.", 409);
    }
    current = await portalState.markRollbackOfferActivated(creatorId, productId, operation.operation_id);
    operation = current.rollback_operation;
  }
  if (!operation.registry_activated_at) {
    await activateRegistryDeployment({
      registryUrl,
      fetchImpl,
      registryDeploymentServiceToken,
      creatorBearer,
      creatorId,
      operation,
      corpusDigest: operation.corpus_digest
    });
    current = await portalState.markRollbackRegistryActivated(creatorId, productId, operation.operation_id);
    operation = current.rollback_operation;
  }
  return portalState.commitRollbackProduct(creatorId, productId, operation.operation_id);
}

async function activateRegistryDeployment({
  registryUrl,
  fetchImpl,
  registryDeploymentServiceToken,
  creatorBearer,
  creatorId,
  operation,
  corpusDigest
}) {
  if (!operation.agent_id) throw stateError("deployment_agent_missing", "The deployment is not bound to an Agent.", 409);
  const body = JSON.stringify({
    creator_id: creatorId,
    operation_id: operation.operation_id,
    expected_current_digest: operation.previous_corpus_digest ?? null,
    release_id: operation.release_id
  });
  const response = registryDeploymentServiceToken
    ? await registryRequest(
        registryUrl,
        `/v1/internal/deployments/agent-corpora/${encodeURIComponent(operation.agent_id)}/releases/${encodeURIComponent(corpusDigest)}/activate`,
        {
          method: "POST",
          body,
          fetchImpl,
          headers: { authorization: `Bearer ${registryDeploymentServiceToken}` }
        }
      )
    : await registryRequest(
        registryUrl,
        `/v1/creator/agent-corpora/${encodeURIComponent(operation.agent_id)}/releases/${encodeURIComponent(corpusDigest)}/activate`,
        {
          method: "POST",
          body,
          fetchImpl,
          headers: { authorization: `Bearer ${creatorBearer}` }
        }
      );
  const activated = response.agent_corpus ?? response;
  if (activated.corpus_digest !== corpusDigest) {
    throw stateError("deployment_target_mismatch", "Registry activated a different Corpus release.", 502);
  }
  return activated;
}

async function activatePublishedOffer(
  commerce,
  state,
  creatorId,
  productId,
  operationId = state?.active_deployment_id,
  expectedPreviousOperationId
) {
  const offer = state?.offer_active;
  if (!offer?.offer_id || !Number.isSafeInteger(Number(offer.revision))) {
    throw stateError("offer_required", "A versioned offer is required before publication.", 409);
  }
  const revision = Number(offer.revision);
  const revisionKey = `offer:${creatorId}:${productId}:${revision}`;
  if (!commerce.getOfferRevision(offer.offer_id, revision)) {
    await commerce.createOfferRevision({
      ...offer,
      creator_id: creatorId,
      product_id: productId,
      idempotency_key: `${revisionKey}:migration`
    });
  }
  return commerce.activateOfferRevision({
    offer_id: offer.offer_id,
    revision,
    creator_id: creatorId,
    product_id: productId,
    release_id: state.release?.release_id,
    corpus_digest: state.release?.corpus_digest,
    operation_id: operationId ?? `migration:${state.release?.release_id ?? revision}`,
    ...(expectedPreviousOperationId === undefined
      ? {}
      : { expected_previous_operation_id: expectedPreviousOperationId }),
    idempotency_key: `deployment:${operationId ?? `migration:${state.release?.release_id ?? revision}`}`
  });
}

async function authoritativeProductOffer(commerce, agent, creatorState) {
  const active = commerce.getActiveOffer(agent.creator_id, agent.product_id);
  if (creatorState) {
    const committedReleaseId = creatorState.release?.release_id ?? creatorState.release?.corpus_digest;
    // A product that is still in a pending first publish has no committed
    // public tuple. Do not leak an offer that Commerce activated before the
    // Registry pointer/Portal state commit.
    if (!committedReleaseId) return null;
    const activeReleaseId = active?.release_id ?? active?.corpus_digest;
    if (active && String(activeReleaseId ?? "") === String(committedReleaseId)) return active;
    // During a deployment retry Commerce may briefly contain the next offer
    // while the public pointer still serves the previous immutable release.
    // Keep the last committed snapshot visible until the saga converges.
    return normalizeOffer(creatorState.offer_active, agent);
  }
  if (active) return active;

  // Registry manifests predating Commerce V2 carried the initial offer next
  // to the Corpus. Migrate that tuple exactly once before it is shown or
  // quoted. From this point on Registry changes cannot silently replace the
  // Commerce-owned revision; a Creator must publish a new deployment.
  const legacy = normalizeOffer(agent.product_offer, agent);
  const corpusDigest = String(agent.corpus_digest ?? "").trim();
  if (!legacy || legacy.status !== "active" || !corpusDigest) return null;
  const operationId = `legacy-registry:${corpusDigest}:${legacy.offer_id}:${legacy.revision}`;
  await activatePublishedOffer(commerce, {
    offer_active: legacy,
    release: {
      release_id: corpusDigest,
      corpus_digest: corpusDigest
    },
    active_deployment_id: operationId
  }, agent.creator_id, agent.product_id, operationId);
  return commerce.getActiveOffer(agent.creator_id, agent.product_id);
}

function checkoutOutcomeBody(session, order, entitlement, payment) {
  const entitlementId = entitlement?.entitlement_id ?? session.entitlement_id ?? order?.entitlement_id ?? null;
  return {
    order_id: order?.order_id ?? session.order_id,
    status: order?.status ?? (session.status === "completed" ? "fulfilled" : session.status),
    entitlement_id: entitlementId,
    redirect_url: order?.order_id ? `/orders/${encodeURIComponent(orderNumberFor(order))}/success` : null,
    order: order ?? null,
    payment: payment ?? {
      payment_id: null,
      status: session.payment_status ?? order?.payment_status ?? "not_required",
      amount_minor: order?.gross_minor ?? session.totals?.total_minor ?? 0,
      currency: order?.currency ?? session.totals?.currency ?? "USD"
    },
    entitlement: entitlement ?? (entitlementId ? { entitlement_id: entitlementId, status: "active" } : null)
  };
}

async function authoritativeCatalog(registryUrl, fetchImpl, portalState) {
  const registryCatalog = await registryRequest(registryUrl, "/v1/public/products", { fetchImpl });
  const byProduct = new Map((Array.isArray(registryCatalog) ? registryCatalog : []).map((product) => {
    const agent = { ...product, agent_id: product.product_id };
    return [`${agent.creator_id}:${agent.product_id}`, agent];
  }));
  // Portal only changes its stable release after both Commerce and Registry
  // have acknowledged the same deployment operation. A captured immutable
  // snapshot therefore prevents a pending or repaired Registry pointer from
  // being mixed with the previous Portal/Offer tuple.
  for (const state of portalState.listCreatorProducts()) {
    const snapshot = state?.release?.catalog_snapshot;
    if (!snapshot?.creator_id || !snapshot?.product_id) continue;
    byProduct.set(`${snapshot.creator_id}:${snapshot.product_id}`, snapshot);
  }
  return [...byProduct.values()];
}

function publicAgentSnapshot(product) {
  return {
    creator_id: product.creator_id,
    creator_name: product.creator_name ?? product.creator_display_name ?? product.creator_id,
    product_id: product.product_id,
    product_name: product.product_name ?? product.name,
    product_description: product.product_description ?? product.description ?? "",
    product_promise: product.product_promise ?? product.promise ?? "",
    product_boundaries: [...(product.product_boundaries ?? product.boundaries ?? [])],
    presentation: structuredClone(product.presentation ?? {}),
    corpus_digest: product.corpus_digest,
    published_at: product.published_at ?? null,
    status: "published"
  };
}

function canonicalPublicUrl(value) {
  const text = String(value ?? "");
  const match = text.match(/^\/products\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match ? `/products/${match[1].toLowerCase()}` : (text || undefined);
}

function publicCatalogAgent(agent, creatorState, paymentMode = "disabled", commerceOffer) {
  // Once a product enters the V2 workflow, only the Commerce activation is
  // authoritative. Registry product_offer remains a legacy migration seed.
  const deployedAgent = creatorState?.release?.catalog_snapshot ?? agent;
  // A published Portal state carries the workflow snapshot, but Commerce is
  // the authority for the active offer revision. Only fall back to the state
  // or legacy Registry offer while migrating an unpublished/legacy tuple.
  const offer = commerceOffer
    ?? (creatorState ? normalizeOffer(creatorState.offer_active, deployedAgent) : normalizeOffer(deployedAgent.product_offer, deployedAgent));
  const withdrawn = creatorState?.status === "withdrawn";
  const checkoutAvailable = Boolean(!withdrawn && offer && (offer.amount_minor === 0 || isPaidMode(paymentMode)));
  const {
    agent_id: _agentId,
    creator_slug: _creatorSlug,
    product_slug: _productSlug,
    creator_slug_aliases: _creatorAliases,
    product_slug_aliases: _productAliases,
    ...authorityAgent
  } = deployedAgent;
  return {
    ...authorityAgent,
    creator: { id: authorityAgent.creator_id, name: authorityAgent.creator_name ?? authorityAgent.creator_display_name ?? authorityAgent.creator_id },
    product: { id: authorityAgent.product_id, name: authorityAgent.product_name ?? authorityAgent.name ?? authorityAgent.product_id },
    promise: deployedAgent.product_promise ?? deployedAgent.product_description ?? "",
    description: deployedAgent.product_description ?? "",
    boundaries: deployedAgent.product_boundaries ?? [],
    availability: withdrawn ? "withdrawn" : checkoutAvailable ? "published" : "not_for_sale",
    available: checkoutAvailable,
    offer,
    ...(offer ? { product_offer: offer } : {}),
    release_id: creatorState?.release?.release_id ?? deployedAgent.corpus_digest,
    public_url: `/products/${encodeURIComponent(deployedAgent.product_id)}`
  };
}

function checkoutQuoteIsCurrent(session, product) {
  if (!product || product.availability !== "published" || !product.offer) return false;
  const quoted = session.offer_snapshot ?? {};
  return String(product.offer.offer_id) === String(quoted.offer_id)
    && Number(product.offer.revision ?? 1) === Number(quoted.revision ?? 1)
    && Number(product.offer.amount_minor) === Number(quoted.amount_minor)
    && String(product.offer.currency) === String(quoted.currency)
    && String(product.release_id ?? product.corpus_digest) === String(session.release?.release_id ?? session.release?.corpus_digest);
}

function checkoutSessionMatchesSelector(session, creatorId, productId) {
  return String(session?.product?.creator_id) === String(creatorId)
    && String(session?.product?.product_id) === String(productId);
}

function withBuyerAccess(product, entitlements) {
  const entitlement = entitlements.find((entry) => (
    entry.creator_id === product.creator_id
    && entry.product_id === product.product_id
    && entry.status === "active"
    && (entry.remaining_units > 0 || entry.reserved_units > 0)
  ));
  return entitlement ? { ...product, entitlement } : product;
}

function normalizeOffer(value, agent = {}) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(Number(value.amount_minor)) || Number(value.amount_minor) < 0) {
    return null;
  }
  const model = value.purchase_model ?? value.model ?? "per_delivery";
  return {
    offer_id: value.offer_id ?? stableOfferId(agent.creator_id ?? "creator", agent.product_id ?? "product"),
    revision: Number.isSafeInteger(Number(value.revision)) ? Number(value.revision) : 1,
    purchase_model: model,
    model,
    amount_minor: Number(value.amount_minor),
    currency: String(value.currency ?? "USD").toUpperCase(),
    unit: value.unit ?? "delivery",
    included_units: Number.isSafeInteger(Number(value.included_units)) ? Number(value.included_units) : 1,
    refund_policy_version: value.refund_policy_version ?? "v1",
    version_policy: value.version_policy === "track_current_compatible" ? "track_current_compatible" : "pinned",
    status: value.status ?? "active"
  };
}

function findCatalogAgent(catalog, creatorSelector, productSelector) {
  return (Array.isArray(catalog) ? catalog : []).find((entry) => (
    (!creatorSelector || String(entry.creator_id) === String(creatorSelector))
    && (!productSelector || String(entry.product_id) === String(productSelector))
  ));
}

function selectorMatches(value, candidates) {
  return candidates.some((candidate) => String(candidate) === String(value));
}

function selectorValues(entry, kind) {
  return [kind === "creator" ? entry?.creator_id : entry?.product_id].filter(Boolean).map(String);
}

function publicProductPath(agent) {
  return `/products/${encodeURIComponent(agent?.product_id)}`;
}

function creatorProductViews(agents, runs, states, creatorId) {
  const stateByProduct = new Map(states.map((state) => [state.product_id, state]));
  const runByProduct = new Map(runs
    .filter((run) => run?.product?.id)
    .map((run) => [run.product.id, run]));
  const products = agents.map((agent) => {
    const run = runByProduct.get(agent.product_id);
    return creatorProductView(agent, stateByProduct.get(agent.product_id), run);
  });
  const existing = new Set(products.map((product) => product.product_id));
  for (const run of runs) {
    if (!run?.product?.id || existing.has(run.product.id)) continue;
    products.push(creatorProductView({
      creator_id: creatorId,
      // Internal Registry/Portal alias; public URLs and response identity use product_id.
      agent_id: run.product.id,
      product_id: run.product.id,
      product_name: run.product.name,
      product_description: run.product.description,
      product_promise: run.product.promise,
      product_boundaries: run.product.boundaries,
      corpus_digest: run.candidate?.corpus_digest ?? run.candidate?.system_digest,
      status: run.status === "ready" ? "candidate_ready" : "preparing"
    }, stateByProduct.get(run.product.id), run));
  }
  return products.sort((left, right) => String(right.updated_at ?? right.published_at ?? "").localeCompare(String(left.updated_at ?? left.published_at ?? "")));
}

function creatorProductView(agent, state, run) {
  if (!agent) return null;
  const base = agent.name ? agent : catalogAgentToProduct(agent);
  const offer = state?.offer_draft ?? normalizeOffer(agent.product_offer, agent) ?? (base.price_minor !== null ? normalizeOffer({
    model: base.pricing_model,
    amount_minor: base.price_minor,
    currency: base.currency
  }, base) : null);
  let runCandidate;
  if (run?.candidate && run.status === "ready") {
    try {
      runCandidate = candidateFromFactoryRun(run, base.product_id);
    } catch {
      runCandidate = undefined;
    }
  }
  const status = state?.status
    ?? (runCandidate?.status === "ready_for_review" ? "candidate_ready" : base.status);
  const candidate = runCandidate ?? state?.candidate ?? null;
  const candidateApproved = approvalMatchesCandidate(state?.approval, candidate);
  const presentedCandidate = candidateApproved
    ? { ...candidate, status: "approved", approval_status: "approved", approved: true }
    : candidate;
  const presentedApproval = state?.approval?.status === "approved" && !candidateApproved
    ? { ...state.approval, status: "stale" }
    : state?.approval ?? null;
  return {
    ...base,
    version: state?.version ?? 0,
    resource_version: state?.version ?? 0,
    status,
    candidate: presentedCandidate,
    approval: presentedApproval,
    offer,
    offer_draft: state?.offer_draft ?? null,
    offer_active: state?.offer_active ?? normalizeOffer(agent.product_offer, agent),
    release: state?.release ?? null,
    releases: state?.releases ?? (state?.release ? [state.release] : []),
    public_url: canonicalPublicUrl(state?.public_url) ?? (base.status === "published" ? `/products/${encodeURIComponent(base.product_id)}` : null),
    readiness: {
      candidate_approved: candidateApproved,
      offer_valid: Boolean(state?.offer_draft ?? normalizeOffer(agent.product_offer, agent)),
      publishable_corpus: Boolean(runCandidate?.corpus_verified || base.corpus_digest),
      ready: Boolean(candidateApproved && state?.offer_draft)
    },
    updated_at: state?.updated_at ?? run?.updated_at ?? base.published_at
  };
}

function candidateFromFactoryRun(run, expectedProductId) {
  if (!run || run.status !== "ready" || !run.candidate) {
    throw stateError("candidate_not_ready", "Factory candidate is not ready for review.", 409);
  }
  if (run.product?.id && run.product.id !== expectedProductId) {
    throw stateError("candidate_product_mismatch", "Candidate does not belong to this product.", 409);
  }
  const digest = run.candidate.corpus_digest ?? run.candidate.system_digest;
  const knownLosses = Array.isArray(run.candidate.known_losses)
    ? run.candidate.known_losses.map((loss, index) => ({ ...loss, id: String(loss?.id ?? `loss_${index + 1}`) }))
    : [];
  const criticalGates = [
    {
      id: "verified_corpus",
      label: "Verified Agent Corpus",
      critical: true,
      passed: Boolean(run.candidate.corpus_verified),
      detail: "Registry verification produced an exact immutable Corpus digest."
    },
    {
      id: "factory_evaluation_complete",
      label: "Development and regression evaluation complete",
      critical: true,
      passed: run.status === "ready" && Boolean(run.candidate.regression_digest),
      detail: "The candidate is bound to the final regression evaluation asset."
    },
    {
      id: "sealed_held_out_passed",
      label: "Sealed held-out evaluation passed",
      critical: true,
      passed: run.status === "ready"
        && Boolean(run.candidate.held_out_digest)
        && Number(run.candidate.failed_critical_cases ?? 0) === 0,
      detail: `${Number(run.candidate.held_out_sample_count ?? 0)} sealed cases; no failed critical case.`
    }
  ];
  const reportDigest = `sha256:${createHash("sha256").update(JSON.stringify({
    candidate_id: run.id,
    candidate_version: run.candidate.version,
    corpus_digest: digest,
    system_digest: run.candidate.system_digest,
    reason: run.candidate.reason ?? null,
    held_out_digest: run.candidate.held_out_digest ?? null,
    regression_digest: run.candidate.regression_digest ?? null,
    known_losses: knownLosses,
    critical_gates: criticalGates.map(({ id, passed }) => ({ id, passed }))
  })).digest("hex")}`;
  return {
    candidate_id: run.id,
    // Internal deployment seam only; public candidate identity is product_id.
    agent_id: expectedProductId,
    product_id: expectedProductId,
    version: run.candidate.version,
    digest,
    system_digest: run.candidate.system_digest,
    corpus_verified: Boolean(run.candidate.corpus_verified),
    status: "ready_for_review",
    critical_gates: criticalGates,
    critical_gates_passed: criticalGates.every((gate) => gate.passed),
    report_digest: run.candidate.report_digest ?? reportDigest,
    regression_digest: run.candidate.regression_digest ?? null,
    held_out_digest: run.candidate.held_out_digest ?? null,
    held_out_sample_count: run.candidate.held_out_sample_count ?? null,
    failed_critical_cases: Number(run.candidate.failed_critical_cases ?? 0),
    factory_version: run.candidate.factory_version ?? run.factory_version ?? "creator-factory-contract-1",
    material_changes: Array.isArray(run.candidate.material_changes) ? run.candidate.material_changes : [],
    product_boundaries: Array.isArray(run.product?.boundaries) ? run.product.boundaries : [],
    known_losses: knownLosses,
    created_at: run.updated_at
  };
}

function storefrontPreview(product, profile, state, paymentMode = "disabled") {
  const offer = state?.offer_draft ?? product.offer_draft ?? product.offer;
  const candidate = product.candidate ?? state?.candidate;
  const presentedCandidate = approvalMatchesCandidate(state?.approval, candidate)
    ? { ...candidate, status: "approved", approval_status: "approved", approved: true }
    : candidate;
  return {
    product: { ...product, offer },
    creator: profile,
    candidate: presentedCandidate,
    offer,
    resource_version: state?.version ?? product.resource_version ?? 0,
    public_url: `/products/${encodeURIComponent(product.product_id)}`,
    readiness: publishReadiness({ ...product, offer }, state, paymentMode),
    preview: true
  };
}

function publishReadiness(product, state, paymentMode = "disabled") {
  const candidate = product?.candidate ?? state?.candidate;
  const approval = state?.approval ?? product?.approval;
  const offer = state?.offer_draft ?? product?.offer_draft ?? product?.offer;
  const gates = Array.isArray(candidate?.critical_gates) ? candidate.critical_gates : [];
  const candidateApproved = approvalMatchesCandidate(approval, candidate);
  const noCriticalFailures = Boolean(candidate?.corpus_verified)
    && gates.length > 0
    && gates.every((gate) => gate.passed !== false);
  const offerValid = Boolean(offer)
    && (offer.purchase_model ?? offer.model) === "per_delivery"
    && Number.isSafeInteger(Number(offer.amount_minor))
    && Number(offer.amount_minor) >= 0
    && Number(offer.included_units ?? 1) > 0
    && (Number(offer.amount_minor) === 0 || isPaidMode(paymentMode));
  const copyComplete = Boolean(
    String(product?.promise ?? product?.product_promise ?? "").trim()
    && String(product?.description ?? product?.product_description ?? "").trim()
    && Array.isArray(product?.boundaries ?? product?.product_boundaries)
    && (product?.boundaries ?? product?.product_boundaries).length > 0
  );
  const ownershipValid = Boolean(product?.creator_id);
  const materializationReady = Boolean(candidate?.digest && candidate?.corpus_verified);
  const slugAvailable = Boolean(product?.product_id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(product.product_id));
  const checks = [
    [candidateApproved, "candidate approval is stale"],
    [noCriticalFailures, "critical candidate gates are incomplete"],
    [offerValid, "offer is unsupported or invalid"],
    [copyComplete, "public promise, description, or boundaries are incomplete"],
    [ownershipValid, "Creator ownership is missing"],
    [materializationReady, "Registry materialization is not ready"],
    [slugAvailable, "canonical product slug is invalid"]
  ];
  return {
    candidate_approved: candidateApproved,
    no_critical_failures: noCriticalFailures,
    offer_valid: offerValid,
    public_copy_complete: copyComplete,
    ownership_valid: ownershipValid,
    materialization_ready: materializationReady,
    canonical_slug_available: slugAvailable,
    blockers: checks.filter(([ready]) => !ready).map(([, message]) => message),
    ready: checks.every(([ready]) => ready)
  };
}

function approvalMatchesCandidate(approval, candidate) {
  return Boolean(
    approval?.status === "approved"
    && candidate
    && approval.candidate_id === candidate.candidate_id
    && approval.candidate_digest === candidate.digest
    && approval.report_digest === candidate.report_digest
  );
}

function enrichEntitlements(entitlements, catalog, deliveries = []) {
  const byProduct = new Map((Array.isArray(catalog) ? catalog : []).map((agent) => [
    `${agent.creator_id}:${agent.product_id}`,
    agent
  ]));
  const deliveriesByEntitlement = new Map();
  for (const delivery of Array.isArray(deliveries) ? deliveries : []) {
    if (!delivery?.entitlement_id) continue;
    const history = deliveriesByEntitlement.get(delivery.entitlement_id) ?? [];
    history.push(delivery);
    deliveriesByEntitlement.set(delivery.entitlement_id, history);
  }
  return entitlements.map((entitlement) => {
    const agent = byProduct.get(`${entitlement.creator_id}:${entitlement.product_id}`);
    const {
      agent_id: _agentId,
      creator_slug: _creatorSlug,
      product_slug: _productSlug,
      creator_slug_aliases: _creatorAliases,
      product_slug_aliases: _productAliases,
      ...publicEntitlement
    } = entitlement;
    return {
      ...publicEntitlement,
      product_id: entitlement.product_id ?? entitlement.agent_id,
      status: entitlement.status === "active" && entitlement.reserved_units > 0 ? "reserved" : entitlement.status,
      product: agent ? {
        id: agent.product_id,
        product_id: agent.product_id,
        name: agent.product_name,
        description: agent.product_description,
        promise: agent.product_promise
      } : { id: entitlement.product_id, product_id: entitlement.product_id, name: entitlement.product_id },
      creator: agent ? { id: agent.creator_id, name: agent.creator_name } : { id: entitlement.creator_id },
      granted_units: entitlement.granted_units ?? 1,
      remaining_units: entitlement.remaining_units ?? 1,
      unit: entitlement.unit ?? "delivery",
      version_policy: entitlement.version_policy ?? "pinned",
      deliveries: deliveriesByEntitlement.get(entitlement.entitlement_id) ?? []
    };
  });
}

function entitlementMatchesStatus(entitlement, status) {
  if (!status || status === "all") return true;
  if (status === "active") return entitlement.status === "active" || entitlement.status === "reserved";
  if (status === "past") return ["consumed", "expired", "revoked"].includes(entitlement.status);
  return entitlement.status === status;
}

function orderDetail(order, events = []) {
  const paymentStatus = order.payment_status ?? (order.gross_minor === 0 ? "not_required" : "paid");
  const entitlement = order.entitlement ?? (order.entitlement_id ? { entitlement_id: order.entitlement_id, status: order.status === "refunded" ? "revoked" : "active" } : null);
  const entitlementId = entitlement?.entitlement_id ?? null;
  const deliveries = Array.isArray(order.deliveries)
    ? order.deliveries
    : events.filter((event) => event.order_id === order.order_id && event.event_type === "delivery.completed");
  const refunds = Array.isArray(order.refunds)
    ? order.refunds
    : events.filter((event) => event.order_id === order.order_id && event.event_type === "order.refunded");
  const refunded = order.status === "refunded" || refunds.length > 0;
  const timeline = Array.isArray(order.timeline)
    ? order.timeline
    : events
      .filter((event) => event.order_id === order.order_id)
      .map((event) => ({ event_id: event.event_id, type: event.event_type, occurred_at: event.occurred_at }))
      .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
  const revenueRecognized = Array.isArray(order.revenue)
    ? order.revenue.some((entry) => entry.status === "recognized")
    : events.some((event) => event.order_id === order.order_id && event.event_type === "revenue.recognized");
  const {
    agent_id: _agentId,
    creator_slug: _creatorSlug,
    product_slug: _productSlug,
    creator_slug_aliases: _creatorAliases,
    product_slug_aliases: _productAliases,
    ...publicOrder
  } = order;
  return {
    ...publicOrder,
    product_id: order.product_id ?? order.agent_id,
    order_number: order.order_number ?? stableOrderNumber(order),
    creator: order.creator_snapshot ?? { id: order.creator_id, name: order.creator_display_name ?? order.creator_id },
    status: refunded
      ? order.status
      : deliveries.length
        ? "delivered"
        : order.status === "paid" && entitlementId
          ? "fulfilled"
          : order.status,
    entitlement_id: entitlementId,
    entitlement,
    created_at: order.created_at ?? order.occurred_at,
    placed_at: order.placed_at ?? order.occurred_at,
    total_minor: order.total_minor ?? order.gross_minor,
    payment_status: paymentStatus,
    entitlement_status: refunded ? "revoked" : entitlement?.status ?? (entitlementId ? "active" : "pending"),
    delivery_status: deliveries.length ? "completed" : "not_started",
    revenue_status: revenueRecognized ? "recognized" : order.gross_minor === 0 ? "not_applicable" : "pending",
    refund_status: refunded ? "refunded" : "none",
    payment: { status: paymentStatus, payment_id: order.payment_id ?? null },
    access: { status: refunded ? "revoked" : entitlement?.status ?? (entitlementId ? "active" : "pending"), entitlement_id: entitlementId },
    deliveries,
    refund: refunds.at(-1) ?? null,
    actions: {
      can_request_refund: order.gross_minor > 0 && !refunded,
      can_creator_refund: !refunded,
      can_cancel_access: order.gross_minor === 0 && !refunded && deliveries.length === 0
    },
    timeline
  };
}

function stableOrderNumber(order) {
  const timestamp = Date.parse(order?.created_at ?? order?.occurred_at ?? "") || Date.now();
  const year = new Date(timestamp).getUTCFullYear();
  const digest = createHash("sha256").update(String(order?.order_id ?? order?.id ?? "order")).digest("hex").slice(0, 8).toUpperCase();
  return `HCH-${year}-${digest}`;
}

function orderNumberFor(order) {
  return order?.order_number ?? stableOrderNumber(order);
}

function resolveOrderIdentifier(commerce, identifier, buyerId) {
  const value = String(identifier ?? "");
  const direct = commerce.getOrder(value);
  if (direct && (!buyerId || direct.buyer_id === buyerId)) return direct;
  return commerce.listBuyerOrders(buyerId).find((order) => stableOrderNumber(order) === value || order.order_number === value);
}

function randomId() {
  return randomUUID().replaceAll("-", "");
}

function isPaidMode(mode) {
  return ["test", "sandbox", "provider"].includes(mode);
}

function stableOfferId(creatorId, productId) {
  return stableAuthorityUuid(`offer:${creatorId}:${productId}`);
}

function stableAuthorityUuid(seed) {
  const digest = createHash("sha256").update(String(seed)).digest("hex").slice(0, 32).split("");
  digest[12] = "4";
  digest[16] = ["8", "9", "a", "b"][parseInt(digest[16], 16) % 4];
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function catalogAgentToProduct(agent) {
  const offer = agent?.product_offer ?? {};
  return {
    product_id: agent.product_id,
    creator_id: agent.creator_id,
    agent_id: agent.agent_id,
    corpus_digest: agent.corpus_digest,
    name: agent.product_name,
    description: agent.product_description ?? "",
    promise: agent.product_promise ?? agent.product_description ?? "",
    boundaries: agent.product_boundaries ?? [],
    status: agent.status ?? "published",
    price_minor: Number.isInteger(offer.amount_minor) ? offer.amount_minor : null,
    currency: offer.currency ?? "USD",
    pricing_model: offer.model ?? null,
    published_at: agent.published_at ?? null,
    presentation: agent.presentation ?? {}
  };
}

function bearerToken(request) {
  return request.__registryToken ?? bearerTokenFromAuthorization(request);
}

function bearerTokenFromAuthorization(request) {
  const value = String(request.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function requireCommandKey(request, body) {
  const value = String(request.headers["idempotency-key"] ?? body?.idempotency_key ?? "").trim();
  if (!value) throw stateError("idempotency_required", "Idempotency-Key is required.", 400);
  return value;
}

function assertNoPrivateCommerceFields(value) {
  const forbidden = new Set(["artifactpath", "workspacepath", "content", "conversationid", "toolarguments", "arguments"]);
  const visit = (input) => {
    if (!input || typeof input !== "object") return;
    for (const [key, nested] of Object.entries(input)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      if (forbidden.has(normalizedKey)) {
        throw stateError("private_commerce_field", `Commerce payload must not contain ${key}.`, 400);
      }
      visit(nested);
    }
  };
  visit(value);
}

function cookieCsrfError(request, sessionToken = requestCookies(request).hatch_web_session) {
  if (["GET", "HEAD", "OPTIONS"].includes(String(request.method ?? "GET").toUpperCase())) return undefined;
  if (String(request.headers.authorization ?? "").startsWith("Bearer ")) return undefined;
  if (!sessionToken) return undefined;
  const cookies = requestCookies(request);
  const submitted = String(request.headers["x-csrf-token"] ?? "");
  const expected = webCsrfToken(sessionToken);
  if (!cookies.hatch_web_csrf || !submitted || !safeEqual(cookies.hatch_web_csrf, expected) || !safeEqual(submitted, expected)) {
    return {
      status: 403,
      body: { error: { code: "csrf_rejected", message: "Refresh the page and try again." } }
    };
  }
  return undefined;
}

function setWebSessionCookies(request, response, token) {
  const secure = requestIsSecure(request);
  const secureAttribute = secure ? "; Secure" : "";
  const common = `Path=/; SameSite=Lax; Max-Age=43200${secureAttribute}`;
  response.setHeader("set-cookie", [
    `hatch_web_session=${encodeURIComponent(token)}; ${common}; HttpOnly`,
    `hatch_web_csrf=${encodeURIComponent(webCsrfToken(token))}; ${common}`
  ]);
}

function clearWebSessionCookies(request, response) {
  const secureAttribute = requestIsSecure(request) ? "; Secure" : "";
  response.setHeader("set-cookie", [
    `hatch_web_session=; Path=/; SameSite=Lax; Max-Age=0${secureAttribute}; HttpOnly`,
    `hatch_web_csrf=; Path=/; SameSite=Lax; Max-Age=0${secureAttribute}`
  ]);
}

function requestCookies(request) {
  return String(request.headers.cookie ?? "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = "";
    }
    return cookies;
  }, {});
}

function webCsrfToken(token) {
  return createHash("sha256").update(`hatch-web-csrf\0${token}`).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requestIsSecure(request) {
  return Boolean(request.socket?.encrypted)
    || String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase() === "https";
}

function crossSiteMutationError(request) {
  const origin = String(request.headers.origin ?? "").trim();
  const fetchSite = String(request.headers["sec-fetch-site"] ?? "").trim().toLowerCase();
  if (fetchSite === "cross-site") {
    return { status: 403, body: { error: { code: "origin_rejected", message: "Open Hatch directly and try again." } } };
  }
  if (!origin) return undefined;
  try {
    const forwardedHost = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
    if (!forwardedHost || new URL(origin).host !== forwardedHost) {
      return { status: 403, body: { error: { code: "origin_rejected", message: "Open Hatch directly and try again." } } };
    }
  } catch {
    return { status: 403, body: { error: { code: "origin_rejected", message: "Open Hatch directly and try again." } } };
  }
  return undefined;
}

async function readJson(request, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES) {
  const raw = await readRawBody(request, maxBytes);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw stateError("invalid_json", "Request body must be valid JSON.", 400);
  }
}

async function readRawBody(request, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES) {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) throw requestBodyTooLarge(maxBytes);
  const chunks = [];
  let size = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > maxBytes) {
      exceeded = true;
      continue;
    }
    if (!exceeded) chunks.push(value);
  }
  if (exceeded) throw requestBodyTooLarge(maxBytes);
  return Buffer.concat(chunks);
}

function requestBodyTooLarge(maxBytes) {
  const error = new Error(`Request body exceeds the ${maxBytes}-byte limit`);
  error.status = 413;
  error.code = "request_body_too_large";
  return error;
}

function commerceErrorStatus(code) {
  if (["order_not_found", "entitlement_not_found", "reservation_not_found"].includes(code)) return 404;
  if (["invalid_command", "invalid_transaction", "idempotency_required"].includes(code)) return 400;
  if (typeof code === "string" && (
    code.startsWith("idempotency_")
    || code.startsWith("refund_")
    || code.startsWith("payment_")
    || code.startsWith("entitlement_")
    || code.startsWith("insufficient_")
  )) return 409;
  return 500;
}

function publicRequestError(error) {
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(error.code)
    ? error.code
    : "internal_error";
  const status = normalizedHttpStatus(error?.status ?? commerceErrorStatus(code));
  if (status >= 500) {
    return {
      status,
      error: {
        code,
        message: "Hatch could not complete this request. Retry with the same request ID or contact support."
      }
    };
  }
  return {
    status,
    error: {
      code,
      message: error instanceof Error ? error.message : "The request could not be completed.",
      ...(error?.details === undefined ? {} : { details: error.details })
    }
  };
}

function normalizedHttpStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function paginate(items, url, defaultLimit = 50) {
  const requestedLimit = Number(url.searchParams.get("limit") ?? defaultLimit);
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : defaultLimit;
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const end = Math.min(items.length, cursor + limit);
  return {
    items: items.slice(cursor, end),
    next_cursor: end < items.length ? Buffer.from(String(end)).toString("base64url") : null
  };
}

function validFilterDate(value, field) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw stateError("invalid_filter", `${field} must be an ISO date or timestamp.`, 400);
  return date;
}

function filterCreatorOrders(orders, url) {
  const orderStatus = url.searchParams.get("order");
  const deliveryStatus = url.searchParams.get("delivery");
  const productId = url.searchParams.get("product");
  const paymentStatus = url.searchParams.get("payment");
  const refundStatus = url.searchParams.get("refund");
  const from = validFilterDate(url.searchParams.get("from"), "from");
  const to = validFilterDate(url.searchParams.get("to"), "to");
  return orders.filter((order) => (
    (!orderStatus || order.status === orderStatus || (orderStatus === "fulfilled" && order.status === "delivered"))
    && (!deliveryStatus || order.delivery_status === deliveryStatus)
    && (!productId || order.product_id === productId)
    && (!paymentStatus || order.payment_status === paymentStatus)
    && (!refundStatus || order.refund_status === refundStatus)
    && (!from || Date.parse(order.occurred_at ?? order.created_at) >= from.getTime())
    && (!to || Date.parse(order.occurred_at ?? order.created_at) <= to.getTime())
  ));
}

function creatorOrderExportRow(order) {
  const recognized = (Array.isArray(order.revenue) ? order.revenue : []).filter((entry) => entry.status === "recognized");
  return {
    order_reference: order.order_id,
    buyer_display_name: order.buyer_display_name ?? "Hatch buyer",
    product_id: order.product_id,
    product_name: order.product_name ?? order.product_snapshot?.name ?? "",
    offer_id: order.offer_id ?? "",
    offer_revision: order.offer_revision ?? "",
    order_status: order.status,
    payment_status: order.payment_status,
    entitlement_status: order.entitlement_status,
    delivery_status: order.delivery_status,
    delivery_count: order.deliveries?.length ?? 0,
    artifact_types: [...new Set((order.deliveries ?? []).map((delivery) => delivery.artifact_type).filter(Boolean))].join("|"),
    gross_minor: order.gross_minor,
    currency: order.currency,
    recognized_gross_minor: recognized.reduce((sum, entry) => sum + Number(entry.gross_minor ?? 0), 0),
    creator_share_minor: recognized.reduce((sum, entry) => sum + Number(entry.creator_share_minor ?? 0), 0),
    refund_status: order.refund_status,
    created_at: order.created_at ?? order.occurred_at
  };
}

function decodeCursor(value) {
  if (!value) return 0;
  try {
    const decoded = Number(Buffer.from(value, "base64url").toString("utf8"));
    return Number.isSafeInteger(decoded) && decoded >= 0 ? decoded : 0;
  } catch {
    return 0;
  }
}

function send(response, status, body) {
  response.statusCode = status;
  response.setHeader("access-control-allow-origin", "http://127.0.0.1:8510");
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key, x-csrf-token, x-request-id");
  response.setHeader("access-control-expose-headers", "x-request-id");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (body === undefined) return response.end();
  response.setHeader("content-type", "application/json; charset=utf-8");
  const responseBody = response.__includeRequestId
    && body
    && typeof body === "object"
    && !Array.isArray(body)
    ? { ...body, request_id: response.__hatchRequestId }
    : body;
  response.end(JSON.stringify(responseBody));
}

function sendCsv(response, filename, rows) {
  const columns = Object.keys(rows[0] ?? creatorOrderExportRow({ deliveries: [], revenue: [] }));
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ].join("\n");
  response.statusCode = 200;
  response.setHeader("access-control-allow-origin", "http://127.0.0.1:8510");
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-expose-headers", "x-request-id, content-disposition");
  response.setHeader("content-type", "text/csv; charset=utf-8");
  response.setHeader("content-disposition", `attachment; filename="${filename}"`);
  response.end(`${csv}\n`);
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function normalizedRequestId(value) {
  const candidate = String(Array.isArray(value) ? value[0] : value ?? "").trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate) ? candidate : `req_${randomId()}`;
}

function consumeFixedWindowRateLimit(windows, key, limit, windowMs, now = Date.now()) {
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (current.count >= limit) {
    return { allowed: false, retryAfterMs: current.resetAt - now };
  }
  current.count += 1;
  if (windows.size > 10_000) {
    for (const [candidate, entry] of windows) {
      if (entry.resetAt <= now) windows.delete(candidate);
    }
  }
  return { allowed: true, retryAfterMs: 0 };
}

async function commerceOperationsSnapshot({ ledger, commerce, portalState, telemetry, now = new Date() }) {
  await ledger.refresh?.();
  await portalState.refresh?.();
  const nowMs = now.getTime();
  const events = ledger.listEvents();
  const pendingCheckoutStatuses = new Set(["payment_pending", "requires_action", "fulfillment_pending"]);
  const checkouts = portalState.listCheckoutSessions()
    .filter((session) => pendingCheckoutStatuses.has(session.status))
    .map((session) => ({
      checkout_session_id: session.checkout_session_id,
      status: session.status,
      age_ms: ageMs(session.updated_at ?? session.created_at, nowMs),
      retry_count: Number(session.reconcile_attempts ?? 0),
      last_error_category: session.reconcile_last_error?.category ?? null
    }));
  const ordersByPayment = new Set(events
    .filter((event) => event.event_type === "order.placed" && event.payment_id)
    .map((event) => event.payment_id));
  const capturedWithoutOrder = commerce.listPayments()
    .filter((payment) => payment.status === "succeeded" && !ordersByPayment.has(payment.payment_id))
    .map((payment) => ({
      payment_id: payment.payment_id,
      checkout_session_id: payment.checkout_session_id ?? null,
      age_ms: ageMs(payment.updated_at ?? payment.created_at, nowMs),
      status: payment.status
    }));
  const entitlements = [...new Set(events
    .filter((event) => event.event_type === "entitlement.granted")
    .map((event) => event.entitlement_id))]
    .map((entitlementId) => commerce.getEntitlement(entitlementId))
    .filter(Boolean);
  const staleReservations = entitlements.flatMap((entitlement) => entitlement.reservations
    .filter((reservation) => reservation.status === "expired")
    .map((reservation) => ({
      reservation_id: reservation.reservation_id,
      entitlement_id: entitlement.entitlement_id,
      age_ms: ageMs(reservation.expires_at, nowMs),
      status: reservation.status
    })));
  const pendingRevenue = commerce.listDeliveries()
    .filter((delivery) => delivery.revenue_status === "pending")
    .map((delivery) => ({
      delivery_id: delivery.delivery_id,
      order_id: delivery.order_id,
      age_ms: ageMs(delivery.completed_at, nowMs),
      status: delivery.revenue_status
    }));
  const payoutIds = [...new Set(events
    .filter((event) => event.event_type === "payout.reserved")
    .map((event) => event.payout_id))];
  const payoutAttention = payoutIds
    .map((payoutId) => commerce.getPayout(payoutId))
    .filter((payout) => payout && ["failed", "submitted", "in_transit"].includes(payout.status))
    .map((payout) => ({
      payout_id: payout.payout_id,
      status: payout.status,
      attempt: payout.attempt,
      age_ms: ageMs(payout.submitted_at ?? payout.updated_at ?? payout.created_at, nowMs),
      retry_count: Number(payout.reconciliation?.retry_count ?? 0),
      last_error_category: payout.reconciliation?.last_error?.code ?? payout.failure?.code ?? null
    }));
  let outbox = [];
  if (typeof ledger.listPendingOutbox === "function") {
    outbox = (await ledger.listPendingOutbox({ limit: 1_000 })).map((item) => ({
      outbox_id: item.outbox_id,
      event_id: item.event_id,
      topic: item.topic,
      age_ms: ageMs(item.created_at, nowMs),
      retry_count: Number(item.attempts ?? 0),
      last_error_category: item.last_error ? "dispatch_failed" : null
    }));
  }
  const refundProjectionLag = outbox
    .filter((item) => item.topic === "entitlement.revoked")
    .map((item) => ({ ...item, status: "refund_access_sync_pending" }));
  const slas_ms = {
    fulfillment: 5 * 60_000,
    revenue: 5 * 60_000,
    outbox: 5 * 60_000,
    payout: 3 * 24 * 60 * 60_000
  };
  const alerts = [
    ...checkouts.filter((item) => item.age_ms >= slas_ms.fulfillment).map((item) => operationalAlert("fulfillment_pending", item.checkout_session_id, item)),
    ...capturedWithoutOrder.filter((item) => item.age_ms >= slas_ms.fulfillment).map((item) => operationalAlert("captured_without_order", item.payment_id, item)),
    ...staleReservations.map((item) => operationalAlert("stale_reservation", item.reservation_id, item)),
    ...pendingRevenue.filter((item) => item.age_ms >= slas_ms.revenue).map((item) => operationalAlert("revenue_pending", item.delivery_id, item)),
    ...refundProjectionLag.filter((item) => item.age_ms >= slas_ms.outbox || item.retry_count >= 3).map((item) => operationalAlert("refund_projection_lag", item.outbox_id, item)),
    ...outbox.filter((item) => item.topic !== "entitlement.revoked" && (item.age_ms >= slas_ms.outbox || item.retry_count >= 3)).map((item) => operationalAlert("outbox_pending", item.outbox_id, item)),
    ...payoutAttention.filter((item) => item.status === "failed" || item.age_ms >= slas_ms.payout || item.retry_count >= 3).map((item) => operationalAlert("payout_attention", item.payout_id, item))
  ];
  return {
    generated_at: now.toISOString(),
    funnel: await telemetry?.summary?.() ?? {},
    slas_ms,
    counts: {
      fulfillment_pending: checkouts.length,
      captured_without_order: capturedWithoutOrder.length,
      stale_reservations: staleReservations.length,
      revenue_pending: pendingRevenue.length,
      refund_projection_lag: refundProjectionLag.length,
      outbox_pending: outbox.length,
      payout_attention: payoutAttention.length,
      alerts: alerts.length
    },
    pending: {
      checkouts,
      captured_without_order: capturedWithoutOrder,
      stale_reservations: staleReservations,
      revenue: pendingRevenue,
      refund_projection_lag: refundProjectionLag,
      outbox,
      payouts: payoutAttention
    },
    alerts
  };
}

function operationalAlert(category, resourceId, item) {
  return {
    severity: item.status === "failed" || Number(item.retry_count ?? 0) >= 3 ? "critical" : "warning",
    category,
    resource_id: String(resourceId),
    age_ms: item.age_ms,
    retry_count: Number(item.retry_count ?? item.attempt ?? 0),
    last_error_category: item.last_error_category ?? null
  };
}

function ageMs(value, nowMs) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : 0;
}

function isPublicPortalRoute(pathname) {
  return pathname === "/"
    || pathname === "/explore"
    || pathname.startsWith("/explore/")
    || pathname === "/creators"
    || pathname.startsWith("/creators/")
    || pathname === "/products"
    || pathname.startsWith("/products/")
    || pathname === "/library"
    || pathname.startsWith("/library/")
    || pathname === "/orders"
    || pathname.startsWith("/orders/")
    || pathname === "/checkout"
    || pathname.startsWith("/checkout/")
    || pathname === "/studio"
    || pathname.startsWith("/studio/")
    || pathname === "/account"
    || pathname.startsWith("/account/")
    || pathname === "/sign-in"
    || pathname === "/sign-up"
    || pathname === "/download";
}

async function servePortalIndex(response, metadata, status = 200, noScriptFallback) {
  try {
    const source = await readFile(path.join(currentDirectory, "dist", "index.html"), "utf8");
    const withMetadata = metadata ? injectProductMetadata(source, metadata) : source;
    const body = noScriptFallback
      ? injectProductNoScriptFallback(withMetadata, noScriptFallback)
      : withMetadata;
    response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    response.end(body);
  } catch {
    return send(response, 500, {
      error: {
        code: "portal_unavailable",
        message: "The Hatch portal is temporarily unavailable."
      }
    });
  }
}

async function servePortalAsset(requestPath, response) {
  let relativePath;
  try {
    if (requestPath === "/assets" || !path.extname(requestPath)) {
      relativePath = "index.html";
    } else if (requestPath.startsWith("/assets/")) {
      relativePath = decodeURIComponent(requestPath.slice("/".length));
    } else {
      return send(response, 404, { error: { code: "asset_not_found", message: "Asset not found." } });
    }
  } catch {
    return send(response, 400, { error: { code: "invalid_path", message: "Invalid portal asset path." } });
  }
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    return send(response, 400, { error: { code: "invalid_path", message: "Invalid portal asset path." } });
  }
  const assetRoot = path.join(currentDirectory, "dist");
  const assetPath = path.join(assetRoot, relativePath);
  try {
    const body = await readFile(assetPath);
    response.writeHead(200, {
      "content-type": contentType(assetPath),
      "cache-control": relativePath === "index.html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    response.end(body);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT" || path.extname(relativePath)) {
      return send(response, error?.code === "ENOENT" ? 404 : 500, { error: { code: "portal_asset_not_found", message: "Portal asset not found." } });
    }
    // Client-side routes under the canonical public/private paths resolve
    // through the SPA entrypoint.
    try {
      const body = await readFile(path.join(assetRoot, "index.html"));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      response.end(body);
      return;
    } catch {
      return send(response, 500, {
        error: {
          code: "portal_unavailable",
          message: "The Hatch portal is temporarily unavailable."
        }
      });
    }
  }
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[extension] ?? "application/octet-stream";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port } = await startDashboardServer();
  console.log(`Hatch Creator Dashboard API listening on http://${host}:${port}`);
}
