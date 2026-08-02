import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";
import { writeProductCatalogSnapshot } from "./catalog-import.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceFactoryOutput = path.join(repositoryRoot, "docs/proof/creator-factory-e2e-v1");
const releaseId = "signal-resume-review@1.0.0";
const releaseDigest = "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5";

test("publishing sends only immutable identity and a repeated publish after restart is explicit", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-api-"));
  const factoryOutput = path.join(directory, "factory-output");
  await cp(sourceFactoryOutput, factoryOutput, { recursive: true });
  const passingEvidence = JSON.stringify({
    release_id: releaseId,
    release_digest: releaseDigest,
    passed: true
  });
  const passingComparison = JSON.stringify({
    release_id: releaseId,
    release_digest: releaseDigest,
    passed: true,
    gate: { passed: true },
    summary: {
      creator_agent: { pass_rate: 0.9 },
      generic_baseline: { pass_rate: 0.5 },
      delta: 0.4
    }
  });
  await writeFile(path.join(factoryOutput, "review/runtime-results.json"), passingEvidence);
  await writeFile(path.join(factoryOutput, "review/comparison-results.json"), passingComparison);

  const productCatalogPath = path.join(directory, "product-catalog.json");
  await writeProductCatalogSnapshot([factoryOutput], productCatalogPath);

  let registryRequestPath;
  let registryRequestHeaders;
  let registryRequestCount = 0;
  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "signed-maya-token",
        account: { id: "maya-chen", role: "creator", email: "creator@example.test", display_name: "Fixture Creator" }
      }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify({ id: "maya-chen", role: "creator", email: "creator@example.test", display_name: "Fixture Creator" }));
      return;
    }
    registryRequestCount += 1;
    registryRequestPath = requestUrl.pathname;
    registryRequestHeaders = request.headers;
    if (requestUrl.pathname === "/v1/catalog/agents") {
      response.end(JSON.stringify([{
        creator_id: "maya-chen",
        agent_id: "signal-resume-review",
        product_id: "signal-resume-review",
        corpus_digest: "sha256:corpus",
        published_at: "2026-07-31T10:00:00Z"
      }]));
      return;
    }
    response.end(JSON.stringify({
      creator_id: "maya-chen",
      product_id: "signal-resume-review",
      release_id: releaseId,
      release_digest: releaseDigest,
      version: "1.0.0",
      creator: { id: "maya-chen", name: "Maya Chen" },
      product: {},
      presentation: {},
      published_at: "2026-07-31T10:00:00Z",
      status: "published"
    }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const dashboardOptions = {
    fixture: {
      profiles: [{
        email: "creator@example.test",
        password: "test-only",
        id: "maya-chen",
        role: "creator",
        display_name: "Fixture Creator",
        handle: "@fixture",
        initials: "FC"
      }]
    },
    productCatalogPath,
    ledgerPath: path.join(directory, "ledger.jsonl"),
    productStatePath: path.join(directory, "product-state.json"),
    registryUrl: serverUrl(registry),
    registryPublishServiceToken: "registry-service-test-token"
  };
  const dashboard = await createDashboardApp(dashboardOptions);
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  const { token } = await login.json();
  const publish = await fetch(`${serverUrl(api)}/v1/creator/products/signal-resume-review/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(publish.status, 200);
  assert.equal(registryRequestPath, "/v1/catalog/agents");
  assert.equal(registryRequestHeaders.authorization, "Bearer registry-service-test-token");
  assert.equal(dashboard.ledger.listEvents().length, 0);

  const overview = await fetch(`${serverUrl(api)}/v1/creator/overview`, {
    headers: { authorization: `Bearer ${token}` }
  }).then((response) => response.json());
  assert.equal(overview.products[0].status, "published");
  assert.equal(overview.metrics.orders, 0);
  assert.equal(overview.metrics.creator_share_minor, 0);

  const restartedDashboard = await createDashboardApp(dashboardOptions);
  const restartedApi = createServer(restartedDashboard.handler);
  await listen(restartedApi);
  context.after(() => restartedApi.close());
  const restartedLogin = await fetch(`${serverUrl(restartedApi)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  const { token: restartedToken } = await restartedLogin.json();
  const duplicate = await fetch(`${serverUrl(restartedApi)}/v1/creator/products/signal-resume-review/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${restartedToken}` }
  });
  const duplicateBody = await duplicate.json();

  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicateBody, {
    error: {
      code: "already_published",
      message: "This exact product release is already published.",
      release_id: releaseId,
      release_digest: releaseDigest,
      published_at: "2026-07-31T10:00:00Z"
    }
  });
  assert.equal(registryRequestCount, 1);
});

test("zero-value checkout creates an idempotent order and entitlement", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-checkout-"));
  const productCatalogPath = path.join(directory, "product-catalog.json");
  await writeProductCatalogSnapshot([sourceFactoryOutput], productCatalogPath);

  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "signed-user-token",
        account: { id: "buyer-zero", role: "user", email: "buyer@example.test", display_name: "Zero Buyer" }
      }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify({ id: "buyer-zero", role: "user", email: "buyer@example.test", display_name: "Zero Buyer" }));
      return;
    }
    if (requestUrl.pathname === "/v1/catalog/agents") {
      response.end(JSON.stringify([{
        creator_id: "maya-chen",
        agent_id: "signal-resume-reviewer",
        product_id: "signal-resume-review",
        product_name: "Signal Resume Review",
        product_description: "Resume review"
      }]));
      return;
    }
    if (requestUrl.pathname === "/v1/user/agent-access" && request.method === "GET") {
      response.end(JSON.stringify([{
        entitlement_id: "ent_zero",
        user_id: "buyer-zero",
        creator_id: "maya-chen",
        agent_id: "signal-resume-reviewer",
        product_id: "signal-resume-review",
        status: "active",
        granted_at: "2026-08-02T00:00:00.000Z"
      }]));
      return;
    }
    if (requestUrl.pathname === "/v1/user/agents/maya-chen/signal-resume-reviewer/access") {
      response.end(JSON.stringify({
        entitlement_id: "ent_zero",
        user_id: "buyer-zero",
        creator_id: "maya-chen",
        agent_id: "signal-resume-reviewer",
        product_id: "signal-resume-review",
        status: "active",
        granted_at: "2026-08-02T00:00:00.000Z"
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const dashboard = await createDashboardApp({
    productCatalogPath,
    ledgerPath: path.join(directory, "ledger.jsonl"),
    productStatePath: path.join(directory, "product-state.json"),
    registryUrl: serverUrl(registry),
    registryPublishServiceToken: "registry-service-test-token"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "buyer@example.test", password: "test-only" })
  });
  const { token } = await login.json();
  const library = await fetch(`${serverUrl(api)}/v1/user/agents`, {
    headers: { authorization: `Bearer ${token}` }
  }).then((response) => response.json());
  assert.equal(library.creator_agents[0].agent_id, "signal-resume-reviewer");
  const checkout = (body = { creator_id: "maya-chen", product_id: "signal-resume-review" }) => fetch(`${serverUrl(api)}/v1/user/checkout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const first = await checkout();
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstBody.order.gross_minor, 0);
  assert.equal(firstBody.payment.status, "paid");
  assert.equal(firstBody.entitlement.entitlement_id, "ent_zero");
  assert.deepEqual(dashboard.ledger.listEvents().map((event) => event.event_type), ["order.placed", "entitlement.granted"]);

  const replay = await checkout();
  assert.equal(replay.status, 200);
  assert.equal(dashboard.ledger.listEvents().length, 2);
  const orders = await fetch(`${serverUrl(api)}/v1/user/orders`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.json());
  assert.equal(orders.orders.length, 1);
  assert.equal(orders.orders[0].entitlement_id, "ent_zero");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("creator voice proxy relays upload, status, and revocation to the Registry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-voice-"));
  const productCatalogPath = path.join(directory, "product-catalog.json");
  await writeFile(productCatalogPath, JSON.stringify({ schema_version: "1", products: [] }, null, 2));
  process.env.HATCH_CREATOR_DASHBOARD_ALLOW_EMPTY_CATALOG = "1";

  let voiceMethod;
  let voicePath;
  let voiceAuthorization;
  let voiceContentType;
  let voiceBodyBytes = 0;
  const registry = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    voiceMethod = request.method;
    voicePath = requestUrl.pathname;
    voiceAuthorization = request.headers.authorization;
    voiceContentType = request.headers["content-type"];
    voiceBodyBytes = Buffer.concat(chunks).byteLength;
    response.setHeader("content-type", "application/json");
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: "signed-maya-token", account: { id: "maya-chen", role: "creator", display_name: "Maya Chen" } }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify({ id: "maya-chen", role: "creator", display_name: "Maya Chen" }));
      return;
    }
    if (request.method === "PUT") {
      response.end(JSON.stringify({ voice_id: "v_test", creator_id: "maya-chen", provider: "elevenlabs", status: "active" }));
      return;
    }
    if (request.method === "DELETE") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (requestUrl.pathname.endsWith("/voice")) {
      response.end(JSON.stringify({ voice_id: "v_test", creator_id: "maya-chen", provider: "elevenlabs", status: "active" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const dashboard = await createDashboardApp({
    fixture: { profiles: [{ email: "creator@example.test", password: "test-only", id: "maya-chen", role: "creator", display_name: "Maya Chen" }] },
    productCatalogPath,
    ledgerPath: path.join(directory, "ledger.jsonl"),
    productStatePath: path.join(directory, "product-state.json"),
    registryUrl: serverUrl(registry),
    registryPublishServiceToken: "registry-service-test-token"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}` };

  const status = await fetch(`${serverUrl(api)}/v1/creator/voice`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).voice_id, "v_test");
  assert.equal(voicePath, "/v1/creators/maya-chen/voice");

  const boundary = "----voice-test-boundary";
  const form = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="v.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n\xff\xfb\x90\x64\r\n--${boundary}\r\nContent-Disposition: form-data; name="consent_version"\r\n\r\nv1\r\n--${boundary}--\r\n`
  );
  const upload = await fetch(`${serverUrl(api)}/v1/creator/voice`, {
    method: "PUT",
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    body: form
  });
  assert.equal(upload.status, 201);
  assert.equal((await upload.json()).provider, "elevenlabs");
  assert.equal(voiceMethod, "PUT");
  assert.ok(voiceContentType.includes("multipart/form-data"));
  assert.ok(voiceBodyBytes > 50);

  const removal = await fetch(`${serverUrl(api)}/v1/creator/voice`, { method: "DELETE", headers });
  assert.equal(removal.status, 204);
  assert.equal(voiceMethod, "DELETE");
  assert.equal(voiceAuthorization, `Bearer ${token}`);
});
