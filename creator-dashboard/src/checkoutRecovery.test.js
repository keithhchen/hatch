import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const agent = {
  creator_id: "creator-recovery",
  creator_name: "Recovery Creator",
  agent_id: "recovery-agent",
  product_id: "recovery-product",
  product_name: "Recovery Product",
  product_description: "A recoverable free delivery.",
  product_promise: "Recover access without creating another order.",
  product_boundaries: ["One delivery."],
  product_offer: { model: "per_delivery", amount_minor: 0, currency: "USD", included_units: 1 },
  corpus_digest: "sha256:recovery-corpus"
};

test("confirmed checkout survives Registry outage and reconciles access idempotently", async (context) => {
  let grantAttempts = 0;
  const grants = [];
  const registry = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "buyer-recovery-token",
        account: { id: "buyer-recovery", role: "user", display_name: "Recovery Buyer" }
      }));
      return;
    }
    if (request.url === "/v1/auth/me") {
      response.end(JSON.stringify({ id: "buyer-recovery", role: "user", display_name: "Recovery Buyer" }));
      return;
    }
    if (request.url === "/v1/catalog/agents") {
      response.end(JSON.stringify([agent]));
      return;
    }
    if (request.url === `/v1/user/agents/${agent.creator_id}/${agent.agent_id}/access`) {
      grantAttempts += 1;
      const input = JSON.parse(body);
      if (grantAttempts === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ detail: "temporary Registry outage" }));
        return;
      }
      grants.push(input);
      response.end(JSON.stringify({
        ...input,
        creator_id: agent.creator_id,
        agent_id: agent.agent_id,
        product_id: agent.product_id,
        status: "active"
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-checkout-recovery-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal.json"),
    registryUrl: serverUrl(registry),
    registryAccessServiceToken: "access-service",
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "buyer@example.test", password: "test-only" })
  });
  const token = (await login.json()).token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "recovery-checkout"
  };
  const detailResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${agent.creator_id}/${agent.product_id}`);
  const detail = (await detailResponse.json()).agent;
  const created = await fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ product_id: agent.product_id, offer_id: detail.offer.offer_id })
  });
  const session = (await created.json()).checkout_session;

  const firstConfirm = await fetch(`${serverUrl(api)}/v1/checkout-sessions/${session.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  assert.equal(firstConfirm.status, 503);
  assert.equal(dashboard.portalState.getCheckoutSession(session.checkout_session_id).status, "fulfillment_pending");
  assert.deepEqual(dashboard.ledger.listEvents().map((event) => event.event_type), [
    "offer.revision_created",
    "offer.activated",
    "order.placed",
    "entitlement.granted"
  ]);

  const reconciled = await dashboard.reconcilePendingCheckouts();
  assert.equal(reconciled[0].status, "completed");
  assert.equal(dashboard.portalState.getCheckoutSession(session.checkout_session_id).status, "completed");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].purchased_corpus_digest, agent.corpus_digest);

  const replay = await fetch(`${serverUrl(api)}/v1/checkout-sessions/${session.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  assert.equal(replay.status, 200);
  assert.ok((await replay.json()).order_id);
  assert.equal(dashboard.ledger.listEvents().length, 4);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
