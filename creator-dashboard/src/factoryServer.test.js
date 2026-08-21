import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

test("Dashboard BFF removes the legacy Factory API and forwards Product Node requests", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-factory-"));
  const forwarded = [];
  const registry = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "signed-creator-token",
        account: { id: "creator-factory", role: "creator", email: "creator@example.test", display_name: "Factory Creator" }
      }));
      return;
    }
    if (url.pathname === "/v1/auth/me") {
      response.end(JSON.stringify({ id: "creator-factory", role: "creator", email: "creator@example.test", display_name: "Factory Creator" }));
      return;
    }
    if (url.pathname === "/v1/creator/products/product-1/nodes/about-you/executions") {
      forwarded.push({ method: request.method, headers: request.headers, body: content ? JSON.parse(content) : undefined });
      response.statusCode = 202;
      response.end(JSON.stringify({ node: "about-you", product_id: "product-1", execution_id: "about_you_1", status: "queued", round: 1 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    factoryRequestMaxBytes: 512,
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const legacy = await fetch(`${serverUrl(api)}/v1/creator/factory-runs`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(legacy.status, 404);
  assert.equal(forwarded.length, 0);

  const response = await fetch(`${serverUrl(api)}/v1/creator/products/product-1/nodes/about-you/executions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "node-request-1"
    },
    body: JSON.stringify({ file_ids: ["file_1"] })
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).execution_id, "about_you_1");
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].headers.authorization, "Bearer signed-creator-token");
  assert.equal(forwarded[0].headers["idempotency-key"], "node-request-1");
  assert.deepEqual(forwarded[0].body, { file_ids: ["file_1"] });
  assert.equal("creator_id" in forwarded[0].body, false);
});

async function login(server) {
  const response = await fetch(`${serverUrl(server)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
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
