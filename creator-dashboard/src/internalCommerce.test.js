import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

test("Runtime's Commerce surface is the library save and the library list, both service-authenticated", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-internal-commerce-"));
  const digest = `sha256:${"a".repeat(64)}`;
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: "http://127.0.0.1:1",
    registryDeploymentServiceToken: "registry-deployment-secret",
    commerceRuntimeServiceToken: "runtime-commerce-secret"
  });
  await dashboard.commerce.confirmCheckout({
    buyer_id: "buyer-internal",
    creator_id: "creator-internal",
    agent_id: "product-internal",
    product_id: "product-internal",
    corpus_digest: digest,
    release_id: digest,
    gross_minor: 0,
    currency: "USD",
    version_policy: "pinned",
    idempotency_key: "library-internal"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const base = `http://127.0.0.1:${api.address().port}`;
  const call = (pathname, token, init = {}) => fetch(`${base}${pathname}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }
  });

  const listPath = "/v1/internal/access/users/buyer-internal/entitlements";
  assert.equal((await call(listPath)).status, 403);
  assert.equal((await call(listPath, "wrong")).status, 403);
  const listed = await (await call(listPath, "runtime-commerce-secret")).json();
  assert.deepEqual(listed.entitlements.map((entry) => [entry.user_id, entry.product_id, entry.status]), [["buyer-internal", "product-internal", "active"]]);

  // The metered-delivery surface is gone, even for the Runtime's own credential.
  for (const [method, route] of [
    ["POST", "/v1/internal/commerce/events"], ["POST", "/v1/internal/commerce/authorize-and-reserve"],
    ["POST", "/v1/internal/commerce/deliveries"], ["GET", "/v1/internal/commerce/operations"],
    ["POST", "/v1/internal/commerce/reconcile-revenue"], ["GET", "/v1/internal/access/entitlements/x?user_id=buyer-internal"]
  ]) {
    const response = await call(route, "runtime-commerce-secret", { method, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 404, `${method} ${route}`);
  }
});
