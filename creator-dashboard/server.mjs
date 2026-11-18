import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import { InflightResponses, drainMsFromEnvironment, exitOnSignal, gracefulShutdown } from "./gracefulShutdown.mjs";
import { WebSocket, WebSocketServer } from "ws";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CommerceLedger,
  CommerceService,
  PostgresCommerceLedger
} from "../packages/commerce/src/index.js";
import { PortalStateStore, stateError } from "./portalState.mjs";
import { createLibrary } from "./library.mjs";
import { createGuestTokens } from "./guest.mjs";
import { createDesktopSignIn, DESKTOP_TOKEN_PATH } from "./desktopSignIn.mjs";
import { submitContact } from "./contactForm.mjs";
import { createProviderAdapter } from "./providerAdapters.mjs";
import {
  createDefaultMetadata,
  createProductMetadata,
  createProductNoScriptFallback,
  createUnavailableProductMetadata,
  injectProductMetadata,
  injectProductNoScriptFallback
} from "./publicMetadata.mjs";
import { helpPage, injectHelpPage, robotsTxt, sitemapXml } from "./helpSeo.mjs";
import { createServerAnalytics } from "./analytics.mjs";
import { agentRemoved, agentSaved, guestSignedInCarriedOver, signedIn, signupCompleted } from "./analyticsEvents.mjs";
import { WebChatRuntimeBridge } from "./webChatRuntimeBridge.mjs";
import { bindAccount, currentContext, logEvent, observed, propagatingFetch, requestIdFrom } from "./observability.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
const ACCOUNT_AVATAR_BODY_MAX_BYTES = 5 * 1024 * 1024;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CREATOR_FACTORY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;
/** Ingest bodies carry upload ids and links, never file bytes: files go straight to object storage. */
export const CREATOR_INGEST_JSON_BODY_MAX_BYTES = 256 * 1024;

// Browser OAuth is deliberately an authorization-code + PKCE bridge to the
// existing Hatch web session. OAuth records live in PortalStateStore, which is
// backed by Postgres in production (or the local durable state file in dev).
// Bearer values are never written there in plaintext; the dashboard encrypts
// the Registry session token and stores only SHA-256 digests for lookups.
const DEFAULT_OAUTH_CLIENT_ID = "hatch-context-intake";
const DEFAULT_OAUTH_SCOPES = Object.freeze([
  "creator:products:read",
  "creator:products:write",
  "creator:files:read",
  "creator:files:write"
]);

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
  const runtimeUrl = options.runtimeUrl
    ?? process.env.HATCH_RUNTIME_URL
    ?? "http://127.0.0.1:8400";
  const publicOrigin = options.publicOrigin
    ?? process.env.HATCH_PUBLIC_ORIGIN
    ?? (process.env.NODE_ENV === "production" ? "https://hatch.tokenquadrant.cn" : "http://127.0.0.1:8500");
  const allowedPublicOrigins = new Set([
    new URL(publicOrigin).origin,
    ...(options.publicOrigins ?? process.env.HATCH_PUBLIC_ORIGINS?.split(",") ?? [])
      .map(origin => origin.trim())
      .filter(Boolean)
      .map(origin => new URL(origin).origin)
  ]);
  if (process.env.NODE_ENV !== "production") allowedPublicOrigins.add("http://127.0.0.1:8510");
  const studioWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const chatWss = new WebSocketServer({ noServer: true, maxPayload: 160 * 1024 * 1024 });
  // Set once shutdown begins: readiness fails so the proxy sends nothing new.
  let draining = false;
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
  const oauthStateKey = resolveOAuthStateKey(
    options.oauthStateKey ?? process.env.HATCH_OAUTH_STATE_KEY ?? process.env.HATCH_SESSION_SECRET,
    portalStatePath
  );
  const desktopSignIn = createDesktopSignIn({
    authenticate: (request, response) => authenticateWithSlide(request, response, registryUrl, fetchImpl, portalState),
    mintSession: (token, clientType) => registryRequest(registryUrl, "/v1/auth/sessions", { method: "POST", fetchImpl, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ client_type: clientType }) }),
    codes: portalState,
    seal: (value) => encryptOAuthSecret(value, oauthStateKey),
    open: (value) => decryptOAuthSecret(value, oauthStateKey),
    readJson,
    send
  });
  const analytics = options.analytics ?? createServerAnalytics(process.env);
  // Send-and-forget: a failing analytics adapter never reaches a request.
  const track = (distinctId, { event, properties }) => {
    try { if (distinctId) analytics.capture(distinctId, { event, properties }); } catch { /* analytics must never fail a request */ }
  };
  const startWebSession = async (request, response, auth, method, created = false) => {
    const profile = publicProfile(auth.account);
    const webSession = await portalState.createWebSession(auth.token, profile, {
      registryTokenCiphertext: encryptOAuthSecret(auth.token, oauthStateKey),
      absolute_expires_at: auth.session?.expires_at
    });
    track(profile.id, created ? signupCompleted(method) : signedIn(method));
    setWebSessionCookies(request, response, webSession.session_id, webSessionMaxAge(portalState, webSession));
    // Whatever way the visitor signed in, the guest's conversations become the account's before the first page of it loads.
    await carryOverGuest(request, response, auth.token, profile.id).catch(() => {});
    return profile;
  };
  // Moves the browser's guest conversations to the account; a failure throws and keeps the cookie so it can be retried.
  const carryOverGuest = async (request, response, token, accountId) => {
    const guestToken = requestCookies(request).hatch_guest;
    if (!guestTokens?.verify(guestToken)) return 0;
    const upstream = await fetchImpl(new URL("/v1/guest/carry-over", runtimeUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ guest_token: guestToken })
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) throw Object.assign(new Error("carry_over_failed"), { status: upstream.status, payload });
    const moved = Number(payload.moved) || 0;
    response.setHeader("set-cookie", [[response.getHeader("set-cookie") ?? []].flat(), guestCookie(request, "", 0)].flat());
    if (moved > 0) track(accountId, guestSignedInCarriedOver(moved));
    return moved;
  };
  const fetchImpl = propagatingFetch(options.fetchImpl ?? fetch);
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
    fetchImpl
  });
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
  const library = createLibrary({
    commerce,
    findProduct: async (productId) => {
      const candidates = (await authoritativeCatalog(registryUrl, fetchImpl, portalState)).filter((entry) => entry.product_id === productId);
      if (candidates.length > 1) throw stateError("ambiguous_product", "This product id is not globally unique.", 409);
      const [agent] = candidates;
      return agent && publicCatalogAgent(agent, portalState.getCreatorProduct(agent.creator_id, agent.product_id));
    },
    grantInput: libraryGrantInput
  });
  const exposeBearerTokens = options.exposeBearerTokens === true;
  const registryDeploymentServiceToken = options.registryDeploymentServiceToken
    ?? process.env.HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN
    ?? "";
  const commerceRuntimeServiceToken = options.commerceRuntimeServiceToken
    ?? process.env.HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN
    ?? "";
  // Guest chat needs its own signing secret, shared with the Runtime; without it there is no guest, and the answer says so.
  const guestTokenSecret = String(options.guestTokenSecret ?? process.env.HATCH_GUEST_TOKEN_SECRET ?? "").trim();
  const guestTokens = guestTokenSecret ? createGuestTokens(guestTokenSecret) : undefined;
  const guestCookie = (request, token, maxAge = 365 * 24 * 3600) =>
    `hatch_guest=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${requestIsSecure(request) ? "; Secure" : ""}; HttpOnly`;
  // Chat identity: a web session wins; otherwise the browser's guest token, minted on first need (a bad cookie counts as none).
  const chatAuthentication = async (request, authenticate = (req) => authenticateRequest(req, registryUrl, fetchImpl, portalState)) => {
    const authentication = await authenticate(request);
    if (!authentication.error || authentication.error.status !== 401 || bearerTokenFromAuthorization(request)) return authentication;
    if (!guestTokens) return { error: { status: 503, body: { error: { code: "guest_unavailable", message: "Guest chat is unavailable." } } } };
    const existing = requestCookies(request).hatch_guest;
    if (guestTokens.verify(existing)) return { guest: true, token: existing };
    const token = guestTokens.mint();
    return { guest: true, token, setCookie: guestCookie(request, token) };
  };

  const payoutReconcileAfterMs = Math.max(0, Number(options.payoutReconcileAfterMs
    ?? process.env.HATCH_PAYOUT_RECONCILE_AFTER_MS
    ?? 60_000));
  const resolveCreatorNames = async (creatorIds) => {
    const ids = [...new Set(creatorIds.map((id) => String(id ?? "")).filter(Boolean))];
    if (!ids.length) return new Map();
    if (!registryDeploymentServiceToken) {
      throw stateError("creator_account_authority_unavailable", "Account names require Registry service authorization.", 503);
    }
    const batches = [];
    for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
    const responses = await Promise.all(batches.map((batch) => registryRequest(
      registryUrl,
      `/v1/internal/creator-accounts?ids=${encodeURIComponent(batch.join(","))}`,
      { fetchImpl, headers: { authorization: `Bearer ${registryDeploymentServiceToken}` } }
    )));
    const accounts = responses.flatMap((payload) => {
      if (!Array.isArray(payload?.accounts)) throw new Error("Registry account response is malformed.");
      return payload.accounts;
    });
    const names = new Map(accounts.map((account) => {
      if (typeof account?.id !== "string" || typeof account.display_name !== "string" || !account.display_name.trim()) {
        throw new Error("Registry returned an invalid account name.");
      }
      return [account.id, account.display_name];
    }));
    return names;
  };

  const dispatchCommerceOutbox = async () => {
    if (typeof ledger.dispatchOutbox !== "function") return { claimed: 0, dispatched: 0, failed: 0, errors: [] };
    // Access is read directly from the authoritative ledger. The outbox still
    // drains audit notifications, but no longer copies entitlement state into
    // Registry.
    return ledger.dispatchOutbox(async () => undefined);
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
        failure_message: providerFailureMessage(result.failure_code, result.status),
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

  const handler = observed(async (request, response) => {
    const authenticate = (req) => authenticateWithSlide(req, response, registryUrl, fetchImpl, portalState);
    const url = new URL(request.url ?? "/", "http://dashboard.local");
    const requestId = currentContext().request_id;
    if (url.pathname === "/v1/user/product-access" || url.pathname === DESKTOP_TOKEN_PATH) {
      response.__hatchCorsOrigin = "*";
    }
    try {
      if (request.method === "OPTIONS") return send(response, 204, undefined);
      response.__hatchRequestId = requestId;
      response.__includeRequestId = url.pathname.startsWith("/v1/");
      request.__oauthStateKey = oauthStateKey;
      response.setHeader("x-request-id", requestId);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return send(response, 200, { ok: true });
      }
      if (url.pathname === "/v1/web-chat/conversations" || url.pathname.startsWith("/v1/web-chat/conversations/") || ARTIFACT_DEFINITION_PATH.test(url.pathname) || PRODUCT_AGENT_PATH.test(url.pathname)) {
        if (!["GET", "POST", "PATCH"].includes(request.method)) {
          return send(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed." } });
        }
        const authentication = await chatAuthentication(request, authenticate);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        if (request.method !== "GET") {
          // A guest has no CSRF cookie, so its writes must come from one of our own pages.
          const csrfError = authentication.guest
            ? (allowedPublicOrigins.has(String(request.headers.origin ?? "")) ? undefined : { status: 403, body: { error: { code: "origin_not_allowed", message: "Open Hatch directly and try again." } } })
            : cookieCsrfError(request);
          if (csrfError) return send(response, csrfError.status, csrfError.body);
        }
        if (authentication.setCookie) response.setHeader("set-cookie", authentication.setCookie);
        const suffix = url.pathname.slice("/v1/web-chat".length);
        const upstreamUrl = new URL(`/v1${suffix}${url.search}`, runtimeUrl);
        // An asset upload is raw bytes streamed through, never parsed as JSON.
        const upload = request.method === "POST" && CONVERSATION_ASSET_UPLOAD_PATH.test(url.pathname);
        const contentType = String(request.headers["content-type"] ?? "application/octet-stream");
        const uploadLimit = contentType.startsWith("image/") ? WEB_CHAT_IMAGE_UPLOAD_MAX_BYTES : WEB_CHAT_FILE_UPLOAD_MAX_BYTES;
        if (upload) {
          const declared = Number(request.headers["content-length"]);
          if (!Number.isFinite(declared)) return send(response, 411, { error: { code: "length_required", message: "Upload length is required." } });
          if (declared > uploadLimit) return send(response, 413, { error: { code: "request_body_too_large", message: `Upload exceeds the ${uploadLimit}-byte limit.` } });
        }
        // A redirect (a report file signed by the object store) goes to the browser as it is: following it here would pull the bytes through this server.
        const upstream = await fetchImpl(upstreamUrl, {
          method: request.method,
          redirect: "manual",
          headers: {
            authorization: `Bearer ${authentication.token}`,
            ...(request.headers["idempotency-key"] ? { "idempotency-key": String(request.headers["idempotency-key"]) } : {}),
            ...(upload ? { "content-type": contentType, "content-length": request.headers["content-length"] } : request.method !== "GET" ? { "content-type": "application/json" } : {})
          },
          ...(upload ? { body: Readable.toWeb(request.pipe(byteLimit(uploadLimit))), duplex: "half" }
            : request.method !== "GET" ? { body: JSON.stringify(await readJson(request)) } : {})
        });
        response.statusCode = upstream.status;
        response.setHeader("cache-control", "no-store");
        if ([301, 302, 303, 307, 308].includes(upstream.status) && upstream.headers.get("location")) {
          response.setHeader("location", upstream.headers.get("location"));
          return response.end();
        }
        response.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
        else response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/web-chat/guest/carry-over") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        try {
          return send(response, 200, { moved: await carryOverGuest(request, response, authentication.token, authentication.profile.id) });
        } catch (error) {
          const payload = error.payload;
          return send(response, error.status ?? 502, payload?.error ? payload : { error: { code: "carry_over_failed", message: "The conversations could not be moved." } });
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/im-link/claim") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const token = String((await readJson(request)).token ?? "").trim();
        if (!token) return send(response, 400, { error: { code: "im_link_invalid", message: "A link token is required." } });
        const claimed = await registryRequest(registryUrl, "/v1/channels/im-link/claim", {
          method: "POST",
          fetchImpl,
          headers: { authorization: `Bearer ${authentication.token}` },
          body: JSON.stringify({ token })
        });
        // The claim is idempotent, so a failed save is answered as a failure and the client calls again.
        try {
          const saved = await library.saveToLibrary({ accountId: authentication.profile.id, productId: claimed.product_id });
          if (saved.created) track(authentication.profile.id, agentSaved(claimed.product_id));
        } catch (error) {
          if (!["agent_unavailable", "product_unavailable"].includes(error?.code)) {
            throw stateError("library_unavailable", "The Agent could not be added to your library. Try again.", 502);
          }
        }
        return send(response, 200, { product_id: claimed.product_id });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        try {
          if (draining) throw new Error("Dashboard is shutting down");
          if (process.env.NODE_ENV === "production"
            && (!registryDeploymentServiceToken || !commerceRuntimeServiceToken)) {
            throw new Error("Dashboard service credentials are not configured");
          }
          await ledger.ready?.();
          await portalState.ready?.();
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
      if (request.method === "POST" && url.pathname === "/api/contact") {
        const originError = crossSiteMutationError(request);
        if (originError) return send(response, originError.status, originError.body);
        const result = await submitContact(await readJson(request, 64 * 1024), { fetchImpl });
        return send(response, result.status, result.body);
      }
      if (url.pathname.startsWith("/v1/")) await portalState.refresh?.();
      if (request.method === "POST" && url.pathname === "/v1/provider-webhooks/payout") {
        if (!paymentProvider.configured) {
          return send(response, 404, { error: { code: "not_found", message: "Provider webhook route is not configured." } });
        }
        const rawBody = await readRawBody(request, DEFAULT_JSON_BODY_MAX_BYTES);
        const event = paymentProvider.verifyWebhook(rawBody, request.headers);
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
          failure_message: providerFailureMessage(event.failure_code, event.status),
          actor_id: current.provider,
          service_name: "payout-provider"
        });
        return send(response, 200, { received: true, payout });
      }
      if (url.pathname.startsWith("/v1/internal/library/") || url.pathname.startsWith("/v1/internal/access/")) {
        if (!commerceRuntimeServiceToken) {
          return send(response, 503, { error: { code: "commerce_service_unavailable", message: "Internal Commerce commands are not configured." } });
        }
        const serviceToken = bearerTokenFromAuthorization(request);
        if (!serviceToken || !safeEqual(serviceToken, commerceRuntimeServiceToken)) {
          return send(response, 403, { error: { code: "forbidden", message: "A Commerce Runtime service credential is required." } });
        }
        if (request.method === "POST" && url.pathname === "/v1/internal/library/save") {
          const body = await readJson(request);
          const accountId = String(body.account_id ?? "").trim();
          const productId = String(body.product_id ?? "").trim();
          if (!accountId || !UUID_V4_PATTERN.test(productId)) {
            return send(response, 400, { error: { code: "invalid_library_save", message: "account_id and a UUID v4 product_id are required." } });
          }
          const result = await library.saveToLibrary({ accountId, productId });
          if (result.created) track(accountId, agentSaved(productId));
          return send(response, 200, result);
        }
        const userAccessMatch = url.pathname.match(/^\/v1\/internal\/access\/users\/([^/]+)\/entitlements$/);
        if (request.method === "GET" && userAccessMatch) {
          const userId = decodeURIComponent(userAccessMatch[1]);
          const entitlements = commerce.listBuyerEntitlements(userId)
            .filter((entitlement) => entitlement.status === "active")
            .map((entitlement) => runtimeEntitlementBinding(entitlement, portalState));
          return send(response, 200, { entitlements });
        }
        return send(response, 404, { error: { code: "not_found", message: "Internal Commerce route not found." } });
      }
      if (url.pathname === "/portal" || url.pathname.startsWith("/portal/") || url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
        return send(response, 404, { error: { code: "route_not_found", message: "That route is no longer available." } });
      }
      if (request.method === "GET" && (url.pathname === "/favicon.svg" || url.pathname === "/assets" || url.pathname.startsWith("/assets/") || url.pathname === HATCH_CLI_DOWNLOAD)) {
        return servePortalAsset(url.pathname, response);
      }
      const retiredRedirect = request.method === "GET" ? retiredPortalRedirect(url.pathname) : null;
      if (retiredRedirect) {
        response.writeHead(301, { location: `${retiredRedirect}${url.search}`, "cache-control": "no-cache" });
        return response.end();
      }
      if (request.method === "GET" && url.pathname === "/sitemap.xml") {
        response.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
        return response.end(sitemapXml());
      }
      if (request.method === "GET" && url.pathname === "/robots.txt") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" });
        return response.end(robotsTxt());
      }
      const help = request.method === "GET" ? helpPage(url.pathname, request.headers["accept-language"], { mediaBase: process.env.HATCH_WEB_MEDIA_BASE_URL || undefined }) : null;
      if (help) return servePortalIndex(response, createDefaultMetadata(publicOrigin, "/explore"), help.status, undefined, help);
      if (request.method === "GET" && isPublicPortalRoute(url.pathname)) {
        let metadata = createDefaultMetadata(publicOrigin, "/explore");
        let portalStatus = 200;
        let noScriptFallback;
        const productRoute = url.pathname.match(/^\/products\/([^/]+)$/);
        const creatorRoute = url.pathname.match(/^\/creators\/([^/]+)$/);
        if (url.pathname.startsWith("/creators/") && !creatorRoute) {
          return send(response, 404, { error: { code: "creator_not_found", message: "Expert URL must use one UUID v4 segment." } });
        }
        if (creatorRoute && !UUID_V4_PATTERN.test(decodeURIComponent(creatorRoute[1]))) {
          return send(response, 404, { error: { code: "creator_not_found", message: "Expert URL must use a UUID v4." } });
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
              const product = publicCatalogAgent(agent, state);
              metadata = createProductMetadata({
                origin: publicOrigin,
                creatorId: agent.creator_id,
                productId: agent.product_id,
                routePrefix: "/products",
                productName: product.product_name ?? product.name,
                creatorName: product.creator_name,
                description: product.promise ?? product.description,
                imageUrl: product.image_url ?? product.presentation?.image_url
              });
              noScriptFallback = createProductNoScriptFallback({
                creatorId: product.creator_id,
                creatorName: product.creator_name,
                productId: product.product_id,
                productName: product.product_name ?? product.name,
                description: product.promise ?? product.description
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
      if (request.method === "GET" && url.pathname === "/v1/auth/providers") {
        const status = await registryRequest(registryUrl, "/v1/auth/providers", { fetchImpl }).catch(() => undefined);
        return send(response, 200, { providers: Array.isArray(status?.providers) ? status.providers.filter((kind) => LOGIN_KINDS.includes(kind)) : [] });
      }
      const login = request.method === "GET" ? url.pathname.match(/^\/v1\/auth\/([a-z]+)(?:\/(start|callback))?$/) : null;
      const loginKind = login && LOGIN_KINDS.includes(login[1]) ? login[1] : undefined;
      if (loginKind && !login[2]) {
        const status = await registryRequest(registryUrl, `/v1/auth/${loginKind}`, { fetchImpl }).catch(() => undefined);
        return send(response, 200, { enabled: status?.enabled === true });
      }
      if (loginKind && login[2] === "start") {
        try {
          const started = await registryRequest(registryUrl, `/v1/auth/${loginKind}/start`, {
            method: "POST",
            body: JSON.stringify({ claim: url.searchParams.get("claim") || undefined, return_to: safeLocalPath(url.searchParams.get("returnTo")) }),
            fetchImpl
          });
          response.setHeader("set-cookie", loginStateCookie(request, loginKind, started.state, 600));
          return redirect(response, started.authorize_url);
        } catch {
          return redirect(response, `/sign-in?${loginKind}=failed`);
        }
      }
      if (loginKind && login[2] === "callback") {
        const state = url.searchParams.get("state") ?? "";
        const expected = requestCookies(request).hatch_login_state ?? "";
        const clearState = loginStateCookie(request, loginKind, "", 0);
        try {
          if (!state || !expected || !safeEqual(state, expected) || url.searchParams.get("error")) throw new Error("login_state_rejected");
          // Someone already signed in keeps their account: the platform id is bound to it, and the Registry is told whose it is.
          const current = requestCookies(request).hatch_web_session ? (await authenticate(request)).token : undefined;
          const auth = await registryRequest(registryUrl, `/v1/auth/${loginKind}/callback`, {
            method: "POST",
            ...(current ? { headers: { authorization: `Bearer ${current}` } } : {}),
            body: JSON.stringify({ code: url.searchParams.get("code") ?? "", state }),
            fetchImpl
          });
          await startWebSession(request, response, auth, loginKind, auth.created === true);
          response.setHeader("set-cookie", [...response.getHeader("set-cookie"), clearState]);
          return redirect(response, safeLocalPath(auth.return_to));
        } catch {
          response.setHeader("set-cookie", clearState);
          return redirect(response, `/sign-in?${loginKind}=failed`);
        }
      }
      if (request.method === "POST" && ["/v1/auth/login", "/v1/auth/sign-in"].includes(url.pathname)) {
        const originError = crossSiteMutationError(request);
        if (originError) return send(response, originError.status, originError.body);
        const body = await readJson(request);
        const auth = await registryRequest(registryUrl, "/v1/auth/signin", {
          method: "POST",
          body: JSON.stringify({ email: body.email, password: body.password }),
          fetchImpl
        });
        const profile = await startWebSession(request, response, auth, "password");
        return send(response, 200, {
          ...(exposeBearerTokens ? { token: auth.token } : {}),
          profile
        });
      }
      if (request.method === "POST" && ["/v1/auth/signup", "/v1/auth/sign-up"].includes(url.pathname)) {
        const originError = crossSiteMutationError(request);
        if (originError) return send(response, originError.status, originError.body);
        const body = await readJson(request);
        const auth = await registryRequest(registryUrl, "/v1/auth/signup", {
          method: "POST",
          body: JSON.stringify({
            email: body.email,
            password: body.password,
            display_name: body.display_name
          }),
          fetchImpl
        });
        const profile = await startWebSession(request, response, auth, "password", true);
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
      if (url.pathname === "/v1/auth/me/avatar" && ["PUT", "DELETE"].includes(request.method)) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const csrfError = cookieCsrfError(request);
        if (csrfError) return send(response, csrfError.status, csrfError.body);
        const headers = { authorization: `Bearer ${authentication.token}` };
        const body = request.method === "PUT" ? await readRawBody(request, 5 * 1024 * 1024) : undefined;
        if (body) headers["content-type"] = request.headers["content-type"] ?? "application/octet-stream";
        const upstream = await fetchImpl(new URL("/v1/auth/me/avatar", registryUrl), {
          method: request.method,
          headers,
          ...(body ? { body } : {})
        });
        const payload = upstream.status === 204 ? undefined : await upstream.json();
        return send(response, upstream.status, upstream.ok ? publicProfile(payload) : payload);
      }
      if (request.method === "PATCH" && url.pathname === "/v1/auth/me") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const csrfError = cookieCsrfError(request);
        if (csrfError) return send(response, csrfError.status, csrfError.body);
        const body = await readJson(request);
        const account = await registryRequest(registryUrl, "/v1/auth/me", {
          method: "PATCH",
          fetchImpl,
          headers: { authorization: `Bearer ${authentication.token}` },
          // Forward only the account fields the Registry accepts and the client actually sent.
          body: JSON.stringify(Object.fromEntries(["display_name", "early_access"].filter((key) => key in body).map((key) => [key, body[key]])))
        });
        // The same account shape as GET /v1/auth/me: the Registry's account plus the web's presentation fields.
        return send(response, 200, { ...account, ...publicProfile(account) });
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        // One account shape for every client: Registry's account, plus the presentation fields the web adds.
        return send(response, 200, { ...authentication.account, ...authentication.profile });
      }
      if (url.pathname === "/v1/auth/me/avatar" && ["PUT", "DELETE"].includes(request.method)) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const csrfError = cookieCsrfError(request);
        if (csrfError) return send(response, csrfError.status, csrfError.body);
        const body = request.method === "PUT"
          ? await readRawBody(request, ACCOUNT_AVATAR_BODY_MAX_BYTES)
          : undefined;
        const upstream = await fetchImpl(new URL("/v1/auth/me/avatar", registryUrl), {
          method: request.method,
          headers: {
            authorization: `Bearer ${authentication.token}`,
            ...(request.method === "PUT" ? { "content-type": request.headers["content-type"] ?? "" } : {})
          },
          ...(body ? { body } : {})
        });
        const payload = upstream.status === 204 ? undefined : await upstream.json();
        return send(response, upstream.status, payload);
      }

      // API keys live in Registry; the cookie session reaches them through this proxy (CSRF checked by authenticate).
      if (/^\/v1\/auth\/api-keys(?:\/[^/]+)?$/.test(url.pathname) && ["GET", "POST", "DELETE"].includes(request.method)) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const body = request.method === "POST" ? await readJson(request) : undefined;
        const upstream = await fetchImpl(new URL(url.pathname, registryUrl), {
          method: request.method,
          headers: { authorization: `Bearer ${authentication.token}`, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
        response.setHeader("cache-control", "no-store");
        return send(response, upstream.status, upstream.status === 204 ? undefined : await upstream.json());
      }

      // What the Expert has spent lives in Registry's ledger; the cookie session reads it through this proxy.
      if (request.method === "GET" && url.pathname === "/v1/creator/usage") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const upstream = await fetchImpl(new URL(`${url.pathname}${url.search}`, registryUrl), { headers: { authorization: `Bearer ${authentication.token}` } });
        response.setHeader("cache-control", "no-store");
        return send(response, upstream.status, await upstream.json());
      }

      if (await desktopSignIn(request, response, url)) return;

      // Browser OAuth is an authorization-code + PKCE bridge to the existing
      // Hatch web session. External Creator tools can request access, but only
      // a Creator already signed in to Hatch can approve it in this browser.
      if (request.method === "GET" && url.pathname === "/v1/auth/authorize") {
        const clientId = String(url.searchParams.get("client_id") ?? "").trim();
        const redirectUri = String(url.searchParams.get("redirect_uri") ?? "").trim();
        const responseType = String(url.searchParams.get("response_type") ?? "").trim();
        const codeChallenge = String(url.searchParams.get("code_challenge") ?? "").trim();
        const challengeMethod = String(url.searchParams.get("code_challenge_method") ?? "").trim();
        const state = String(url.searchParams.get("state") ?? "").trim();
        const requestedScopes = parseOAuthScopes(url.searchParams.get("scope"));
        validateOAuthAuthorizationRequest({ clientId, redirectUri, responseType, codeChallenge, challengeMethod, state, scopes: requestedScopes });
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const transactionId = `oauth_tx_${randomId()}`;
        const csrfToken = requestCookies(request).hatch_web_csrf ?? "";
        await portalState.saveOAuthAuthorizationTransaction({
          id: transactionId,
          clientId,
          redirectUri,
          state,
          codeChallenge,
          scopes: requestedScopes,
          registryTokenCiphertext: encryptOAuthSecret(authentication.token, oauthStateKey),
          profile: authentication.profile,
          webSessionId: requestCookies(request).hatch_web_session,
          csrfToken,
          expiresAt: Date.now() + 5 * 60_000
        });
        return sendHtml(response, 200, oauthConsentPage({
          transactionId,
          csrfToken,
          profile: authentication.profile,
          clientId,
          scopes: requestedScopes
        }));
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/authorize/consent") {
        const form = await readForm(request, 64 * 1024);
        const transactionId = String(form.transaction_id ?? "").trim();
        const transaction = portalState.getOAuthAuthorizationTransaction(transactionId);
        if (!transaction || transaction.expiresAt <= Date.now()) {
          await portalState.deleteOAuthAuthorizationTransaction(transactionId);
          return send(response, 400, { error: { code: "oauth_transaction_expired", message: "This authorization request expired. Start again." } });
        }
        const cookies = requestCookies(request);
        if (!transaction.webSessionId || cookies.hatch_web_session !== transaction.webSessionId
          || !transaction.csrfToken || !safeEqual(String(form.csrf_token ?? ""), transaction.csrfToken)
          || !safeEqual(cookies.hatch_web_csrf ?? "", transaction.csrfToken)) {
          return send(response, 403, { error: { code: "csrf_rejected", message: "Refresh the page and try again." } });
        }
        await portalState.deleteOAuthAuthorizationTransaction(transactionId);
        const redirect = new URL(transaction.redirectUri);
        // OAuth clients use state to bind the browser callback to the pending
        // login. Preserve it on both approval and denial responses.
        redirect.searchParams.set("state", transaction.state);
        const decision = String(form.decision ?? "deny").toLowerCase();
        if (decision !== "approve") {
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("error_description", "The Expert did not approve access.");
        } else {
          const code = `oauth_code_${randomId()}`;
          await portalState.saveOAuthAuthorizationCode(oauthTokenDigest(code), {
            code,
            clientId: transaction.clientId,
            redirectUri: transaction.redirectUri,
            state: transaction.state,
            codeChallenge: transaction.codeChallenge,
            scopes: transaction.scopes,
            registryTokenCiphertext: transaction.registryTokenCiphertext,
            profile: transaction.profile,
            expiresAt: Date.now() + 60_000,
            used: false
          });
          redirect.searchParams.set("code", code);
        }
        response.statusCode = 302;
        response.setHeader("cache-control", "no-store");
        response.setHeader("location", redirect.toString());
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/token") {
        const form = await readForm(request, 64 * 1024);
        const grantType = String(form.grant_type ?? "").trim();
        const clientId = String(form.client_id ?? "").trim();
        if (!oauthClientAllowed(clientId)) return send(response, 400, { error: "invalid_client", error_description: "Unknown OAuth client." });
        if (grantType === "authorization_code") {
          const codeValue = String(form.code ?? "").trim();
          const code = portalState.getOAuthAuthorizationCode(oauthTokenDigest(codeValue));
          const redirectUri = String(form.redirect_uri ?? "").trim();
          const verifier = String(form.code_verifier ?? "").trim();
          if (!code || code.used || code.expiresAt <= Date.now() || code.clientId !== clientId
            || code.redirectUri !== redirectUri || !validPkceVerifier(verifier)
            || !safeEqual(pkceChallenge(verifier), code.codeChallenge)) {
            return send(response, 400, { error: "invalid_grant", error_description: "Authorization code or PKCE verifier is invalid." });
          }
          const consumed = await portalState.consumeOAuthAuthorizationCode(oauthTokenDigest(codeValue));
          if (!consumed) {
            return send(response, 400, { error: "invalid_grant", error_description: "Authorization code or PKCE verifier is invalid." });
          }
          return send(response, 200, await issueOAuthTokens(consumed, portalState, oauthStateKey));
        }
        if (grantType === "refresh_token") {
          const refreshToken = String(form.refresh_token ?? "").trim();
          const refreshDigest = oauthTokenDigest(refreshToken);
          const record = portalState.getOAuthRefreshToken(refreshDigest);
          if (!record || record.expiresAt <= Date.now() || record.clientId !== clientId) {
            return send(response, 400, { error: "invalid_grant", error_description: "Refresh token is invalid or expired." });
          }
          await portalState.deleteOAuthRefreshToken(refreshDigest);
          return send(response, 200, await issueOAuthTokens(record, portalState, oauthStateKey));
        }
        return send(response, 400, { error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token." });
      }

      if (request.method === "GET" && url.pathname === "/v1/public/products") {
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const buyer = await optionalAccount(request, authenticate);
        const sourceEntitlements = buyer ? commerce.listBuyerEntitlements(buyer.id) : [];
        const creatorNames = await resolveCreatorNames(sourceEntitlements.map((entry) => entry.creator_id));
        const entitlements = buyer ? enrichEntitlements(sourceEntitlements, catalog, [], creatorNames) : [];
        // Unlisted Agents stay reachable by link but leave every listing.
        const visible = catalog.filter((agent) => agent.listed !== false && portalState.getCreatorProduct(agent.creator_id, agent.product_id)?.status !== "withdrawn");
        const products = await Promise.all(visible.map(async (agent) => {
          const state = portalState.getCreatorProduct(agent.creator_id, agent.product_id);
          return withBuyerAccess(
            publicCatalogAgent(agent, state),
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
        if (!UUID_V4_PATTERN.test(creatorSelector)) return send(response, 404, { error: { code: "creator_not_found", message: "Expert was not found." } });
        const creatorProducts = catalog.filter((entry) => (
          String(entry.creator_id) === String(creatorSelector)
          && entry.listed !== false
          && portalState.getCreatorProduct(entry.creator_id, entry.product_id)?.status !== "withdrawn"
        ));
        if (!creatorProducts.length) return send(response, 404, { error: { code: "creator_not_found", message: "Expert was not found." } });
        const products = await Promise.all(creatorProducts.map(async (entry) => {
          const state = portalState.getCreatorProduct(entry.creator_id, entry.product_id);
          return publicCatalogAgent(entry, state);
        }));
        const first = products[0];
        return send(response, 200, {
          creator: {
            id: first.creator_id,
            name: first.creator_name,
            avatar_url: first.creator_avatar_url ?? first.creator?.avatar_url ?? null,
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
        const buyer = await optionalAccount(request, authenticate);
        const sourceEntitlements = buyer ? commerce.listBuyerEntitlements(buyer.id) : [];
        const creatorNames = await resolveCreatorNames(sourceEntitlements.map((entry) => entry.creator_id));
        const entitlements = buyer ? enrichEntitlements(sourceEntitlements, catalog, [], creatorNames) : [];
        return send(response, 200, {
          product: withBuyerAccess(
            publicCatalogAgent(agent, creatorState),
            entitlements
          )
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/user/product-access") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const activeEntitlements = commerce.listBuyerEntitlements(authentication.profile.id).filter((entry) => entry.status === "active");
        const creatorNames = await resolveCreatorNames(activeEntitlements.map((entry) => entry.creator_id));
        const entitlements = enrichEntitlements(activeEntitlements, catalog, [], creatorNames);
        // A withdrawn Agent is not chat-able: it leaves this list like it leaves the library.
        const creatorAgents = entitlements.filter((entry) => catalog.some((product) => (
          product.creator_id === entry.creator_id && product.product_id === entry.product_id
        ))).map((entry) => ({
          ...entry,
          user_id: entry.buyer_id,
          agent_id: entry.product_id,
          creator: entry.creator,
          product: entry.product,
          presentation: catalog.find((product) => (
            product.creator_id === entry.creator_id && product.product_id === entry.product_id
          ))?.presentation ?? {}
        }));
        // Owned published Products come first and carry no entitlement_id: the
        // owner chats by product_id. Acquired Agents follow as entitlements.
        const ownedAgents = catalog
          .filter((product) => (
            product.creator_id === authentication.profile.id
            && portalState.getCreatorProduct(product.creator_id, product.product_id)?.status !== "withdrawn"
          ))
          .map((product) => ({
            creator_id: product.creator_id,
            product_id: product.product_id,
            agent_id: product.product_id,
            corpus_digest: product.corpus_digest,
            effective_corpus_digest: product.corpus_digest,
            creator: {
              id: product.creator_id,
              name: authentication.profile.display_name,
              avatar_url: authentication.profile.avatar_url
            },
            product: {
              id: product.product_id,
              product_id: product.product_id,
              name: product.product_name,
              description: product.product_description,
              promise: product.product_promise,
              ...(product.brief_spec ? { brief_spec: structuredClone(product.brief_spec) } : {})
            },
            // Same task brief as an acquired row: the Runtime requires its answers.
            ...(product.brief_spec ? { brief_spec: structuredClone(product.brief_spec) } : {}),
            presentation: product.presentation ?? {}
          }));
        return send(response, 200, { creator_agents: [...ownedAgents, ...creatorAgents] });
      }

      // Local development object store: the browser PUTs the file here and it streams on to the Registry, never buffered.
      if (request.method === "PUT" && url.pathname.startsWith("/v1/local-objects/")) {
        const upstream = await fetchImpl(new URL(`${url.pathname}${url.search}`, registryUrl), {
          method: "PUT",
          headers: Object.fromEntries(["content-type", "content-length"].flatMap(name => request.headers[name] ? [[name, String(request.headers[name])]] : [])),
          body: Readable.toWeb(request),
          duplex: "half"
        });
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        return response.end(Buffer.from(await upstream.arrayBuffer()));
      }

      const productContractPath = url.pathname.match(/^\/v1\/creator\/products(?:\/[^/]+(?:\/ingest(?:\/[^/]+)?|\/brief-spec|\/registry|\/live|\/withdraw|\/listing|\/pricing)?)?$/);
      const productRegistryContract = /\/registry$/.test(url.pathname);
      const productLiveContract = /\/live$/.test(url.pathname);
      const productContractWrite = productContractPath && (
        request.method === "POST" || request.method === "PATCH" || request.method === "PUT"
      ) && (
        url.pathname === "/v1/creator/products"
        || /\/(brief-spec|pricing|ingest|ingest\/uploads)$/.test(url.pathname)
        || /\/withdraw$/.test(url.pathname)
        || /\/listing$/.test(url.pathname)
        || productRegistryContract
        || productLiveContract
        || /^\/v1\/creator\/products\/[^/]+$/.test(url.pathname)
      );
      const productContractDelete = productContractPath
        && request.method === "DELETE"
        && /^\/v1\/creator\/products\/[^/]+$/.test(url.pathname);
      const productContractRead = productContractPath && request.method === "GET" && (
        url.pathname === "/v1/creator/products"
        || /^\/v1\/creator\/products\/[^/]+$/.test(url.pathname)
        || /\/ingest(?:\/[^/]+)?$/.test(url.pathname)
        || productLiveContract
      );
      if (productContractWrite || productContractRead || productContractDelete) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const isProductRoot = url.pathname === "/v1/creator/products" || /^\/v1\/creator\/products\/[^/]+$/.test(url.pathname);
        const requiredScope = isProductRoot
          ? (request.method === "GET" ? "creator:products:read" : "creator:products:write")
          : (url.pathname.includes("/ingest")
            ? (request.method === "GET" ? "creator:files:read" : "creator:files:write")
            : (request.method === "GET" ? "creator:products:read" : "creator:products:write"));
        requireOAuthScope(request, requiredScope, url.pathname);
        const body = request.method === "GET" || request.method === "DELETE"
          ? undefined
          : JSON.stringify(await readJson(request, url.pathname.includes("/ingest") ? CREATOR_INGEST_JSON_BODY_MAX_BYTES : factoryRequestMaxBytes));
        const payload = await registryRequest(registryUrl, `${url.pathname}${url.search}`, {
          method: request.method,
          ...(body === undefined ? {} : { body }),
          fetchImpl,
          headers: {
            authorization: `Bearer ${bearerToken(request)}`,
            ...(request.headers["idempotency-key"] ? { "idempotency-key": String(request.headers["idempotency-key"]) } : {})
          }
        });
        const status = request.method === "DELETE"
          ? 204
          : request.method === "POST"
            ? (url.pathname.endsWith("/ingest") ? 202 : 201)
            : 200;
        return send(response, status, payload);
      }

      if (request.method === "GET" && url.pathname === "/v1/creator/products") {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        requireOAuthScope(request, "creator:products:read", url.pathname);
        return send(response, 200, await registryRequest(registryUrl, "/v1/creator/products", {
          fetchImpl,
          headers: { authorization: `Bearer ${bearerToken(request)}` }
        }));
      }

      if (/^\/v1\/creator\/products\/[^/]+\/factory-agents(?:\/|$)/.test(url.pathname) || /^\/v1\/creator\/(?:assistant|connections)(?:\/|$)/.test(url.pathname) || CONVERSATION_PATH.test(url.pathname) || (request.method === "POST" && url.pathname === "/v1/transcriptions")) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const abort = new AbortController();
        response.once("close", () => abort.abort());
        // An upload is the file itself, as the conversation API takes it; every other body is JSON.
        const upload = request.method === "POST" && CONVERSATION_UPLOAD_PATH.test(url.pathname);
        try {
          const upstream = await fetchImpl(new URL(url.pathname + url.search, registryUrl), {
            method: request.method,
            headers: {
              authorization: `Bearer ${authentication.token}`, "content-type": upload ? request.headers["content-type"] ?? "application/octet-stream" : "application/json",
              // The conversation API's resume and idempotency contracts travel in headers.
              ...Object.fromEntries(["accept", "last-event-id", "idempotency-key"].flatMap(name => request.headers[name] ? [[name, String(request.headers[name])]] : [])),
            },
            ...(request.method === "GET" ? {} : { body: upload ? await readRawBody(request, factoryRequestMaxBytes) : JSON.stringify(await readJson(request, factoryRequestMaxBytes)) }),
            signal: abort.signal,
            redirect: "error"
          });
          response.statusCode = upstream.status;
          for (const name of ["content-type", "content-disposition", "cache-control"]) {
            const value = upstream.headers.get(name);
            if (value) response.setHeader(name, value);
          }
          if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
            response.setHeader("x-accel-buffering", "no");
            response.flushHeaders();
          }
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
          else response.end();
          return;
        } catch (error) {
          // Switching chats closes the browser stream. pipeline destroys the
          // response on disconnect; a second JSON response would crash Node.
          if (abort.signal.aborted || response.destroyed) return;
          throw error;
        }
      }

      if (url.pathname.startsWith("/v1/creator/")) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const profile = authentication.profile;
        const projection = commerce.getCreatorDashboard(profile.id);
        let creatorAgentsPromise;
        const creatorAgents = async () => {
          creatorAgentsPromise ??= registryRequest(registryUrl, "/v1/creator/products", {
            fetchImpl,
            headers: { authorization: `Bearer ${bearerToken(request)}` }
          });
          const agents = await creatorAgentsPromise;
          return Array.isArray(agents) ? agents : Array.isArray(agents?.products) ? agents.products : [];
        };
        const creatorProducts = async () => {
          const agents = await creatorAgents();
          return creatorProductViews(agents, portalState.listCreatorProducts(profile.id))
            .map((product) => ({ ...product, access: { mode: "free", included_deliveries: 1 } }));
        };
        if (request.method === "GET" && url.pathname === "/v1/creator/me") {
          return send(response, 200, publicProfile(profile));
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/overview") {
          return send(response, 200, {
            metrics: projection.metrics,
            products: await creatorProducts()
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/users") {
          const query = new URLSearchParams([...url.searchParams].filter(([name]) => name === "product_id" || name === "limit"));
          const upstream = await fetchImpl(new URL(`/v1/creator/audience?${query}`, runtimeUrl), { headers: { authorization: `Bearer ${bearerToken(request)}` } });
          const payload = await upstream.json().catch(() => ({}));
          if (!upstream.ok) return send(response, upstream.status, payload?.error ? payload : { error: { code: "audience_unavailable", message: "Users could not be loaded." } });
          const audience = Array.isArray(payload.audience) ? payload.audience : [];
          const names = await resolveCreatorNames(audience.map((entry) => entry.account_id));
          return send(response, 200, {
            users: audience.map((entry) => ({
              kind: entry.kind,
              ...(entry.kind === "account" && names.get(entry.account_id) ? { display_name: names.get(entry.account_id) } : {}),
              product_id: entry.product_id,
              conversations: entry.conversations,
              messages: entry.messages,
              first_at: entry.first_at,
              last_at: entry.last_at
            }))
          });
        }
        if (request.method === "GET" && url.pathname === "/v1/creator/products") {
          return send(response, 200, { products: await creatorProducts() });
        }

        const creatorProductMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)$/);
        if (request.method === "GET" && creatorProductMatch) {
          const product = (await creatorProducts()).find((entry) => entry.product_id === decodeURIComponent(creatorProductMatch[1]));
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          return send(response, 200, { product });
        }

        const creatorReleasesMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/releases$/);
        if (request.method === "GET" && creatorReleasesMatch) {
          const productId = decodeURIComponent(creatorReleasesMatch[1]);
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          const releases = Array.isArray(product.releases) ? product.releases : [];
          return send(response, 200, { releases, active_release: product.release ?? product.active_release ?? null });
        }

        const withdrawMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/withdraw$/);
        if (request.method === "POST" && withdrawMatch) {
          const body = await readJson(request);
          const commandKey = requireCommandKey(request, body);
          const productId = decodeURIComponent(withdrawMatch[1]);
          const state = await portalState.withdrawProduct(profile.id, productId, body.expected_version, {
            ...body,
            command_key: commandKey
          });
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          return send(response, 200, { product: creatorProductView(product, state), withdrawn_at: state.withdrawn_at });
        }

        const previewMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/storefront-preview$/);
        if (request.method === "GET" && previewMatch) {
          const productId = decodeURIComponent(previewMatch[1]);
          const product = (await creatorProducts()).find((entry) => entry.product_id === productId);
          if (!product) return send(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
          const state = portalState.getCreatorProduct(profile.id, productId);
          return send(response, 200, storefrontPreview(product, profile, state));
        }

        if (request.method === "GET" && url.pathname === "/v1/creator/payouts") {
          const currency = normalizedCurrency(url.searchParams.get("currency") ?? "USD");
          return send(response, 200, creatorPayoutView(commerce, profile.id, currency, paymentProvider, payoutSchedule));
        }
        const payoutDetailMatch = url.pathname.match(/^\/v1\/creator\/payouts\/([^/]+)$/);
        if (request.method === "GET" && payoutDetailMatch) {
          const payout = commerce.getPayout(decodeURIComponent(payoutDetailMatch[1]));
          if (!payout || payout.creator_id !== profile.id) {
            return send(response, 404, { error: { code: "payout_not_found", message: "Payout was not found." } });
          }
          return send(response, 200, { payout, balance: commerce.getPayoutBalance(profile.id, payout.currency) });
        }
        if (request.method === "POST" && url.pathname === "/v1/creator/payout-account-sessions") {
          const body = await readJson(request);
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
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const catalog = await authoritativeCatalog(registryUrl, fetchImpl, portalState);
        const status = url.searchParams.get("status");
        const sourceEntitlements = commerce.listBuyerEntitlements(authentication.profile.id);
        const creatorNames = await resolveCreatorNames(sourceEntitlements.map((entry) => entry.creator_id));
        const entitlements = enrichEntitlements(
          sourceEntitlements,
          catalog,
          commerce.listDeliveries({ buyerId: authentication.profile.id }),
          creatorNames
        )
          .filter((entitlement) => entitlementMatchesStatus(entitlement, status))
          // The web Library lists only Agents still offered; desktop routes keep every entitlement.
          .filter((entitlement) => url.pathname !== "/v1/library" || isOfferedProduct(entitlement, catalog, portalState))
          .sort(compareEntitlementsNewestFirst);
        const page = paginate(entitlements, url);
        return send(response, 200, {
          buyer_id: authentication.profile.id,
          entitlements: page.items,
          next_cursor: page.next_cursor
        });
      }

      const libraryIdMatch = url.pathname.match(/^\/v1\/library\/([^/]+)$/);
      if (request.method === "DELETE" && libraryIdMatch) {
        const authentication = await authenticate(request);
        if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
        const productId = decodeURIComponent(libraryIdMatch[1]);
        const result = await library.removeFromLibrary({ accountId: authentication.profile.id, productId });
        if (result.removed) track(authentication.profile.id, agentRemoved(productId));
        return send(response, 200, result);
      }
      return send(response, 404, { error: { code: "not_found", message: "Route not found." } });
    } catch (error) {
      const failure = publicRequestError(error);
      return send(response, failure.status, { error: failure.error });
    }
  });

  const handleUpgrade = async (request, socket, head) => {
    request.__oauthStateKey = oauthStateKey;
    const url = new URL(request.url ?? "/", publicOrigin);
    if (url.pathname === "/v1/web-chat/runtime") {
      let origin;
      try { origin = request.headers.origin ? new URL(request.headers.origin).origin : ""; }
      catch { origin = ""; }
      if (!allowedPublicOrigins.has(origin)) {
        throw Object.assign(new Error("Cross-origin WebSocket request rejected"), { status: 403 });
      }
      const authentication = await chatAuthentication(request);
      if (authentication.error) throw Object.assign(new Error("Sign in to continue."), { status: authentication.error.status });
      // A guest that arrives without a cookie keeps the one minted for it here.
      if (authentication.setCookie) chatWss.once("headers", headers => headers.push(`Set-Cookie: ${authentication.setCookie}`));
      chatWss.handleUpgrade(request, socket, head, browser => {
        new WebChatRuntimeBridge({ browser, runtimeUrl, token: authentication.token, requestId: requestIdFrom(request.headers["x-request-id"]) }).connect();
      });
      return;
    }
    const studio = url.pathname === "/v1/creator/studio/ws";
    if (!studio) {
      throw Object.assign(new Error("Unknown WebSocket route"), { status: 404 });
    }
    let requestOrigin;
    try { requestOrigin = request.headers.origin ? new URL(request.headers.origin).origin : ""; } catch { requestOrigin = ""; }
    // Studio's WebSocket also serves API keys, which carry no cookie and so need no origin: they sign in with a bearer header or the first message.
    const apiKeyClient = studio && !request.headers.cookie;
    if (!apiKeyClient && (!requestOrigin || !allowedPublicOrigins.has(requestOrigin))) {
      throw Object.assign(new Error("Cross-origin WebSocket request rejected"), { status: 403 });
    }
    const authentication = apiKeyClient && !bearerTokenFromAuthorization(request)
      ? {}
      : await authenticateRequest(request, registryUrl, fetchImpl, portalState);
    if (authentication.error) throw Object.assign(new Error(authentication.error.body?.error?.message || "Sign in to continue."), { status: authentication.error.status });
    studioWss.handleUpgrade(request, socket, head, browser => {
      browser.on("error", () => undefined);
      const upstreamUrl = new URL(url.pathname + url.search, registryUrl);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      const upstream = new WebSocket(upstreamUrl, {
        headers: authentication.token ? { authorization: `Bearer ${authentication.token}` } : {},
        handshakeTimeout: 20_000,
        maxPayload: 128 * 1024,
      });
      const pending = [];
      let pendingBytes = 0;
      const close = (code = 1000, reason = "Studio session ended") => {
        if (browser.readyState === WebSocket.OPEN) browser.close(code, reason);
        else if (browser.readyState === WebSocket.CONNECTING) browser.terminate();
        if (upstream.readyState === WebSocket.OPEN) upstream.close(code, reason);
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      };
      browser.on("message", (data, binary) => {
        const bytes = data.byteLength;
        if (upstream.readyState === WebSocket.OPEN) { upstream.send(data, { binary }); return; }
        pendingBytes += bytes;
        if (pendingBytes > 512 * 1024) { close(1009, "Studio input buffer exceeded"); return; }
        pending.push({ data, binary });
      });
      upstream.once("open", () => {
        for (const entry of pending.splice(0)) upstream.send(entry.data, { binary: entry.binary });
        pendingBytes = 0;
      });
      upstream.on("message", (data, binary) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary });
      });
      upstream.on("error", error => {
        if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ type: "error", message: error.message }));
        close(1011, "Studio upstream failed");
      });
      upstream.on("close", (code, reason) => close(code || 1000, reason.toString() || "Studio upstream closed"));
      browser.on("close", (code, reason) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close(code || 1000, reason.toString());
        else upstream.terminate();
      });
    });
  };

  return {
    handler,
    handleUpgrade,
    beginDrain: () => { draining = true; },
    // A clean close first: the browser reconnects to the next instance. A peer that does not answer is cut after a second.
    closeSockets: () => {
      for (const socket of [...studioWss.clients, ...chatWss.clients]) {
        socket.close(1001, "server restarting: reconnect");
        setTimeout(() => socket.terminate(), 1_000).unref();
      }
      studioWss.close();
      chatWss.close();
    },
    ledger,
    commerce,
    portalState,
    analytics,
    dispatchCommerceOutbox,
    reconcilePayouts,
    reconcileFinance
  };
}

export async function startDashboardServer(options = {}) {
  const app = await createDashboardApp(options);
  const port = Number(options.port ?? process.env.HATCH_CREATOR_DASHBOARD_API_PORT ?? 8500);
  const host = options.host ?? process.env.HATCH_CREATOR_DASHBOARD_API_HOST ?? "127.0.0.1";
  const server = createServer(app.handler);
  const inflight = new InflightResponses();
  server.on("request", (_request, response) => inflight.track(response));
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => undefined);
    void app.handleUpgrade(request, socket, head).catch(error => {
      if (socket.destroyed) return;
      const status = Number(error?.status) || 400;
      const label = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Bad Request";
      socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const outboxTimer = setInterval(() => {
    app.dispatchCommerceOutbox().catch(() => undefined);
  }, 2_000);
  outboxTimer.unref?.();
  const financeTimer = setInterval(() => {
    app.reconcileFinance().catch(() => undefined);
  }, 30_000);
  financeTimer.unref?.();
  const stopTimers = () => [outboxTimer, financeTimer].forEach(clearInterval);
  let released;
  const release = () => released ??= (async () => {
    stopTimers();
    app.closeSockets();
    await Promise.allSettled([app.ledger.close?.(), app.portalState.close?.(), app.analytics.shutdown(3_000)]);
  })();
  server.once("close", () => void release());
  let serverClosed;
  const stopIntake = async () => {
    stopTimers();
    serverClosed ??= new Promise(resolve => server.close(resolve));
  };
  const shutdown = deadlineMs => gracefulShutdown({
    deadlineMs,
    markUnready: app.beginDrain,
    stopIntake,
    drain: () => inflight.requestsDone(),
    closeConnections: async () => { inflight.endAll(); app.closeSockets(); },
    closeStorage: async () => { server.closeAllConnections(); await serverClosed; await release(); },
    onError: (step, error) => logEvent("error", "shutdown_step_failed", { message: `${step}: ${error instanceof Error ? error.message : String(error)}` })
  });
  app.dispatchCommerceOutbox().catch(() => undefined);
  app.reconcileFinance().catch(() => undefined);
  return { ...app, server, port, host, shutdown };
}

async function registryRequest(registryUrl, pathname, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { fetchImpl: _fetchImpl, ...requestOptions } = options;
  const response = await fetchImpl(new URL(pathname, registryUrl), {
    ...requestOptions,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) }
  });
  const payload = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? payload?.detail ?? "Registry rejected the Agent request.");
    error.status = response.status;
    error.code = payload?.error?.code ?? payload?.code ?? "registry_rejected_agent_request";
    if (payload?.error?.details !== undefined) error.details = payload.error.details;
    else if (payload?.details !== undefined) error.details = payload.details;
    throw error;
  }
  return payload;
}


function oauthClientAllowed(clientId) {
  const configured = String(process.env.HATCH_OAUTH_CLIENT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([DEFAULT_OAUTH_CLIENT_ID, ...configured]).has(clientId);
}

function parseOAuthScopes(value) {
  const requested = String(value ?? "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  const scopes = requested.length ? [...new Set(requested)] : [...DEFAULT_OAUTH_SCOPES];
  if (!scopes.every((scope) => DEFAULT_OAUTH_SCOPES.includes(scope))) {
    const error = new Error("Requested OAuth scope is not available.");
    error.status = 400;
    throw error;
  }
  return scopes;
}

function validateOAuthAuthorizationRequest({ clientId, redirectUri, responseType, codeChallenge, challengeMethod, state, scopes }) {
  if (!oauthClientAllowed(clientId)) {
    const error = new Error("Unknown OAuth client.");
    error.status = 400;
    throw error;
  }
  if (responseType !== "code" || !state || !validPkceChallenge(codeChallenge) || challengeMethod !== "S256") {
    const error = new Error("OAuth authorization requires response_type=code, state, and S256 PKCE.");
    error.status = 400;
    throw error;
  }
  let parsed;
  try { parsed = new URL(redirectUri); } catch {
    const error = new Error("OAuth redirect_uri is invalid.");
    error.status = 400;
    throw error;
  }
  if (!isLoopbackOAuthRedirect(parsed) || !Array.isArray(scopes) || !scopes.length) {
    const error = new Error("OAuth redirect_uri must be a loopback /oauth/callback URL.");
    error.status = 400;
    throw error;
  }
}

function isLoopbackOAuthRedirect(url) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.pathname === "/oauth/callback"
    && Boolean(url.port)
    && !url.hash
    && !url.username
    && !url.password;
}

function validPkceChallenge(value) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(String(value ?? ""));
}

function validPkceVerifier(value) {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(String(value ?? ""));
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function issueOAuthTokens(record, portalState, oauthStateKey) {
  const accessToken = `hatch_at_${randomId()}${randomId()}`;
  const refreshToken = `hatch_rt_${randomId()}${randomId()}`;
  const now = Date.now();
  decryptOAuthSecret(record.registryTokenCiphertext, oauthStateKey);
  const accessRecord = {
    registryTokenCiphertext: record.registryTokenCiphertext,
    clientId: record.clientId,
    scopes: [...record.scopes],
    expiresAt: now + 15 * 60_000
  };
  const refreshRecord = {
    registryTokenCiphertext: record.registryTokenCiphertext,
    clientId: record.clientId,
    scopes: [...record.scopes],
    expiresAt: now + 30 * 24 * 60 * 60_000
  };
  await portalState.saveOAuthAccessToken(oauthTokenDigest(accessToken), accessRecord);
  await portalState.saveOAuthRefreshToken(oauthTokenDigest(refreshToken), refreshRecord);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 900,
    refresh_token: refreshToken,
    scope: record.scopes.join(" ")
  };
}

async function activeOAuthAccessToken(token, portalState, oauthStateKey) {
  const tokenDigest = oauthTokenDigest(token);
  const record = portalState.getOAuthAccessToken(tokenDigest);
  if (!record) return undefined;
  if (record.expiresAt <= Date.now()) {
    await portalState.deleteOAuthAccessToken(tokenDigest);
    return undefined;
  }
  return {
    ...record,
    registryToken: decryptOAuthSecret(record.registryTokenCiphertext, oauthStateKey)
  };
}

function oauthTokenDigest(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function resolveOAuthStateKey(configured, portalStatePath) {
  const secret = String(configured ?? "").trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("HATCH_OAUTH_STATE_KEY (or HATCH_SESSION_SECRET) is required in production.");
  }
  return createHash("sha256")
    .update(secret || `development-only:${portalStatePath}`)
    .digest();
}

function encryptOAuthSecret(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptOAuthSecret(value, key) {
  const [version, ivValue, tagValue, ciphertextValue] = String(value ?? "").split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("OAuth secret is not a valid encrypted value.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

/** Conversation API: a Product's workers and the Assistant's conversation. Streamed through to Registry as is. */
const CONVERSATION_PATH = /^\/v1\/creator\/(?:products\/[^/]+\/workers(?:\/[^/]+\/(?:messages|events|stop|snapshot))?|assistant\/conversation\/(?:messages|events|stop|snapshot|retry|view|timezone|assets(?:\/[^/]+)?))$/;
const CONVERSATION_UPLOAD_PATH = /^\/v1\/creator\/assistant\/conversation\/assets$/;

function oauthEndpointScope(request) {
  const method = String(request.method ?? "GET").toUpperCase();
  const pathname = new URL(request.url ?? "/", "http://dashboard.local").pathname;
  if (method === "GET" && pathname === "/v1/auth/me") return "creator:products:read";
  if (pathname === "/v1/creator/products") {
    if (method === "GET") return "creator:products:read";
    if (method === "POST") return "creator:products:write";
    return undefined;
  }
  const productMatch = pathname.match(/^\/v1\/creator\/products\/[^/]+$/);
  if (productMatch) {
    if (method === "GET") return "creator:products:read";
    if (method === "PATCH") return "creator:products:write";
    return undefined;
  }
  if (pathname === "/v1/creator/studio/ws") return "creator:products:read";
  if (CONVERSATION_PATH.test(pathname)) return method === "GET" ? "creator:products:read" : method === "POST" || method === "PUT" ? "creator:products:write" : undefined;
  const ingestMatch = pathname.match(/^\/v1\/creator\/products\/[^/]+\/ingest(?:\/[^/]+)?$/);
  if (ingestMatch) {
    if (method === "GET") return "creator:files:read";
    if (method === "POST" && (pathname.endsWith("/ingest") || pathname.endsWith("/ingest/uploads"))) return "creator:files:write";
  }
  return undefined;
}

function oauthConsentPage({ transactionId, csrfToken, profile, clientId, scopes }) {
  const displayName = escapeHtml(profile?.display_name ?? "your Hatch account");
  const scopeText = scopes.map((scope) => `<li>${escapeHtml(oauthScopeLabel(scope))}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Hatch</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f5f1e9;color:#171513;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fffdf8;border:1px solid #ded6c8;border-radius:20px;max-width:520px;padding:32px;box-shadow:0 20px 60px #2a241610}h1{font-size:28px;margin:0 0 10px}p{line-height:1.5;color:#5e584f}ul{padding-left:22px;line-height:1.8}.actions{display:flex;gap:12px;margin-top:26px}button{border:0;border-radius:999px;padding:12px 18px;font-weight:650;cursor:pointer}button[name=decision][value=approve]{background:#1d1b19;color:white}button[value=deny]{background:#eee9df;color:#292621}</style></head><body><main class="card"><h1>Connect ${escapeHtml(clientId)} to Hatch</h1><p>You are signed in as <strong>${displayName}</strong>. Allow this tool to work with your Expert Products?</p><ul>${scopeText}</ul><form method="post" action="/v1/auth/authorize/consent"><input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><div class="actions"><button type="submit" name="decision" value="deny">Cancel</button><button type="submit" name="decision" value="approve">Allow access</button></div></form></main></body></html>`;
}

function oauthScopeLabel(scope) {
  return {
    "creator:products:read": "View your Expert Products",
    "creator:products:write": "Create and update your Expert Products",
    "creator:files:read": "Read files attached to a Product",
    "creator:files:write": "Upload files to a Product after you approve them"
  }[scope] ?? scope;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// Authenticates the request. A web-session login also reports its `webSessionId` so the caller that owns the response can slide it.
async function authenticateRequest(request, registryUrl, fetchImpl, portalState) {
  const explicitToken = bearerTokenFromAuthorization(request);
  const oauthToken = explicitToken
    ? await activeOAuthAccessToken(explicitToken, portalState, request.__oauthStateKey)
    : undefined;
  if (explicitToken && explicitToken.startsWith("hatch_at_") && !oauthToken) {
    return { error: { status: 401, body: { error: { code: "unauthorized", message: "The access token is expired or invalid." } } } };
  }
  if (oauthToken) {
    const requiredScope = oauthEndpointScope(request);
    if (!requiredScope || !oauthToken.scopes.includes(requiredScope)) {
      return {
        error: {
          status: 403,
          body: {
            error: {
              code: requiredScope ? "oauth_scope_required" : "oauth_endpoint_not_allowed",
              message: requiredScope
                ? `OAuth scope ${requiredScope} is required for this endpoint.`
                : "This OAuth token is limited to the Product and Product Files API."
            }
          }
        }
      };
    }
    request.__isOAuthAccessToken = true;
    request.__oauthRequiredScope = requiredScope;
  }
  const webSessionId = requestCookies(request).hatch_web_session;
  // Web sessions are shared by rolling Dashboard processes through Postgres.
  // Refresh before authentication so a process never rejects a session that
  // another process created or renewed after this process started.
  if (!explicitToken && webSessionId) {
    try {
      await portalState?.refresh?.();
    } catch {
      return {
        error: {
          status: 503,
          body: {
            error: {
              code: "authentication_service_unavailable",
              message: "Sign-in verification is temporarily unavailable. Please try again."
            }
          }
        }
      };
    }
  }
  const webSession = !explicitToken && webSessionId ? portalState?.getWebSession(webSessionId) : undefined;
  const token = oauthToken?.registryToken
    ?? explicitToken
    ?? (webSession?.registry_token_ciphertext
      ? decryptOAuthSecret(webSession.registry_token_ciphertext, request.__oauthStateKey)
      : webSession?.registry_token);
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
    bindAccount(profile.id);
    request.__registryToken = token;
    request.__oauthScopes = oauthToken?.scopes;
    return { profile, account, token, webSessionId: webSession ? webSessionId : undefined };
  } catch (error) {
    if (error?.status === 401) {
      return { error: { status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } } } };
    }
    return {
      error: {
        status: 503,
        body: {
          error: {
            code: "authentication_service_unavailable",
            message: "Sign-in verification is temporarily unavailable. Please try again."
          }
        }
      }
    };
  }
}

// Authenticates and, when a web session slid, refreshes its cookies on the response that owns them.
async function authenticateWithSlide(request, response, registryUrl, fetchImpl, portalState) {
  const authentication = await authenticateRequest(request, registryUrl, fetchImpl, portalState);
  const { webSessionId } = authentication;
  if (webSessionId && !response.headersSent) {
    const slid = await portalState.touchWebSession(webSessionId).catch(() => undefined);
    if (slid && !response.headersSent) setWebSessionCookies(request, response, webSessionId, webSessionMaxAge(portalState, slid), { append: true });
  }
  return authentication;
}

async function optionalAccount(request, authenticate) {
  if (!bearerTokenFromAuthorization(request) && !requestCookies(request).hatch_web_session) return undefined;
  const authentication = await authenticate(request);
  return authentication.profile;
}

function publicProfile(profile) {
  const displayName = profile.display_name ?? profile.name ?? "Hatch account";
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "U";
  return {
    id: profile.id,
    display_name: displayName,
    avatar_url: profile.avatar_url ?? null,
    handle: profile.handle ?? `@${profile.id}`,
    initials
  };
}

function requireOAuthScope(request, scope, path) {
  if (!request.__isOAuthAccessToken) return;
  const scopes = request.__oauthScopes;
  if (!Array.isArray(scopes) || !scopes.includes(scope)) {
    throw stateError("oauth_scope_required", `OAuth scope ${scope} is required for ${path}.`, 403);
  }
}


// The free, unmetered Commerce order that a library save grants.
function libraryGrantInput(product, accountId) {
  const release = { release_id: product.release_id ?? product.corpus_digest, corpus_digest: product.corpus_digest };
  return {
    buyer_id: accountId,
    creator_id: product.creator_id,
    creator_display_name: product.creator_name,
    // `agent_id` is an internal Commerce alias only; it never crosses the public product response boundary.
    agent_id: product.agent_id ?? product.product_id,
    product_id: product.product_id,
    product_name: product.product_name,
    creator_snapshot: { id: product.creator_id, name: product.creator_name },
    product_snapshot: {
      product_id: product.product_id,
      product_name: product.product_name,
      promise: product.promise,
      description: product.description
    },
    release_snapshot: release,
    corpus_digest: release.corpus_digest,
    release_id: release.release_id,
    subtotal_minor: 0,
    discount_minor: 0,
    tax_minor: null,
    total_minor: 0,
    access_mode: "unmetered",
    gross_minor: 0,
    currency: "USD",
    payment_status: "not_required",
    version_policy: "pinned"
  };
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
      failure_message: providerFailureMessage(result.failure_code, result.status),
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
      failure_message: providerFailureMessage(error.code, "failed"),
      actor_id: submitted.provider,
      service_name: "payout-provider"
    });
    throw error;
  }
}

function providerFailureMessage(code, status) {
  if (!new Set(["failed", "cancelled"]).has(String(status ?? "").toLowerCase())) return undefined;
  const category = String(code ?? "").toLowerCase();
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


function runtimeEntitlementBinding(entitlement, portalState) {
  const productId = entitlement.product_id ?? entitlement.agent_id;
  const purchasedCorpusDigest = entitlement.purchased_corpus_digest ?? entitlement.corpus_digest;
  const effectiveCorpusDigest = entitlement.effective_corpus_digest ?? purchasedCorpusDigest;
  if (!productId || !purchasedCorpusDigest || !effectiveCorpusDigest) {
    throw stateError(
      "entitlement_migration_required",
      "This entitlement is missing its purchase-time Product release binding.",
      409
    );
  }
  const creatorProduct = portalState?.getCreatorProduct?.(entitlement.creator_id, productId);
  const releaseCandidates = [
    creatorProduct?.release,
    ...(Array.isArray(creatorProduct?.releases) ? creatorProduct.releases : [])
  ];
  const releaseSnapshot = releaseCandidates
    .map((release) => release?.catalog_snapshot)
    .find((snapshot) => snapshot && (
      String(snapshot.corpus_digest ?? "") === String(purchasedCorpusDigest)
      || String(snapshot.release_id ?? "") === String(entitlement.purchased_release_id ?? "")
    ));
  const briefSpec = releaseSnapshot?.brief_spec;
  return {
    entitlement_id: entitlement.entitlement_id,
    order_id: entitlement.order_id,
    user_id: entitlement.buyer_id,
    creator_id: entitlement.creator_id,
    agent_id: productId,
    product_id: productId,
    status: "active",
    access_mode: entitlement.access_mode === "unmetered" || Number(entitlement.gross_minor ?? 0) === 0
      ? "unmetered"
      : "metered",
    purchased_corpus_digest: purchasedCorpusDigest,
    effective_corpus_digest: effectiveCorpusDigest,
    version_policy: entitlement.version_policy ?? "pinned",
    ...(briefSpec ? { brief_spec: structuredClone(briefSpec) } : {}),
    version_history: entitlement.version_history ?? []
  };
}

function currentCreatorNameProjection(value, creatorDisplayName) {
  const projected = { ...value };
  if (Object.hasOwn(value, "creator_name")) projected.creator_name = creatorDisplayName;
  if (Object.hasOwn(value, "creator_display_name")) projected.creator_display_name = creatorDisplayName;
  for (const key of ["creator", "creator_snapshot"]) {
    const creator = value[key];
    if (Object.hasOwn(value, key) && creator && typeof creator === "object" && !Array.isArray(creator)) {
      const currentCreator = { ...creator };
      if (Object.hasOwn(creator, "name")) currentCreator.name = creatorDisplayName;
      if (Object.hasOwn(creator, "display_name")) currentCreator.display_name = creatorDisplayName;
      projected[key] = currentCreator;
    }
  }
  return projected;
}

async function authoritativeCatalog(registryUrl, fetchImpl, _portalState) {
  const registryCatalog = await registryRequest(registryUrl, "/v1/public/products", { fetchImpl });
  const byProduct = new Map((Array.isArray(registryCatalog) ? registryCatalog : []).map((product) => {
    const agent = { ...product, agent_id: product.product_id };
    return [`${agent.creator_id}:${agent.product_id}`, agent];
  }));
  return [...byProduct.values()];
}

function canonicalPublicUrl(value) {
  const text = String(value ?? "");
  const match = text.match(/^\/products\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match ? `/products/${match[1].toLowerCase()}` : (text || undefined);
}

function publicCatalogAgent(agent, creatorState) {
  const deployedAgent = creatorState?.release?.catalog_snapshot ?? agent;
  const withdrawn = creatorState?.status === "withdrawn";
  const {
    agent_id: _agentId,
    creator_slug: _creatorSlug,
    product_slug: _productSlug,
    creator_slug_aliases: _creatorAliases,
    product_slug_aliases: _productAliases,
    ...authorityAgent
  } = deployedAgent;
  const creatorAvatarUrl = Object.hasOwn(agent, "creator_avatar_url")
    ? agent.creator_avatar_url
    : agent.creator?.avatar_url ?? authorityAgent.creator_avatar_url ?? authorityAgent.creator?.avatar_url ?? null;
  return {
    ...authorityAgent,
    creator_name: agent.creator_name,
    creator_avatar_url: creatorAvatarUrl,
    creator: { id: authorityAgent.creator_id, name: agent.creator_name, avatar_url: creatorAvatarUrl },
    product: { id: authorityAgent.product_id, name: authorityAgent.product_name ?? authorityAgent.name ?? authorityAgent.product_id },
    promise: deployedAgent.product_promise ?? deployedAgent.product_description ?? "",
    description: deployedAgent.product_description ?? "",
    boundaries: deployedAgent.product_boundaries ?? [],
    ...(deployedAgent.brief_spec ? { brief_spec: structuredClone(deployedAgent.brief_spec) } : {}),
    // Pricing is a live Product setting, never part of a release snapshot.
    ...(agent.pricing ? { pricing: structuredClone(agent.pricing) } : {}),
    availability: withdrawn ? "withdrawn" : "published",
    available: !withdrawn,
    release_id: creatorState?.release?.release_id ?? deployedAgent.corpus_digest,
    public_url: `/products/${encodeURIComponent(deployedAgent.product_id)}`
  };
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

function findCatalogAgent(catalog, creatorSelector, productSelector) {
  return (Array.isArray(catalog) ? catalog : []).find((entry) => (
    (!creatorSelector || String(entry.creator_id) === String(creatorSelector))
    && (!productSelector || String(entry.product_id) === String(productSelector))
  ));
}


function publicProductPath(agent) {
  return `/products/${encodeURIComponent(agent?.product_id)}`;
}

function creatorProductViews(agents, states) {
  const stateByProduct = new Map(states.map((state) => [state.product_id, state]));
  return agents
    .map((agent) => creatorProductView(agent, stateByProduct.get(agent.product_id)))
    .sort((left, right) => String(right.updated_at ?? right.published_at ?? "").localeCompare(String(left.updated_at ?? left.published_at ?? "")));
}

function creatorProductView(agent, state) {
  if (!agent) return null;
  const base = agent.name ? agent : catalogAgentToProduct(agent);
  return {
    ...base,
    version: state?.version ?? 0,
    resource_version: state?.version ?? 0,
    status: state?.status ?? base.status,
    // The Registry live release is authoritative; PortalState only keeps the
    // browser-side projection and must not erase a release from the Registry listing.
    release: state?.release ?? base.release ?? null,
    releases: state?.releases ?? (state?.release
      ? [state.release]
      : (base.release ? [base.release] : [])),
    public_url: canonicalPublicUrl(state?.public_url) ?? (base.status === "published" ? `/products/${encodeURIComponent(base.product_id)}` : null),
    updated_at: state?.updated_at ?? base.updated_at ?? base.published_at
  };
}

function storefrontPreview(product, profile, state) {
  return {
    product,
    creator: profile,
    resource_version: state?.version ?? product.resource_version ?? 0,
    public_url: `/products/${encodeURIComponent(product.product_id)}`,
    preview: true
  };
}

function enrichEntitlements(entitlements, catalog, deliveries = [], creatorNames = new Map()) {
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
  return entitlements
    .filter((entitlement) => creatorNames.has(entitlement.creator_id))
    .map((entitlement) => {
    const unmetered = entitlement.access_mode === "unmetered" || Number(entitlement.gross_minor ?? 0) === 0;
    const agent = byProduct.get(`${entitlement.creator_id}:${entitlement.product_id}`);
    const currentEntitlement = currentCreatorNameProjection(
      entitlement,
      creatorNames.get(entitlement.creator_id)
    );
    const {
      agent_id: _agentId,
      creator_slug: _creatorSlug,
      product_slug: _productSlug,
      creator_slug_aliases: _creatorAliases,
      product_slug_aliases: _productAliases,
      ...publicEntitlement
    } = currentEntitlement;
    return {
      ...publicEntitlement,
      product_id: currentEntitlement.product_id ?? currentEntitlement.agent_id,
      access_mode: unmetered ? "unmetered" : "metered",
      ...(agent?.brief_spec ? { brief_spec: structuredClone(agent.brief_spec) } : {}),
      status: currentEntitlement.status === "active" && !unmetered && currentEntitlement.reserved_units > 0 ? "reserved" : currentEntitlement.status,
      product: agent ? {
        id: agent.product_id,
        product_id: agent.product_id,
        name: agent.product_name,
        description: agent.product_description,
        promise: agent.product_promise,
        ...(agent.brief_spec ? { brief_spec: structuredClone(agent.brief_spec) } : {}),
        ...(agent.pricing ? { pricing: structuredClone(agent.pricing) } : {})
      } : { id: currentEntitlement.product_id, product_id: currentEntitlement.product_id, name: currentEntitlement.product_id },
      creator: agent ? {
        id: agent.creator_id,
        name: creatorNames.get(currentEntitlement.creator_id),
        avatar_url: agent.creator_avatar_url ?? agent.creator?.avatar_url ?? null
      } : { id: currentEntitlement.creator_id },
      version_policy: entitlement.version_policy ?? "pinned",
      ...(unmetered ? {} : {
        granted_units: entitlement.granted_units,
        remaining_units: entitlement.remaining_units,
        deliveries: deliveriesByEntitlement.get(entitlement.entitlement_id) ?? []
      })
    };
  });
}

function entitlementMatchesStatus(entitlement, status) {
  if (!status || status === "all") return true;
  if (status === "active") return entitlement.status === "active" || entitlement.status === "reserved";
  if (status === "past") return ["consumed", "expired", "revoked"].includes(entitlement.status);
  return entitlement.status === status;
}

function isOfferedProduct(entitlement, catalog, portalState) {
  const entry = catalog.find((agent) => agent.product_id === entitlement.product_id);
  return Boolean(entry) && portalState.getCreatorProduct(entry.creator_id, entry.product_id)?.status !== "withdrawn";
}

function compareEntitlementsNewestFirst(left, right) {
  const timestamp = entitlement => {
    const value = Date.parse(entitlement.granted_at ?? entitlement.valid_from ?? entitlement.created_at ?? "");
    return Number.isFinite(value) ? value : 0;
  };
  return timestamp(right) - timestamp(left)
    || String(right.entitlement_id ?? "").localeCompare(String(left.entitlement_id ?? ""));
}

function randomId() {
  return randomUUID().replaceAll("-", "");
}


function catalogAgentToProduct(agent) {
  return {
    product_id: agent.product_id,
    creator_id: agent.creator_id,
    agent_id: agent.agent_id,
    corpus_digest: agent.corpus_digest,
    name: agent.product_name,
    description: agent.product_description ?? "",
    promise: agent.product_promise ?? agent.product_description ?? "",
    boundaries: agent.product_boundaries ?? [],
    ...(agent.brief_spec ? { brief_spec: structuredClone(agent.brief_spec) } : {}),
    ...(agent.pricing ? { pricing: structuredClone(agent.pricing) } : {}),
    status: agent.status ?? "published",
    published_at: agent.published_at ?? null,
    ...(agent.created_at ? { created_at: agent.created_at } : {}),
    ...(agent.updated_at ? { updated_at: agent.updated_at } : {}),
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

/** The platforms a person can sign in with; the Registry says which of them are on. */
const LOGIN_KINDS = ["telegram", "line", "discord"];

function loginStateCookie(request, kind, value, maxAge) {
  return `hatch_login_state=${encodeURIComponent(value)}; Path=/v1/auth/${kind}; SameSite=Lax; Max-Age=${maxAge}${requestIsSecure(request) ? "; Secure" : ""}; HttpOnly`;
}

function safeLocalPath(value) {
  const candidate = String(value ?? "");
  return candidate.startsWith("/") && !candidate.startsWith("//") && !candidate.includes("\\") && !/[\u0000-\u001f]/.test(candidate) ? candidate : "/";
}

function redirect(response, location) {
  response.writeHead(302, { ...response.getHeaders(), location, "cache-control": "no-store" });
  response.end();
}

function webSessionMaxAge(portalState, session) {
  return Math.max(0, Math.floor((Date.parse(session.expires_at) - portalState.clock().getTime()) / 1000));
}

function setWebSessionCookies(request, response, token, maxAge, { append = false } = {}) {
  const secure = requestIsSecure(request);
  const secureAttribute = secure ? "; Secure" : "";
  const common = `Path=/; SameSite=Lax; Max-Age=${maxAge}${secureAttribute}`;
  const existing = append ? [response.getHeader("set-cookie") ?? []].flat() : [];
  response.setHeader("set-cookie", [
    ...existing,
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

const ARTIFACT_DEFINITION_PATH = /^\/v1\/web-chat\/products\/[^/]+\/artifact(?:\/conversations)?$/;
const PRODUCT_AGENT_PATH = /^\/v1\/web-chat\/products\/[^/]+\/agent$/;
const CONVERSATION_ASSET_UPLOAD_PATH = /^\/v1\/web-chat\/conversations\/[^/]+\/assets$/;
const WEB_CHAT_IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const WEB_CHAT_FILE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/** A pass-through that fails once more than maxBytes went by, whatever the declared length said. */
function byteLimit(maxBytes) {
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? requestBodyTooLarge(maxBytes) : null, chunk);
    }
  });
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

async function readForm(request, maxBytes = 64 * 1024) {
  const raw = await readRawBody(request, maxBytes);
  return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
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
    || code.startsWith("access_")
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
  // An error is never cached: Cloudflare gives an uncached response a 4-hour browser TTL, so a missing asset during a
  // deploy's handover would stay missing in that browser for hours.
  if (status >= 400 && !response.hasHeader("cache-control")) response.setHeader("cache-control", "no-store");
  const corsOrigin = response.__hatchCorsOrigin ?? "http://127.0.0.1:8510";
  response.setHeader("access-control-allow-origin", corsOrigin);
  if (corsOrigin !== "*") response.setHeader("access-control-allow-credentials", "true");
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

function sendHtml(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "text/html; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}


// Retired buyer routes. /home goes to Studio; buyer orders live under /explore.
export function retiredPortalRedirect(pathname) {
  if (pathname === "/home") return "/studio";
  return null;
}

// Packed by Dockerfile.dashboard into dist/downloads; unhashed, so never cached immutably.
const HATCH_CLI_DOWNLOAD = "/downloads/hatch-cli.tgz";

function isPublicPortalRoute(pathname) {
  return pathname === "/"
    || pathname === "/explore"
    || pathname.startsWith("/explore/")
    || pathname === "/creators"
    || pathname.startsWith("/creators/")
    || pathname === "/products"
    || pathname.startsWith("/products/")
    || pathname.startsWith("/chat/product/")
    || pathname.startsWith("/artifact/")
    || pathname === "/studio"
    || pathname.startsWith("/studio/")
    || pathname === "/library"
    || pathname === "/account"
    || pathname.startsWith("/account/")
    || pathname === "/sign-in"
    || pathname === "/sign-up"
    || pathname === "/desktop/sign-in"
    || pathname === "/developers"
    || pathname.startsWith("/developers/")
    || pathname === "/help"
    || pathname.startsWith("/help/")
    || pathname === "/download";
}

async function servePortalIndex(response, metadata, status = 200, noScriptFallback, helpPageResult) {
  try {
    const source = await readFile(path.join(currentDirectory, "dist", "index.html"), "utf8");
    if (helpPageResult?.status === 200) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", vary: "Accept-Language" });
      return response.end(injectHelpPage(source, helpPageResult));
    }
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
    if (requestPath === "/favicon.svg") {
      relativePath = "favicon.svg";
    } else if (requestPath === "/assets" || !path.extname(requestPath)) {
      relativePath = "index.html";
    } else if (requestPath === HATCH_CLI_DOWNLOAD) {
      relativePath = requestPath.slice(1);
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
      "cache-control": relativePath === "index.html" || requestPath === HATCH_CLI_DOWNLOAD ? "no-cache" : "public, max-age=31536000, immutable"
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
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".tgz": "application/gzip",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4"
  }[extension] ?? "application/octet-stream";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port, shutdown } = await startDashboardServer();
  exitOnSignal(() => shutdown(drainMsFromEnvironment(process.env)));
  logEvent("info", "listening", { message: `Hatch Expert Dashboard API listening on http://${host}:${port}` });
}
