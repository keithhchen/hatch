import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const catalogAgent = {
  creator_id: "maya-chen",
  creator_name: "Maya Chen",
  agent_id: "signal-resume-reviewer",
  product_id: "signal-resume-review",
  product_name: "Signal Resume Review",
  product_description: "Resume review",
  product_promise: "Turn a resume into a concise signal map.",
  product_boundaries: ["Does not submit applications."],
  product_offer: { model: "per_delivery", amount_minor: 0, currency: "USD" },
  presentation: { accent: "fern" },
  corpus_digest: "sha256:current-corpus",
  published_at: "2026-08-02T00:00:00.000Z"
};

test("creator products are projected directly from the Agent Corpus Registry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-creator-"));
  const logoutTokens = [];
  const registry = registryFixture({ role: "creator", logoutTokens });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    commerceServiceToken: "commerce-test-token"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const response = await fetch(`${serverUrl(api)}/v1/creator/overview`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const overview = await response.json();

  assert.equal(response.status, 200);
  assert.equal(overview.products[0].agent_id, catalogAgent.agent_id);
  assert.equal(overview.products[0].corpus_digest, catalogAgent.corpus_digest);
  assert.equal(overview.products[0].promise, catalogAgent.product_promise);
  assert.deepEqual(overview.products[0].boundaries, catalogAgent.product_boundaries);
  assert.equal(overview.products[0].status, "published");
  assert.equal(overview.metrics.orders, 0);

  const logout = await fetch(`${serverUrl(api)}/v1/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(logout.status, 204);
  assert.deepEqual(logoutTokens, [`Bearer ${token}`]);
});

test("zero-value checkout creates an idempotent Agent Corpus order and entitlement", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-checkout-"));
  const accessBodies = [];
  const registry = registryFixture({ role: "user", accessBodies });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    commerceServiceToken: "commerce-test-token"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const bypass = await fetch(`${serverUrl(api)}/v1/user/agents/${catalogAgent.creator_id}/${catalogAgent.agent_id}/access`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(bypass.status, 404);
  assert.equal(accessBodies.length, 0);

  const checkout = () => fetch(`${serverUrl(api)}/v1/user/checkout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ creator_id: catalogAgent.creator_id, product_id: catalogAgent.product_id })
  });

  const first = await checkout();
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstBody.order.agent_id, catalogAgent.agent_id);
  assert.equal(firstBody.order.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(firstBody.order.gross_minor, 0);
  assert.equal(firstBody.entitlement.entitlement_id, "ent_zero");
  assert.equal(accessBodies[0].order_id, firstBody.order.order_id);
  assert.deepEqual(dashboard.ledger.listEvents().map((event) => event.event_type), ["order.placed", "entitlement.granted"]);

  const replay = await checkout();
  assert.equal(replay.status, 200);
  assert.equal(dashboard.ledger.listEvents().length, 2);
});

test("checkout fails closed before writing an order when commerce service auth is missing", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-commerce-auth-"));
  const accessBodies = [];
  const registry = registryFixture({ role: "user", accessBodies });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    commerceServiceToken: ""
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const response = await fetch(`${serverUrl(api)}/v1/user/checkout`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ creator_id: catalogAgent.creator_id, product_id: catalogAgent.product_id })
  });
  assert.equal(response.status, 503);
  assert.deepEqual(dashboard.ledger.listEvents(), []);
  assert.deepEqual(accessBodies, []);
});

function registryFixture({ role, accessBodies = [], logoutTokens = [] }) {
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    const account = role === "creator"
      ? { id: "maya-chen", role: "creator", email: "creator@example.test", display_name: "Maya Chen" }
      : { id: "buyer-zero", role: "user", email: "buyer@example.test", display_name: "Zero Buyer" };
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: `signed-${role}-token`, account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify(account));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/logout" && request.method === "POST") {
      logoutTokens.push(request.headers.authorization);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (requestUrl.pathname === "/v1/catalog/agents" || requestUrl.pathname === "/v1/creator/agents") {
      response.end(JSON.stringify([catalogAgent]));
      return;
    }
    if (requestUrl.pathname === "/v1/user/agent-access" && request.method === "GET") {
      response.end(JSON.stringify([]));
      return;
    }
    if (requestUrl.pathname === "/v1/commerce/agent-access") {
      assert.equal(request.headers.authorization, "Bearer commerce-test-token");
      const accessBody = content ? JSON.parse(content) : {};
      accessBodies.push(accessBody);
      response.end(JSON.stringify({
        entitlement_id: "ent_zero",
        order_id: accessBody.order_id,
        user_id: accessBody.user_id,
        creator_id: accessBody.creator_id,
        agent_id: accessBody.agent_id,
        product_id: catalogAgent.product_id,
        status: "active",
        granted_at: "2026-08-02T00:00:00.000Z"
      }));
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
