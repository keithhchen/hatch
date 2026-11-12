import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRegistryServerFromEnvironment } from "../registryServer.js";

// The harness Registry has no Postgres, so the ingest service itself is absent: these cover what the
// route owns before the service (authentication, ownership, the unavailable answer). Behaviour is in ingest.test.ts.
test("Ingest routes authenticate, check product ownership, and say so when ingest is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ingest-routes-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1", REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"), HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret", HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN: "d", HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: "r",
    HATCH_CREATOR_FACTORY_ROOT: path.join(root, "factory"), DASHSCOPE_API_KEY: "",
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const json = { "content-type": "application/json" };
    const signup = async (email: string) => (await (await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: json, body: JSON.stringify({ email, password: "password-123", display_name: "T" }) })).json() as { token: string }).token;
    const owner = await signup("owner@example.com");
    const stranger = await signup("stranger@example.com");
    const created = await fetch(`${base}/v1/creator/products`, { method: "POST", headers: { ...json, authorization: `Bearer ${owner}` }, body: JSON.stringify({ name: "Agent", promise: "Helps" }) });
    assert.equal(created.status, 201, await created.clone().text());
    const productId = ((await created.json()) as { product: { product_id: string } }).product.product_id;
    const body = JSON.stringify({ items: [{ url: "https://example.com/a" }] });
    const post = (token: string | undefined, id = productId) => fetch(`${base}/v1/creator/products/${id}/ingest`, { method: "POST", headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body });

    assert.equal((await post(undefined)).status, 401);
    assert.equal((await post(stranger)).status, 404, "another account's product is not found");
    assert.equal((await post(owner, "33333333-3333-4333-8333-333333333333")).status, 404);
    const unavailable = await post(owner);
    assert.equal(unavailable.status, 503);
    assert.equal(((await unavailable.json()) as { error: { code: string } }).error.code, "ingest_unavailable");
    assert.equal((await fetch(`${base}/v1/creator/products/${productId}/ingest`, { headers: { authorization: `Bearer ${stranger}` } })).status, 404);
    assert.equal((await fetch(`${base}/v1/creator/products/${productId}/ingest/abc`, { headers: { authorization: `Bearer ${owner}` } })).status, 503);
  } finally {
    await registry.close();
  }
});
