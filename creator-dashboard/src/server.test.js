import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
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

const readyFactoryRun = {
  id: "factory_ready_candidate",
  task_name: "Signal Resume Review",
  status: "ready",
  version: 1,
  agent_id: catalogAgent.agent_id,
  product: {
    id: catalogAgent.product_id,
    name: catalogAgent.product_name,
    description: catalogAgent.product_description,
    promise: catalogAgent.product_promise,
    boundaries: catalogAgent.product_boundaries,
    brief_spec: catalogAgent.brief_spec
  },
  candidate: {
    version: 1,
    corpus_digest: "sha256:candidate-corpus",
    system_digest: "sha256:candidate-system",
    corpus_verified: true,
    regression_digest: "sha256:regression-report",
    held_out_digest: "sha256:held-out-report",
    held_out_sample_count: 3,
    failed_critical_cases: 0,
    factory_version: "creator-factory-contract-1"
  },
  updated_at: "2026-08-03T00:00:00.000Z"
};

test("Dashboard readiness fails closed when Registry is unavailable", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-health-"));
  const registry = registryFixture({ role: "user" });
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

test("browser OAuth PKCE keeps state and authorizes Product Files without Version scope", async (context) => {
  const account = {
    id: catalogAgent.creator_id,
    role: "creator",
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
    if (requestUrl.pathname === "/v1/creator/products/product-1/files" && request.method === "GET") {
      response.end(JSON.stringify({ product_id: "product-1", files: [{ id: "file-1", product_id: "product-1" }] }));
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
  assert.match(consentHtml, /Create and update your Creator Products/);
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

  const files = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/files`, {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  assert.equal(files.status, 200);
  const filesBody = await files.json();
  assert.deepEqual(filesBody.product_id, "product-1");
  assert.deepEqual(filesBody.files, [{ id: "file-1", product_id: "product-1" }]);
  assert.match(filesBody.request_id, /^req_/);

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
  const limitedFilesWrite = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${limitedToken.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ display_name: "not-authorized.md", content_base64: "bm8=" })
  });
  assert.equal(limitedFilesWrite.status, 403);
  assert.equal((await limitedFilesWrite.json()).error.code, "oauth_scope_required");

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
  const filesAfterRestart = await fetch(`${serverUrl(restartedApi)}/v1/creator/products/product-1/files`, {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  assert.equal(filesAfterRestart.status, 200);
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
  const registry = registryFixture({ role: "creator" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
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

test("Creator can approve a verified candidate, preview, publish, and receive a share URL", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-publish-"));
  const publishCalls = [];
  const registry = registryFixture({ role: "creator", factoryRun: readyFactoryRun, publishCalls });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const productId = catalogAgent.product_id;
  const candidateId = readyFactoryRun.id;

  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  const candidate = (await candidateResponse.json()).candidate;
  assert.equal(candidateResponse.status, 200);
  assert.equal(candidate.corpus_verified, true);

  const approvalResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-signal-resume-v1" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const approved = (await approvalResponse.json()).product;
  assert.equal(approvalResponse.status, 200);
  assert.equal(approved.status, "ready_to_preview");
  const approvalReplay = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-signal-resume-v1" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  assert.equal(approvalReplay.status, 200);
  assert.equal((await approvalReplay.json()).product.version, approved.version);

  const previewResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/storefront-preview`, { headers });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.readiness.ready, true);
  assert.equal(preview.product.product_id, productId);

  const stalePublishResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-signal-resume-stale" },
    body: JSON.stringify({
      candidate_id: candidateId,
      expected_version: approved.version - 1
    })
  });
  assert.equal(stalePublishResponse.status, 409);
  assert.equal(publishCalls.length, 0);

  const publishBody = {
    candidate_id: candidateId,
    expected_version: approved.version
  };
  const publishResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-signal-resume-v1" },
    body: JSON.stringify(publishBody)
  });
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 201);
  assert.equal(published.product.status, "published");
  assert.equal(published.public_url, `/products/${productId}`);
  assert.equal(publishCalls.length, 1);
  const publicResponse = await fetch(`${serverUrl(api)}/v1/public/products/${productId}`);
  const publicProduct = (await publicResponse.json()).product;
  assert.equal(publicResponse.status, 200);
  assert.equal(publicProduct.available, true);
  const replayResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-signal-resume-v1" },
    body: JSON.stringify(publishBody)
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(publishCalls.length, 1);
  assert.equal(dashboard.ledger.listEvents().length, 0);
});

test("unified Release approves the current Factory candidate and publishes once", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-release-command-"));
  const publishCalls = [];
  const registry = registryFixture({ role: "creator", factoryRun: readyFactoryRun, publishCalls });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${catalogAgent.product_id}/candidates/${readyFactoryRun.id}`, { headers });
  const candidate = (await candidateResponse.json()).candidate;
  const response = await fetch(`${serverUrl(api)}/v1/creator/products/${catalogAgent.product_id}/release`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "release-command-v1" },
    body: JSON.stringify({
      candidate_id: readyFactoryRun.id,
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.product.status, "published");
  assert.equal(publishCalls.length, 1);
  assert.equal(dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, catalogAgent.product_id).status, "published");
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
  const registry = registryFixture({ role: "user", catalogAgents: [aliasedAgent] });
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

test("Factory-only first publish does not seed a fake legacy deployment", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-first-publish-"));
  const deploymentCalls = [];
  const registry = registryFixture({
    role: "creator",
    factoryRun: readyFactoryRun,
    creatorAgents: [],
    catalogAgents: [],
    deploymentCalls
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryDeploymentServiceToken: "test-deployment-service",
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const productId = readyFactoryRun.product.id;
  const candidateId = readyFactoryRun.id;
  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  let candidate = (await candidateResponse.json()).candidate;
  assert.equal(candidateResponse.status, 200);

  const rejectionResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/reject`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "reject-first-publish-candidate" },
    body: JSON.stringify({ expected_version: candidate.resource_version, reason: "review_again" })
  });
  assert.equal(rejectionResponse.status, 200);
  const rejected = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(rejected.release, undefined);
  assert.equal(rejected.active_deployment_id, undefined);

  const refreshedCandidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  candidate = (await refreshedCandidateResponse.json()).candidate;
  assert.equal(refreshedCandidateResponse.status, 200);

  const approvalResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-first-publish" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const approved = (await approvalResponse.json()).product;
  assert.equal(approvalResponse.status, 200);
  const unseeded = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(unseeded.release, undefined);
  assert.equal(unseeded.active_deployment_id, undefined);

  const publishResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-first-deployment" },
    body: JSON.stringify({
      candidate_id: candidateId,
      expected_version: approved.version
    })
  });
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 201, JSON.stringify(published));
  assert.equal(published.product.status, "published");
  assert.equal(published.release.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(deploymentCalls.filter((call) => call.type === "stage").length, 1);
  const activation = deploymentCalls.find((call) => call.type === "activate");
  assert.equal(activation.body.expected_current_digest, null);
  assert.equal(dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId).active_deployment_id, activation.body.operation_id);
});

test("legacy live storefront remains stable until its replacement deployment commits", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-legacy-migration-"));
  const deploymentCalls = [];
  const registry = registryFixture({
    role: "creator",
    factoryRun: readyFactoryRun,
    deploymentCalls,
    activationFailures: 1
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryDeploymentServiceToken: "test-deployment-service",
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const productId = catalogAgent.product_id;
  const candidateId = readyFactoryRun.id;
  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  const candidate = (await candidateResponse.json()).candidate;
  assert.equal(candidateResponse.status, 200);
  const approvalResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-legacy-replacement" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const approved = (await approvalResponse.json()).product;
  assert.equal(approvalResponse.status, 200);

  const seeded = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(seeded.release.corpus_digest, catalogAgent.corpus_digest);
  assert.match(seeded.active_deployment_id, /^migration:/);

  const interruptedResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-legacy-replacement" },
    body: JSON.stringify({
      candidate_id: candidateId,
      expected_version: approved.version
    })
  });
  assert.equal(interruptedResponse.status, 503);
  const pending = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(pending.release.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(pending.publish_operation.registry_activated_at, undefined);

  const duringResponse = await fetch(`${serverUrl(api)}/v1/public/products/${productId}`);
  const during = (await duringResponse.json()).product;
  assert.equal(duringResponse.status, 200);
  assert.equal(during.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(during.available, true);

  const reconciled = await dashboard.reconcileDeployments();
  assert.equal(reconciled[0].status, "published");
  const committed = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(committed.release.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.notEqual(committed.active_deployment_id, seeded.active_deployment_id);
  const activationCalls = deploymentCalls.filter((call) => call.type === "activate");
  assert.equal(activationCalls.length, 2);
  assert.equal(activationCalls[0].body.expected_current_digest, catalogAgent.corpus_digest);

  const afterResponse = await fetch(`${serverUrl(api)}/v1/public/products/${productId}`);
  const after = (await afterResponse.json()).product;
  assert.equal(afterResponse.status, 200);
  assert.equal(after.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(after.available, true);
});

test("deployment reconciler resumes after Registry activation failure without exposing a mixed storefront tuple", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-deployment-reconcile-"));
  const deploymentCalls = [];
  const registry = registryFixture({
    role: "creator",
    factoryRun: readyFactoryRun,
    deploymentCalls,
    activationFailures: 1
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryDeploymentServiceToken: "test-deployment-service"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const candidate = {
    candidate_id: readyFactoryRun.id,
    agent_id: catalogAgent.agent_id,
    digest: readyFactoryRun.candidate.corpus_digest,
    report_digest: "sha256:deployment-report",
    corpus_verified: true
  };
  const approved = await dashboard.portalState.approveCandidate(
    catalogAgent.creator_id,
    catalogAgent.product_id,
    candidate,
    0
  );
  const pending = await dashboard.portalState.beginPublishProduct(catalogAgent.creator_id, catalogAgent.product_id, {
    candidate_id: candidate.candidate_id,
    expected_version: approved.version,
    agent_id: catalogAgent.agent_id,
    command_key: "deployment-reconcile"
  });

  const interrupted = await dashboard.reconcileDeployments();
  assert.equal(interrupted[0].status, "pending");
  let state = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, catalogAgent.product_id);
  assert.equal(state.release, undefined);
  assert.ok(state.publish_operation.materialized_at);
  assert.equal(state.publish_operation.registry_activated_at, undefined);
  assert.equal(state.publish_operation.attempts, 1);

  const duringFailure = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.product_id}`);
  const duringProduct = (await duringFailure.json()).product;
  assert.equal(duringFailure.status, 200);
  assert.equal(duringProduct.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(duringProduct.available, true);

  const recovered = await dashboard.reconcileDeployments();
  assert.equal(recovered[0].status, "published");
  state = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, catalogAgent.product_id);
  assert.equal(state.publish_operation, undefined);
  assert.equal(state.release.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(state.active_deployment_id, pending.publish_operation.operation_id);
  assert.equal(deploymentCalls.filter((call) => call.type === "stage").length, 1);
  assert.equal(deploymentCalls.filter((call) => call.type === "activate").length, 2);
  assert.equal(dashboard.ledger.listEvents().length, 0);

  const afterRecovery = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.product_id}`);
  const recoveredProduct = (await afterRecovery.json()).product;
  assert.equal(recoveredProduct.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(recoveredProduct.available, true);
});

test("zero-value checkout creates an idempotent Agent Corpus order and entitlement", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-checkout-"));
  const accessBodies = [];
  const registry = registryFixture({ role: "user", accessBodies });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const checkout = (intentKey = "legacy-free-checkout-one") => fetch(`${serverUrl(api)}/v1/user/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": intentKey
    },
    body: JSON.stringify({ creator_id: catalogAgent.creator_id, product_id: catalogAgent.product_id })
  });

  const first = await checkout();
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstBody.order.agent_id, catalogAgent.agent_id);
  assert.equal(firstBody.order.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(firstBody.order.gross_minor, 0);
  assert.match(firstBody.entitlement.entitlement_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(accessBodies.length, 0);
  assert.deepEqual(dashboard.ledger.listEvents().map((event) => event.event_type), [
    "order.placed",
    "entitlement.granted"
  ]);

  const replay = await checkout();
  assert.equal(replay.status, 200);
  assert.equal(dashboard.ledger.listEvents().length, 2);

  const secondPurchase = await checkout("legacy-free-checkout-two");
  const secondBody = await secondPurchase.json();
  assert.equal(secondPurchase.status, 201);
  assert.notEqual(secondBody.order.order_id, firstBody.order.order_id);
  assert.notEqual(secondBody.entitlement.entitlement_id, firstBody.entitlement.entitlement_id);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "order.placed").length, 2);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "entitlement.granted").length, 2);
});

test("V2 checkout session persists a free receipt and entitlement detail", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-v2-checkout-"));
  const accessBodies = [];
  const revokedEntitlements = [];
  const registry = registryFixture({ role: "user", accessBodies, revokedEntitlements });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "checkout-session-free" };

  const detailResponse = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.product_id}`);
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.product.available, true);
  assert.equal(detail.product.availability, "published");
  assert.equal("offer" in detail.product, false);
  const canonicalDetailResponse = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.product_id}`);
  const canonicalDetail = await canonicalDetailResponse.json();
  assert.equal(canonicalDetailResponse.status, 200);
  assert.equal(canonicalDetail.product.availability, "published");
  assert.equal("offer" in canonicalDetail.product, false);

  const createSession = () => fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      product_id: catalogAgent.product_id
    })
  });
  const firstSessionResponse = await createSession();
  const firstSession = (await firstSessionResponse.json()).checkout_session;
  assert.equal(firstSessionResponse.status, 201);
  assert.equal(firstSession.totals.total_minor, 0);
  const replaySessionResponse = await createSession();
  assert.equal(replaySessionResponse.status, 200);
  assert.equal((await replaySessionResponse.json()).checkout_session.checkout_session_id, firstSession.checkout_session_id);

  const confirm = () => fetch(`${serverUrl(api)}/v1/checkout-sessions/${firstSession.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  const confirmedResponse = await confirm();
  const confirmed = await confirmedResponse.json();
  assert.equal(confirmedResponse.status, 201);
  assert.equal(confirmed.payment.status, "not_required");
  assert.equal(confirmed.order.status, "fulfilled");
  assert.equal(confirmed.entitlement.access_mode, "unmetered");
  assert.equal("remaining_units" in confirmed.entitlement, false);
  assert.equal(accessBodies.length, 0);

  const replayConfirmResponse = await confirm();
  assert.equal(replayConfirmResponse.status, 200);
  assert.equal((await replayConfirmResponse.json()).order_id, confirmed.order_id);

  const orderResponse = await fetch(`${serverUrl(api)}/v1/user/orders/${confirmed.order_id}`, { headers });
  const order = (await orderResponse.json()).order;
  assert.equal(orderResponse.status, 200);
  assert.equal(order.payment_status, "not_required");
  assert.equal(order.subtotal_minor, 0);
  assert.equal(order.discount_minor, 0);
  assert.equal(order.tax_minor, null);
  assert.equal(order.total_minor, 0);
  assert.equal(order.entitlement_status, "active");
  assert.equal(order.access_mode, "unmetered");
  assert.equal("delivery_status" in order, false);
  assert.equal(order.actions.can_request_refund, false);
  assert.equal(order.actions.can_cancel_access, false);

  const canonicalOrdersResponse = await fetch(`${serverUrl(api)}/v1/orders`, { headers });
  const canonicalOrders = await canonicalOrdersResponse.json();
  assert.equal(canonicalOrdersResponse.status, 200);
  assert.equal(canonicalOrders.orders.length, 1);
  const canonicalOrderResponse = await fetch(`${serverUrl(api)}/v1/orders/${encodeURIComponent(order.order_number ?? confirmed.order_id)}`, { headers });
  assert.equal(canonicalOrderResponse.status, 200);
  assert.equal((await canonicalOrderResponse.json()).order.order_id, confirmed.order_id);
  const canonicalLibraryResponse = await fetch(`${serverUrl(api)}/v1/library`, { headers });
  const canonicalLibrary = await canonicalLibraryResponse.json();
  assert.equal(canonicalLibraryResponse.status, 200);
  assert.equal(canonicalLibrary.entitlements.length, 1);

  const entitlementResponse = await fetch(`${serverUrl(api)}/v1/user/entitlements/${confirmed.entitlement_id}`, { headers });
  const entitlement = (await entitlementResponse.json()).entitlement;
  assert.equal(entitlementResponse.status, 200);
  assert.equal(entitlement.product.name, catalogAgent.product_name);
  assert.equal(entitlement.access_mode, "unmetered");
  assert.equal("remaining_units" in entitlement, false);
  assert.equal("deliveries" in entitlement, false);
  const canonicalEntitlementResponse = await fetch(`${serverUrl(api)}/v1/library/${confirmed.entitlement_id}`, { headers });
  assert.equal(canonicalEntitlementResponse.status, 200);
  assert.equal((await canonicalEntitlementResponse.json()).entitlement.entitlement_id, confirmed.entitlement_id);

  const desktopPreflight = await fetch(`${serverUrl(api)}/v1/user/product-access`, {
    method: "OPTIONS",
    headers: { origin: "tauri://localhost", "access-control-request-headers": "authorization" }
  });
  assert.equal(desktopPreflight.status, 204);
  assert.equal(desktopPreflight.headers.get("access-control-allow-origin"), "*");
  assert.match(desktopPreflight.headers.get("access-control-allow-headers"), /authorization/);
  const desktopAccessResponse = await fetch(`${serverUrl(api)}/v1/user/product-access`, { headers });
  const desktopAccess = await desktopAccessResponse.json();
  assert.equal(desktopAccessResponse.status, 200);
  assert.equal(desktopAccessResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(desktopAccess.creator_agents.length, 1);
  assert.equal(desktopAccess.creator_agents[0].entitlement_id, confirmed.entitlement_id);
  assert.equal(desktopAccess.creator_agents[0].user_id, "buyer-zero");
  assert.equal(desktopAccess.creator_agents[0].product.id, catalogAgent.product_id);
  assert.equal(desktopAccess.creator_agents[0].access_mode, "unmetered");
  assert.equal("remaining_units" in desktopAccess.creator_agents[0], false);

  const secondTurnAuthorization = dashboard.commerce.getEntitlement(confirmed.entitlement_id);
  assert.equal(secondTurnAuthorization.access_mode, "unmetered");
  assert.equal(secondTurnAuthorization.status, "active");
  assert.deepEqual(revokedEntitlements, []);
});

test("a zero-price purchase is permanent and has no buyer cancellation action", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-free-cancel-"));
  const revokedEntitlements = [];
  const registry = registryFixture({ role: "user", revokedEntitlements });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "free-cancel" };
  const detailResponse = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.product_id}`);
  const sessionResponse = await fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ product_id: catalogAgent.product_id })
  });
  const session = (await sessionResponse.json()).checkout_session;
  const confirmationResponse = await fetch(`${serverUrl(api)}/v1/checkout-sessions/${session.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  const confirmation = await confirmationResponse.json();
  assert.equal(confirmationResponse.status, 201, JSON.stringify(confirmation));

  const cancellationResponse = await fetch(`${serverUrl(api)}/v1/orders/${confirmation.order_id}/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "buyer_removed_free_access" })
  });
  const cancellation = await cancellationResponse.json();
  assert.equal(cancellationResponse.status, 409);
  assert.equal(cancellation.error.code, "unmetered_purchase_not_reversible");
  assert.deepEqual(revokedEntitlements, []);

  const refundRequestResponse = await fetch(`${serverUrl(api)}/v1/orders/${confirmation.order_id}/refund-requests`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "free-refund-request" },
    body: JSON.stringify({ reason: "buyer_requested" })
  });
  const refundRequest = await refundRequestResponse.json();
  assert.equal(refundRequestResponse.status, 409);
  assert.equal(refundRequest.error.code, "unmetered_purchase_not_reversible");
  assert.deepEqual(revokedEntitlements, []);

  const orderResponse = await fetch(`${serverUrl(api)}/v1/orders/${confirmation.order_id}`, { headers });
  const order = (await orderResponse.json()).order;
  assert.equal(order.entitlement_status, "active");
  assert.equal(order.actions.can_cancel_access, false);
});

test("Creator fulfilled filter includes delivered orders and disconnected payouts do not invent balances", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-creator-delivery-"));
  const registry = registryFixture({ role: "creator" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  await dashboard.commerce.createPayment({
    payment_id: "pay-creator-filter",
    buyer_id: "buyer-creator-filter",
    creator_id: catalogAgent.creator_id,
    product_id: catalogAgent.product_id,
    amount_minor: 3900,
    currency: "USD",
    provider: "test-provider",
    idempotency_key: "payment:creator-filter"
  });
  await dashboard.commerce.recordPaymentProviderEvent({
    payment_id: "pay-creator-filter",
    provider: "test-provider",
    provider_event_id: "payment-event-creator-filter",
    provider_payment_id: "provider-pay-creator-filter",
    status: "succeeded"
  });
  const checkout = await dashboard.commerce.confirmCheckout({
    buyer_id: "buyer-creator-filter",
    buyer_display_name: "Delivery Buyer",
    creator_id: catalogAgent.creator_id,
    creator_display_name: catalogAgent.creator_name,
    agent_id: catalogAgent.agent_id,
    product_id: catalogAgent.product_id,
    product_name: catalogAgent.product_name,
    corpus_digest: catalogAgent.corpus_digest,
    release_id: catalogAgent.corpus_digest,
    gross_minor: 3900,
    currency: "USD",
    payment_status: "paid",
    payment_id: "pay-creator-filter",
    included_units: 1,
    idempotency_key: "checkout:creator-filter"
  });
  await recordDelivery(dashboard, checkout, { prefix: "creator-filter", artifactType: "pdf" });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}` };

  const ordersResponse = await fetch(`${serverUrl(api)}/v1/creator/orders?order=fulfilled`, { headers });
  const orders = (await ordersResponse.json()).orders;
  assert.equal(ordersResponse.status, 200);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "delivered");
  assert.equal(orders[0].delivery_status, "completed");

  const exportResponse = await fetch(`${serverUrl(api)}/v1/creator/orders/export?order=fulfilled`, { headers });
  const exported = await exportResponse.text();
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-type"), /^text\/csv/);
  assert.match(exportResponse.headers.get("content-disposition"), /hatch-creator-orders\.csv/);
  assert.match(exported, /order_reference,buyer_display_name,product_id/);
  assert.match(exported, /Delivery Buyer/);
  assert.match(exported, /pdf/);
  for (const privateField of ["prompt", "workspace", "artifact_path", "conversation", "tool_arguments", "file_content"]) {
    assert.doesNotMatch(exported.toLowerCase(), new RegExp(privateField));
  }

  const payoutsResponse = await fetch(`${serverUrl(api)}/v1/creator/payouts`, { headers });
  const payouts = await payoutsResponse.json();
  assert.equal(payoutsResponse.status, 200);
  assert.equal(payouts.account_status, "not_connected");
  assert.equal(payouts.balance_status, "unavailable");
  assert.equal(payouts.setup_available, false);
  assert.equal(payouts.available_minor, null);
  assert.equal(payouts.pending_minor, null);
  assert.deepEqual(payouts.payouts, []);
});

async function recordDelivery(app, checkout, { prefix, artifactType }) {
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
    artifact_type: artifactType,
    delivery_id: deliveryId,
    idempotency_key: `delivery:${prefix}`
  });
}

function registryFixture({
  role,
  accessBodies = [],
  revokedEntitlements = [],
  agent = catalogAgent,
  creatorAgents,
  catalogAgents,
  factoryRun = null,
  publishCalls = [],
  deploymentCalls = [],
  activationFailures = 0
}) {
  let remainingActivationFailures = activationFailures;
  const publishedCreatorAgents = creatorAgents ?? [agent];
  const publishedCatalogAgents = catalogAgents ?? [agent];
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    const account = role === "creator"
      ? { id: catalogAgent.creator_id, role: "creator", email: "creator@example.test", display_name: "Maya Chen" }
      : { id: "buyer-zero", role: "user", email: "buyer@example.test", display_name: "Zero Buyer" };
    if (requestUrl.pathname === "/health" || requestUrl.pathname === "/readyz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: `signed-${role}-token`, account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify(account));
      return;
    }
    if (requestUrl.pathname === "/v1/public/products") {
      response.end(JSON.stringify(publishedCatalogAgents));
      return;
    }
    if (requestUrl.pathname === "/v1/creator/products") {
      response.end(JSON.stringify(publishedCreatorAgents));
      return;
    }
    if (requestUrl.pathname === "/v1/creator/factory-runs" && request.method === "GET") {
      response.end(JSON.stringify({ runs: factoryRun ? [factoryRun] : [] }));
      return;
    }
    if (factoryRun && requestUrl.pathname === `/v1/creator/factory-runs/${factoryRun.id}` && request.method === "GET") {
      response.end(JSON.stringify(factoryRun));
      return;
    }
    if (factoryRun && requestUrl.pathname === `/v1/creator/factory-runs/${factoryRun.id}/publish` && request.method === "POST") {
      publishCalls.push(content ? JSON.parse(content) : {});
      response.end(JSON.stringify({ ...agent, corpus_digest: factoryRun.candidate.corpus_digest }));
      return;
    }
    if (factoryRun
      && requestUrl.pathname === `/v1/internal/deployments/factory-runs/${factoryRun.id}/stage`
      && request.method === "POST") {
      const body = content ? JSON.parse(content) : {};
      deploymentCalls.push({ type: "stage", body });
      response.end(JSON.stringify({
        agent_corpus: { ...agent, corpus_digest: factoryRun.candidate.corpus_digest },
        current: false,
        operation_id: body.operation_id
      }));
      return;
    }
    const deploymentActivate = requestUrl.pathname.match(/^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/releases\/([^/]+)\/activate$/);
    if (deploymentActivate && request.method === "POST") {
      const body = content ? JSON.parse(content) : {};
      deploymentCalls.push({ type: "activate", body });
      if (remainingActivationFailures > 0) {
        remainingActivationFailures -= 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ code: "registry_temporarily_unavailable", detail: "activation interrupted" }));
        return;
      }
      response.end(JSON.stringify({
        agent_corpus: {
          ...agent,
          agent_id: decodeURIComponent(deploymentActivate[1]),
          corpus_digest: decodeURIComponent(deploymentActivate[2])
        },
        current: true,
        operation_id: body.operation_id
      }));
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
