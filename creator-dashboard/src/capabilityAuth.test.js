import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const DENIED_CASES = [
  ["product:read", "GET", "/v1/creator/products"],
  ["product:read", "GET", "/v1/creator/factory-drafts/draft-1"],
  ["product:read", "GET", "/v1/creator/factory-runs/run-1"],
  ["product:read", "GET", "/v1/creator/products/product-1/releases"],
  ["product:edit", "POST", "/v1/creator/factory-drafts"],
  ["product:edit", "PATCH", "/v1/creator/factory-drafts/draft-1"],
  ["product:edit", "POST", "/v1/creator/factory-runs/run-1/retry"],
  ["release:approve", "POST", "/v1/creator/products/product-1/candidates/run-1/approve"],
  ["release:publish", "POST", "/v1/creator/products/product-1/publish"],
  ["release:publish", "POST", "/v1/creator/products/product-1/release"],
  ["release:rollback", "POST", "/v1/creator/products/product-1/releases/release-1/rollback"],
  ["commerce:read", "GET", "/v1/creator/orders"],
  ["commerce:export", "GET", "/v1/creator/orders/export"],
  ["refund:create", "POST", "/v1/creator/orders/order-1/refund-requests"],
  ["payout:read", "GET", "/v1/creator/payouts"],
  ["payout:manage", "POST", "/v1/creator/payout-account-sessions"]
];

test("Creator capability matrix rejects every privileged route before side effects", async (context) => {
  const unexpectedRegistryRequests = [];
  const registry = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/readyz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/v1/auth/me") {
      response.end(JSON.stringify({
        id: "creator-limited",
        role: "creator",
        display_name: "Limited Creator",
        // A non-empty explicit list replaces role defaults. This account can
        // authenticate but has none of the Commerce/Release capabilities.
        capabilities: ["profile:read"]
      }));
      return;
    }
    unexpectedRegistryRequests.push(`${request.method} ${request.url}`);
    response.statusCode = 500;
    response.end(JSON.stringify({ detail: "privileged route reached Registry" }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-capabilities-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  for (const [capability, method, pathname] of DENIED_CASES) {
    const response = await fetch(`${serverUrl(api)}${pathname}`, {
      method,
      headers: {
        authorization: "Bearer creator-limited-token",
        "content-type": "application/json",
        "idempotency-key": `deny-${capability}`
      },
      ...(method === "GET" ? {} : { body: JSON.stringify({ reason: "must not run" }) })
    });
    const body = await response.json();
    assert.equal(response.status, 403, `${method} ${pathname}: ${JSON.stringify(body)}`);
    assert.equal(body.error.code, "capability_required");
    assert.match(body.error.message, new RegExp(capability.replace(":", "\\:")));
  }

  assert.deepEqual(unexpectedRegistryRequests, []);
  assert.equal(dashboard.ledger.listEvents().length, 0);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
