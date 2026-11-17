import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const catalogAgent = {
  creator_id: "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21",
  creator_name: "Maya Chen",
  agent_id: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42",
  product_id: "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42",
  product_name: "Signal Resume Review",
  product_description: "Resume review",
  product_promise: "Turn a resume into a concise signal map.",
  product_boundaries: ["Does not submit applications."],
  brief_spec: {
    contract_version: "1",
    fields: [{ id: "goal", label: "What outcome should this task produce?", required: true }]
  },
  presentation: { accent: "fern" },
  corpus_digest: "sha256:current-corpus",
  published_at: "2026-08-02T00:00:00.000Z"
};

test("Dashboard readiness fails closed when Registry is unavailable", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-health-"));
  const registry = registryFixture({ signedIn: "buyer" });
  await listen(registry);
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const healthy = await fetch(`${serverUrl(api)}/readyz`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, commerce: "ready", registry: "ready" });

  await new Promise((resolve) => registry.close(resolve));
  const unhealthy = await fetch(`${serverUrl(api)}/readyz`);
  assert.equal(unhealthy.status, 503);
  assert.equal((await unhealthy.json()).error.code, "dashboard_not_ready");
  const live = await fetch(`${serverUrl(api)}/healthz`);
  assert.equal(live.status, 200);
});

test("consumer avatar and display name changes proxy through the authenticated Registry session", async (context) => {
  const account = {
    id: "buyer-avatar-test",
    email: "buyer@example.test",
    display_name: "Buyer"
  };
  let avatarUrl = null;
  const avatarRequests = [];
  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    const body = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    const payload = Buffer.concat(body);
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: "signed-user-token", account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me" && request.method === "PATCH") {
      const name = String(JSON.parse(payload.toString()).display_name ?? "").trim();
      if (!name) {
        response.statusCode = 400;
        response.end(JSON.stringify({ detail: "Display name is required." }));
        return;
      }
      account.display_name = name;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify({ ...account, avatar_url: avatarUrl }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me/avatar") {
      avatarRequests.push({ method: request.method, authorization: request.headers.authorization, contentType: request.headers["content-type"], body: payload });
      avatarUrl = request.method === "PUT" ? "https://avatar.example.test/account.webp" : null;
      response.end(JSON.stringify({ ...account, avatar_url: avatarUrl }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const stateDirectory = path.join(path.dirname(new URL(import.meta.url).pathname), "../.local-uat", `avatar-proxy-${randomUUID()}`);
  await mkdir(stateDirectory, { recursive: true });
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(stateDirectory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: "test-only" })
  });
  assert.equal(login.status, 200);
  const cookies = login.headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrfCookie = cookies.find((value) => value.startsWith("hatch_web_csrf="));
  assert.ok(csrfCookie);
  const csrf = decodeURIComponent(csrfCookie.split(";", 1)[0].slice("hatch_web_csrf=".length));

  const upload = await fetch(`${serverUrl(api)}/v1/auth/me/avatar`, {
    method: "PUT",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "image/png" },
    body: Buffer.from("avatar-image-bytes")
  });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).avatar_url, "https://avatar.example.test/account.webp");
  assert.equal(avatarRequests[0].authorization, "Bearer signed-user-token");
  assert.equal(avatarRequests[0].contentType, "image/png");
  assert.deepEqual(avatarRequests[0].body, Buffer.from("avatar-image-bytes"));

  const refreshedProfile = await fetch(`${serverUrl(api)}/v1/auth/me`, { headers: { cookie } });
  assert.equal(refreshedProfile.status, 200);
  assert.equal((await refreshedProfile.json()).avatar_url, "https://avatar.example.test/account.webp");

  const remove = await fetch(`${serverUrl(api)}/v1/auth/me/avatar`, {
    method: "DELETE",
    headers: { cookie, "x-csrf-token": csrf }
  });
  assert.equal(remove.status, 200);
  assert.equal((await remove.json()).avatar_url, null);
  assert.deepEqual(avatarRequests.map(({ method }) => method), ["PUT", "DELETE"]);

  const rename = (headers, displayName = " Renamed Buyer ") => fetch(`${serverUrl(api)}/v1/auth/me`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify({ display_name: displayName })
  });
  assert.equal((await rename({})).status, 403);
  const renamed = await rename({ "x-csrf-token": csrf });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).display_name, "Renamed Buyer");
  assert.equal((await (await fetch(`${serverUrl(api)}/v1/auth/me`, { headers: { cookie } })).json()).display_name, "Renamed Buyer");
  const rejected = await rename({ "x-csrf-token": csrf }, "  ");
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.message, "Display name is required.");
});

test("a signed-in browser hands Desktop its own session through a PKCE code", async (context) => {
  const account = { id: "desktop-handoff-test", email: "buyer@example.test", display_name: "Buyer" };
  const mintedFor = [];
  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    for await (const _chunk of request) { /* drain */ }
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/v1/auth/signin") return response.end(JSON.stringify({ token: "browser-token", account }));
    if (requestUrl.pathname === "/v1/auth/me") return response.end(JSON.stringify(account));
    if (requestUrl.pathname === "/v1/auth/sessions" && request.method === "POST") {
      mintedFor.push(request.headers.authorization);
      response.statusCode = 201;
      return response.end(JSON.stringify({ token: "desktop-token", session: { token: "desktop-token", expires_at: "2099-01-01T00:00:00.000Z" }, account }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
  });
  await listen(registry);
  context.after(() => registry.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-desktop-handoff-"));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: serverUrl(registry) });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: "test-only" })
  });
  const cookies = login.headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrf = decodeURIComponent(cookies.find((value) => value.startsWith("hatch_web_csrf=")).split(";", 1)[0].slice("hatch_web_csrf=".length));

  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(`${serverUrl(api)}/v1/auth/desktop/authorize`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify({ state: "desktop-state-0123456789", code_challenge: challenge })
  });
  assert.equal(authorize.status, 200);
  const redirect = new URL((await authorize.json()).redirect_uri);
  assert.equal(`${redirect.protocol}//${redirect.host}${redirect.pathname}`, "hatch://auth/callback");
  assert.equal(redirect.searchParams.get("state"), "desktop-state-0123456789");
  assert.deepEqual(mintedFor, ["Bearer browser-token"]);

  const redeem = await fetch(`${serverUrl(api)}/v1/auth/desktop/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: redirect.searchParams.get("code"), code_verifier: verifier })
  });
  assert.equal(redeem.status, 200);
  assert.equal((await redeem.json()).token, "desktop-token");
});

test("browser authentication keeps its session through a transient Registry failure", async (context) => {
  let failVerification = false;
  const account = {
    id: catalogAgent.creator_id,
    email: "creator@example.test",
    display_name: "Maya Chen"
  };
  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: "signed-creator-token", account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me" && failVerification) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { code: "registry_unavailable", message: "Try again." } }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify(account));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-session-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  let refreshCount = 0;
  const originalRefresh = dashboard.portalState.refresh.bind(dashboard.portalState);
  dashboard.portalState.refresh = async () => {
    refreshCount += 1;
    await originalRefresh();
  };
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: "test-only" })
  });
  const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  failVerification = true;
  const unavailable = await fetch(`${serverUrl(api)}/v1/auth/me`, { headers: { cookie } });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "authentication_service_unavailable");

  failVerification = false;
  const recovered = await fetch(`${serverUrl(api)}/v1/auth/me`, { headers: { cookie } });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).id, account.id);
  assert.ok(refreshCount >= 2);
});

test("Creator browser session proxies Product BriefSpec writes to Registry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-brief-spec-"));
  const briefCalls = [];
  const registry = registryFixture({ signedIn: "owner", briefCalls });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const loginResponse = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  assert.equal(loginResponse.status, 200);
  const setCookies = loginResponse.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrfCookie = setCookies.find((value) => value.startsWith("hatch_web_csrf="));
  assert.ok(csrfCookie);
  const csrf = decodeURIComponent(csrfCookie.split(";", 1)[0].slice("hatch_web_csrf=".length));
  const briefSpec = {
    contract_version: "1",
    fields: [{ id: "goal", label: "What should this Product accomplish?", required: true }]
  };

  const response = await fetch(`${serverUrl(api)}/v1/creator/products/${catalogAgent.product_id}/brief-spec`, {
    method: "PUT",
    headers: {
      cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
      "idempotency-key": "brief-spec-v1"
    },
    body: JSON.stringify({ brief_spec: briefSpec, expected_updated_at: "2026-08-16T00:00:00.000Z" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).brief_spec, briefSpec);
  assert.deepEqual(briefCalls, [{
    body: { brief_spec: briefSpec, expected_updated_at: "2026-08-16T00:00:00.000Z" },
    idempotencyKey: "brief-spec-v1"
  }]);
});

test("ingest uploads are requested through the Dashboard and file bytes stream to the Registry without a body-size cap", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-ingest-upload-"));
  const ingestCalls = [];
  const registry = registryFixture({ signedIn: "owner", ingestCalls });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: serverUrl(registry) });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "creator@example.test", password: "test-only" }) });
  const setCookies = login.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrf = decodeURIComponent(setCookies.find((value) => value.startsWith("hatch_web_csrf=")).split(";", 1)[0].slice("hatch_web_csrf=".length));
  const issued = await fetch(`${serverUrl(api)}/v1/creator/products/${catalogAgent.product_id}/ingest/uploads`, {
    method: "POST", headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify({ name: "talk.mp4", bytes: 3, media_type: "video/mp4" })
  });
  assert.equal(issued.status, 201);
  assert.equal((await issued.json()).upload_id, "u1");
  assert.deepEqual(ingestCalls[0].body, { name: "talk.mp4", bytes: 3, media_type: "video/mp4" });
  const bytes = Buffer.alloc(1024 * 1024 + 7, 97);
  const put = await fetch(`${serverUrl(api)}/v1/local-objects/k?sig=s`, { method: "PUT", headers: { "content-type": "video/mp4" }, body: bytes });
  assert.equal(put.status, 200);
  assert.deepEqual(ingestCalls[1], { route: "put", query: "?sig=s", contentType: "video/mp4", bytes: bytes.length, authorization: undefined });
});

test("browser OAuth PKCE keeps state and authorizes Product Ingest without Version scope", async (context) => {
  const account = {
    id: catalogAgent.creator_id,
    email: "creator@example.test",
    display_name: "Maya Chen"
  };
  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/readyz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: "signed-creator-token", account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me" && request.headers.authorization === "Bearer signed-creator-token") {
      response.end(JSON.stringify(account));
      return;
    }
    if (requestUrl.pathname === "/v1/creator/products/product-1/ingest" && request.method === "GET") {
      response.end(JSON.stringify({ product_id: "product-1", jobs: [{ id: "job-1", product_id: "product-1" }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-oauth-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  assert.equal(login.status, 200);
  const setCookies = login.headers.getSetCookie();
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrfCookie = setCookies.find((value) => value.startsWith("hatch_web_csrf="));
  assert.ok(csrfCookie);
  const csrf = decodeURIComponent(csrfCookie.split(";", 1)[0].slice("hatch_web_csrf=".length));

  const verifier = "verifier_abcdefghijklmnopqrstuvwxyz_0123456789-._~";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = "oauth-state-for-callback";
  const redirectUri = "http://127.0.0.1:43210/oauth/callback";
  const authorize = await fetch(`${serverUrl(api)}/v1/auth/authorize?${new URLSearchParams({
    client_id: "hatch-context-intake",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "creator:products:read creator:products:write creator:files:read creator:files:write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  })}`, { headers: { cookie } });
  assert.equal(authorize.status, 200);
  const consentHtml = await authorize.text();
  assert.match(consentHtml, /Create and update your Expert Products/);
  assert.doesNotMatch(consentHtml, /Version/);
  const transactionId = consentHtml.match(/name="transaction_id" value="([^"]+)"/)?.[1];
  const formCsrf = consentHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.ok(transactionId);
  assert.equal(formCsrf, csrf);

  const consent = await fetch(`${serverUrl(api)}/v1/auth/authorize/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: transactionId, csrf_token: csrf, decision: "approve" })
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${serverUrl(api)}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "hatch-context-intake",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    })
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();
  assert.doesNotMatch(token.scope, /creator:versions:read/);

  const ingest = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/ingest`, {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  assert.equal(ingest.status, 200);
  const ingestBody = await ingest.json();
  assert.deepEqual(ingestBody.product_id, "product-1");
  assert.deepEqual(ingestBody.jobs, [{ id: "job-1", product_id: "product-1" }]);
  assert.match(ingestBody.request_id, /^req_/);

  const forbiddenBriefResponse = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/brief-spec`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ brief_spec: { contract_version: "1", fields: [] } })
  });
  assert.equal(forbiddenBriefResponse.status, 403);
  assert.equal((await forbiddenBriefResponse.json()).error.code, "oauth_endpoint_not_allowed");

  const forbiddenPublish = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ candidate_id: "candidate-1" })
  });
  assert.equal(forbiddenPublish.status, 403);
  assert.equal((await forbiddenPublish.json()).error.code, "oauth_endpoint_not_allowed");

  const limitedVerifier = "limited_verifier_abcdefghijklmnopqrstuvwxyz_0123456789-._~";
  const limitedChallenge = createHash("sha256").update(limitedVerifier).digest("base64url");
  const limitedAuthorize = await fetch(`${serverUrl(api)}/v1/auth/authorize?${new URLSearchParams({
    client_id: "hatch-context-intake",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "creator:products:read",
    state: "limited-scope-state",
    code_challenge: limitedChallenge,
    code_challenge_method: "S256"
  })}`, { headers: { cookie } });
  assert.equal(limitedAuthorize.status, 200);
  const limitedHtml = await limitedAuthorize.text();
  const limitedTransactionId = limitedHtml.match(/name="transaction_id" value="([^"]+)"/)?.[1];
  const limitedConsent = await fetch(`${serverUrl(api)}/v1/auth/authorize/consent`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction_id: limitedTransactionId, csrf_token: csrf, decision: "approve" })
  });
  const limitedCode = new URL(limitedConsent.headers.get("location")).searchParams.get("code");
  const limitedTokenResponse = await fetch(`${serverUrl(api)}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "hatch-context-intake",
      code: limitedCode,
      redirect_uri: redirectUri,
      code_verifier: limitedVerifier
    })
  });
  const limitedToken = await limitedTokenResponse.json();
  const limitedIngestWrite = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${limitedToken.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ links: ["https://example.test/not-authorized"] })
  });
  assert.equal(limitedIngestWrite.status, 403);
  assert.equal((await limitedIngestWrite.json()).error.code, "oauth_scope_required");

  const persistedState = await readFile(path.join(directory, "portal-state.json"), "utf8");
  assert.doesNotMatch(persistedState, /signed-creator-token/);
  assert.doesNotMatch(persistedState, new RegExp(token.access_token));
  assert.doesNotMatch(persistedState, new RegExp(token.refresh_token));

  const restartedDashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "restarted-ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry)
  });
  const restartedApi = createServer(restartedDashboard.handler);
  await listen(restartedApi);
  context.after(() => restartedApi.close());
  const ingestAfterRestart = await fetch(`${serverUrl(restartedApi)}/v1/creator/products/product-1/ingest`, {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  assert.equal(ingestAfterRestart.status, 200);
  const refreshedAfterRestart = await fetch(`${serverUrl(restartedApi)}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "hatch-context-intake",
      refresh_token: token.refresh_token
    })
  });
  assert.equal(refreshedAfterRestart.status, 200);
  const refreshedToken = await refreshedAfterRestart.json();
  assert.notEqual(refreshedToken.access_token, token.access_token);
});

test("creator products are projected directly from the Agent Corpus Registry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-creator-"));
  const registry = registryFixture({ signedIn: "owner" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryDeploymentServiceToken: "test-deployment-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const response = await fetch(`${serverUrl(api)}/v1/creator/overview`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const overview = await response.json();

  assert.equal(response.status, 200, JSON.stringify(overview));
  assert.equal(overview.products[0].agent_id, catalogAgent.agent_id);
  assert.equal(overview.products[0].corpus_digest, catalogAgent.corpus_digest);
  assert.equal(overview.products[0].promise, catalogAgent.product_promise);
  assert.deepEqual(overview.products[0].boundaries, catalogAgent.product_boundaries);
  assert.equal(overview.products[0].status, "published");
  assert.equal(overview.metrics.orders, 0);
});

test("non-UUID product paths are rejected without redirects", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-slug-alias-"));
  const aliasedAgent = {
    ...catalogAgent,
    creator_slug: "maya-chen",
    product_slug: "signal-resume-review",
    creator_slug_aliases: ["maya-old"],
    product_slug_aliases: ["resume-review-old"]
  };
  const registry = registryFixture({ signedIn: "buyer", catalogAgents: [aliasedAgent] });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const browserResponse = await fetch(`${serverUrl(api)}/creators/maya-old/resume-review-old`, { redirect: "manual" });
  assert.equal(browserResponse.status, 404);

  const apiResponse = await fetch(`${serverUrl(api)}/v1/public/products/maya-old/resume-review-old`);
  assert.equal(apiResponse.status, 404);
});

test("the retired /home route 301s to /studio at the routing boundary", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-retired-routes-"));
  const registry = registryFixture({ signedIn: "buyer" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  for (const [from, to] of [
    ["/home", "/studio"]
  ]) {
    const response = await fetch(`${serverUrl(api)}${from}`, { redirect: "manual" });
    assert.equal(response.status, 301, from);
    assert.equal(response.headers.get("location"), to, from);
  }
});

test("/library is served as the portal, not redirected", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-library-route-"));
  const registry = registryFixture({ signedIn: "buyer" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: serverUrl(registry) });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const [library, explore] = await Promise.all(["/library", "/explore"].map((route) => fetch(`${serverUrl(api)}${route}`, { redirect: "manual" })));
  assert.notEqual(library.status, 301);
  assert.notEqual(library.status, 404);
  assert.equal(library.status, explore.status, "served by the same SPA fallback as the other portal routes");
  assert.equal(library.headers.get("content-type"), explore.headers.get("content-type"));
  await Promise.all([library.text(), explore.text()]);
});

test("an owner reaches their published Agent by product_id", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-owner-access-"));
  const registry = registryFixture({ signedIn: "owner" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryAccessServiceToken: "test-access-service",
    registryDeploymentServiceToken: "test-deployment-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const access = await fetch(`${serverUrl(api)}/v1/user/product-access`, { headers });
  const { creator_agents: agents } = await access.json();
  assert.equal(access.status, 200);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].product_id, catalogAgent.product_id);
  assert.equal(agents[0].creator_id, catalogAgent.creator_id);
  assert.equal("entitlement_id" in agents[0], false);
  // An owner starts tasks with the same brief an acquirer answers.
  assert.deepEqual(agents[0].brief_spec, catalogAgent.brief_spec);
  assert.deepEqual(agents[0].product.brief_spec, catalogAgent.brief_spec);

  assert.equal(dashboard.ledger.listEvents().length, 0);
});

test("library save is internal and service-token authed; remove is a session DELETE", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-library-"));
  const captured = [];
  const registry = registryFixture({ signedIn: "buyer" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryDeploymentServiceToken: "test-deployment-service",
    commerceRuntimeServiceToken: "test-runtime-service",
    registryUrl: serverUrl(registry),
    analytics: { capture: (distinctId, event) => captured.push({ distinctId, ...event }) },
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const result = async (response) => { const { request_id: _requestId, ...rest } = await response.json(); return rest; };
  const save = (token) => fetch(`${serverUrl(api)}/v1/internal/library/save`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify({ account_id: "buyer-zero", product_id: catalogAgent.product_id })
  });
  assert.equal((await save()).status, 403);
  assert.equal((await save("wrong")).status, 403);
  assert.equal(dashboard.ledger.listEvents().length, 0);

  const first = await save("test-runtime-service");
  assert.equal(first.status, 200);
  assert.deepEqual(await result(first), { saved: true, created: true });
  assert.deepEqual(await result(await save("test-runtime-service")), { saved: true, created: false });
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "entitlement.granted").length, 1);

  const token = await login(api);
  const listing = () => fetch(`${serverUrl(api)}/v1/library?status=active`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  assert.deepEqual((await listing()).entitlements.map((entry) => entry.product_id), [catalogAgent.product_id]);

  const remove = (auth) => fetch(`${serverUrl(api)}/v1/library/${catalogAgent.product_id}`, { method: "DELETE", headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  assert.equal((await remove()).status, 401);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "entitlement.revoked").length, 0);
  assert.deepEqual(await result(await remove(token)), { removed: true });
  assert.deepEqual(await result(await remove(token)), { removed: false });
  assert.deepEqual((await listing()).entitlements, []);

  assert.deepEqual(await result(await save("test-runtime-service")), { saved: true, created: true });
  assert.deepEqual(captured.map((entry) => entry.event).filter((event) => event !== "signed_in"), ["agent_saved", "agent_removed", "agent_saved"]);
});

test("library and access lists omit records whose Creator account is missing and return the remaining records", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-missing-creator-"));
  const missingCreatorAgent = {
    ...catalogAgent,
    creator_id: "2c6a0c4e-6a9a-4c5e-9926-2c0e997cad12",
    agent_id: "c867f6fc-8fb0-4bca-b1c7-93c77941d1a4",
    product_id: "c867f6fc-8fb0-4bca-b1c7-93c77941d1a4",
    product_name: "Missing Creator Product"
  };
  const missingCreatorAccountIds = new Set();
  const registry = registryFixture({
    signedIn: "buyer",
    catalogAgents: [catalogAgent, missingCreatorAgent],
    missingCreatorAccountIds
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryDeploymentServiceToken: "test-deployment-service",
    commerceRuntimeServiceToken: "test-runtime-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const save = async (agent) => {
    const response = await fetch(`${serverUrl(api)}/v1/internal/library/save`, {
      method: "POST",
      headers: { authorization: "Bearer test-runtime-service", "content-type": "application/json" },
      body: JSON.stringify({ account_id: "buyer-zero", product_id: agent.product_id })
    });
    assert.equal(response.status, 200);
    return dashboard.commerce.listBuyerEntitlements("buyer-zero").find((entry) => entry.product_id === agent.product_id);
  };
  const validPurchase = { entitlement: await save(catalogAgent) };
  await save(missingCreatorAgent);
  missingCreatorAccountIds.add(missingCreatorAgent.creator_id);

  const accessResponse = await fetch(`${serverUrl(api)}/v1/user/product-access`, { headers });
  assert.equal(accessResponse.status, 200);
  const access = await accessResponse.json();
  assert.deepEqual(access.creator_agents.map((entry) => entry.entitlement_id), [validPurchase.entitlement.entitlement_id]);

  const libraryResponse = await fetch(`${serverUrl(api)}/v1/library?limit=1`, { headers });
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json();
  assert.deepEqual(library.entitlements.map((entry) => entry.entitlement_id), [validPurchase.entitlement.entitlement_id]);
  assert.equal(library.next_cursor, null);

  const publicProductsResponse = await fetch(`${serverUrl(api)}/v1/public/products`, { headers });
  assert.equal(publicProductsResponse.status, 200);
  assert.equal((await publicProductsResponse.json()).length, 2);
});

test("public Creator and Product profiles expose the Registry account avatar", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-public-avatar-"));
  const avatar = "https://media.example/creator-avatar.webp";
  const registry = registryFixture({ signedIn: "buyer", agent: { ...catalogAgent, creator_avatar_url: avatar } });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const productResponse = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.product_id}`);
  const product = (await productResponse.json()).product;
  assert.equal(product.creator_avatar_url, avatar);
  assert.equal(product.creator.avatar_url, avatar);

  const creatorsResponse = await fetch(`${serverUrl(api)}/v1/public/creators`);
  const creators = await creatorsResponse.json();
  assert.equal(creators[0].avatar_url, avatar);

  const creatorResponse = await fetch(`${serverUrl(api)}/v1/public/creators/${catalogAgent.creator_id}`);
  const creator = await creatorResponse.json();
  assert.equal(creator.creator.avatar_url, avatar);
  assert.equal(creator.products[0].creator_avatar_url, avatar);
});

function registryFixture({
  signedIn,
  accessBodies = [],
  revokedEntitlements = [],
  agent = catalogAgent,
  creatorAgents,
  catalogAgents,
  missingCreatorAccountIds = new Set(),
  briefCalls = [],
  ingestCalls = []
}) {
  const publishedCreatorAgents = creatorAgents ?? [agent];
  const publishedCatalogAgents = catalogAgents ?? [agent];
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    const account = signedIn === "owner"
      ? { id: catalogAgent.creator_id, email: "creator@example.test", display_name: "Maya Chen" }
      : { id: "buyer-zero", email: "buyer@example.test", display_name: "Zero Buyer" };
    if (requestUrl.pathname === "/health" || requestUrl.pathname === "/readyz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: `signed-${signedIn}-token`, account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify(account));
      return;
    }
    if (requestUrl.pathname === "/v1/internal/creator-accounts") {
      const ids = new Set((requestUrl.searchParams.get("ids") ?? "").split(","));
      response.end(JSON.stringify({ accounts: publishedCatalogAgents
        .filter((entry) => ids.has(entry.creator_id) && !missingCreatorAccountIds.has(entry.creator_id))
        .map((entry) => ({ id: entry.creator_id, display_name: "Maya Chen" })) }));
      return;
    }
    if (requestUrl.pathname === "/v1/public/products") {
      response.end(JSON.stringify(publishedCatalogAgents));
      return;
    }
    if (requestUrl.pathname === "/v1/public/creators") {
      const creators = [...new Map(publishedCatalogAgents.map(entry => [entry.creator_id, {
        id: entry.creator_id,
        name: entry.creator_name,
        avatar_url: entry.creator_avatar_url ?? null
      }])).values()];
      response.end(JSON.stringify(creators));
      return;
    }
    if (requestUrl.pathname === `/v1/creator/products/${agent.product_id}/listing` && request.method === "PUT") {
      response.end(JSON.stringify({ product_id: agent.product_id, ...JSON.parse(content) }));
      return;
    }
    if (requestUrl.pathname === "/v1/creator/products") {
      response.end(JSON.stringify(publishedCreatorAgents));
      return;
    }
    if (requestUrl.pathname === `/v1/creator/products/${agent.product_id}/brief-spec` && request.method === "PUT") {
      const body = content ? JSON.parse(content) : {};
      briefCalls.push({ body, idempotencyKey: request.headers["idempotency-key"] });
      response.end(JSON.stringify({
        product_id: agent.product_id,
        name: agent.product_name,
        promise: agent.product_promise,
        status: "draft",
        brief_spec: body.brief_spec,
        updated_at: "2026-08-16T00:00:01.000Z"
      }));
      return;
    }
    if (requestUrl.pathname === `/v1/creator/products/${agent.product_id}/ingest/uploads` && request.method === "POST") {
      ingestCalls.push({ route: "uploads", body: JSON.parse(content), authorization: request.headers.authorization });
      response.statusCode = 201;
      response.end(JSON.stringify({ upload_id: "u1", url: "/v1/local-objects/k?sig=s", method: "PUT", headers: { "content-type": "video/mp4" } }));
      return;
    }
    if (requestUrl.pathname === "/v1/local-objects/k" && request.method === "PUT") {
      ingestCalls.push({ route: "put", query: requestUrl.search, contentType: request.headers["content-type"], bytes: content.length, authorization: request.headers.authorization });
      response.statusCode = 200;
      response.end("{}");
      return;
    }
    if (requestUrl.pathname === "/v1/user/product-access" && request.method === "GET") {
      response.end(JSON.stringify([]));
      return;
    }
    if (requestUrl.pathname === `/v1/user/products/${agent.product_id}/access`) {
      const accessBody = content ? JSON.parse(content) : {};
      accessBodies.push(accessBody);
      response.end(JSON.stringify({
        entitlement_id: accessBody.entitlement_id ?? "ent_zero",
        order_id: accessBody.order_id,
        user_id: "buyer-zero",
        creator_id: agent.creator_id,
        agent_id: agent.agent_id,
        product_id: agent.product_id,
        status: "active",
        granted_at: "2026-08-02T00:00:00.000Z"
      }));
      return;
    }
    const revokeMatch = requestUrl.pathname.match(/^\/v1\/user\/product-access\/([^/]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      revokedEntitlements.push(decodeURIComponent(revokeMatch[1]));
      response.end(JSON.stringify({ entitlement_id: decodeURIComponent(revokeMatch[1]), status: "revoked" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
}

async function login(server) {
  const response = await fetch(`${serverUrl(server)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "fixture@example.test", password: "test-only" })
  });
  return (await response.json()).token;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("an unlisted Agent leaves public listings but its detail page still resolves", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-unlisted-"));
  const unlisted = { ...catalogAgent, listed: false };
  const registry = registryFixture({ signedIn: "buyer", catalogAgents: [unlisted] });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const listing = await fetch(`${serverUrl(api)}/v1/public/products`);
  assert.deepEqual(await listing.json(), []);
  const creator = await fetch(`${serverUrl(api)}/v1/public/creators/${unlisted.creator_id}`);
  assert.equal(creator.status, 404);
  const detail = await fetch(`${serverUrl(api)}/v1/public/products/${unlisted.product_id}`);
  assert.equal(detail.status, 200);
});

test("Studio's unlisted toggle reaches the Registry listing route", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-listing-"));
  const registry = registryFixture({ signedIn: "owner" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const response = await fetch(`${serverUrl(api)}/v1/creator/products/${catalogAgent.product_id}/listing`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "listing-1" },
    body: JSON.stringify({ listed: false })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).listed, false);
});

test("a missing asset and an error are never cached, so a deploy's handover cannot stick in a browser", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-nocache-"));
  const registry = registryFixture({ signedIn: "buyer" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: serverUrl(registry) });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const missing = await fetch(`${serverUrl(api)}/assets/WebPage-missing.css`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
});
