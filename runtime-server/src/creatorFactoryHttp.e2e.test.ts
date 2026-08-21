import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRegistryServerFromEnvironment } from "./registryServer.js";

test("Product Creator API owns Files and routes Node workflow through the new boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-product-http-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "registry.json"),
    HATCH_CREATOR_FACTORY_ROOT: path.join(root, "factory-runs"),
    HATCH_AUTH_SIGNING_SECRET: "product-http-secret",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  t.after(async () => {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  });
  const address = registry.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const creatorA = await signup(base, "product-a@example.com", "Creator A");
  const creatorB = await signup(base, "product-b@example.com", "Creator B");
  const creatorAAccount = await authMe(base, creatorA);
  const unauthenticated = await fetch(`${base}/v1/creator/products`);
  assert.equal(unauthenticated.status, 401);

  // Product-only cutover: the old global Source Library and Factory run entry
  // points are no longer user concepts. Files and Versions must be addressed
  // below one authenticated Product.
  const legacySources = await fetch(`${base}/v1/creator/source-documents?product_id=ignored`, {
    headers: { authorization: `Bearer ${creatorA}` }
  });
  assert.equal(legacySources.status, 404);
  const legacySnapshots = await fetch(`${base}/v1/creator/source-snapshots`, {
    headers: { authorization: `Bearer ${creatorA}` }
  });
  assert.equal(legacySnapshots.status, 404);
  const globalRuns = await fetch(`${base}/v1/creator/factory-runs`, {
    headers: { authorization: `Bearer ${creatorA}` }
  });
  assert.equal(globalRuns.status, 404);

  const createdResponse = await fetch(`${base}/v1/creator/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "product-create-1" },
    body: JSON.stringify({ name: "Publishable Reply", promise: "A decisive reply grounded in Creator evidence." })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { product: { product_id: string } };
  const productId = created.product.product_id;
  assert.match(productId, /^[0-9a-f-]{36}$/);

  const productReplay = await fetch(`${base}/v1/creator/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "product-create-1" },
    body: JSON.stringify({ name: "Publishable Reply", promise: "A decisive reply grounded in Creator evidence." })
  });
  assert.equal(productReplay.status, 201);
  assert.equal((await productReplay.json() as { product: { product_id: string } }).product.product_id, productId);

  const productConflict = await fetch(`${base}/v1/creator/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "product-create-1" },
    body: JSON.stringify({ name: "Changed product", promise: "A different payload must not create another Product." })
  });
  assert.equal(productConflict.status, 409);
  assert.equal((await productConflict.json() as { error: { code: string } }).error.code, "idempotency_conflict");

  const content = Buffer.from("Choose one recommendation and return final copy.");
  const upload = await fetch(`${base}/v1/creator/products/${productId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "file-1" },
    body: JSON.stringify({ display_name: "method.txt", media_type: "text/plain", content_base64: content.toString("base64") })
  });
  assert.equal(upload.status, 201);
  const file = await upload.json() as { id: string; path: string; projection: { kind: string } };
  assert.equal(file.projection.kind, "markdown");
  assert.equal(file.path, `creator-products/${creatorAAccount.id}/${productId}/files/${file.id}/projection.md`);

  for (const legacyPath of [
    `/v1/creator/products/${productId}/snapshots`,
    `/v1/creator/products/${productId}/runs`,
    `/v1/creator/products/${productId}/versions`
  ]) {
    const legacy = await fetch(`${base}${legacyPath}`, {
      headers: { authorization: `Bearer ${creatorA}` }
    });
    assert.equal(legacy.status, 404);
  }

  const nodeStatus = await fetch(`${base}/v1/creator/products/${productId}/nodes/about-you/executions`, {
    headers: { authorization: `Bearer ${creatorA}` }
  });
  // This fixture intentionally has no Postgres Node store. Production enables
  // it through HATCH_DATABASE_URL; the route must fail honestly rather than
  // silently falling back to the removed Factory run API.
  assert.equal(nodeStatus.status, 503);

  const crossCreator = await fetch(`${base}/v1/creator/products/${productId}/files`, { headers: { authorization: `Bearer ${creatorB}` } });
  assert.equal(crossCreator.status, 404);
});

async function signup(base: string, email: string, displayName: string): Promise<string> {
  const response = await fetch(`${base}/v1/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", role: "creator", display_name: displayName })
  });
  assert.equal(response.status, 201);
  return (await response.json() as { token: string }).token;
}

async function authMe(base: string, token: string): Promise<{ id: string }> {
  const response = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return await response.json() as { id: string };
}
