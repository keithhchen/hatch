import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRegistryServerFromEnvironment } from "./registryServer.js";

test("Product Creator API owns files, snapshots, and idempotent runs", async (t) => {
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
  const unauthenticated = await fetch(`${base}/v1/creator/products`);
  assert.equal(unauthenticated.status, 401);

  const createdResponse = await fetch(`${base}/v1/creator/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "product-create-1" },
    body: JSON.stringify({ name: "Publishable Reply", promise: "A decisive reply grounded in Creator evidence." })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { product: { product_id: string } };
  const productId = created.product.product_id;
  assert.match(productId, /^[0-9a-f-]{36}$/);

  const content = Buffer.from("Choose one recommendation and return final copy.");
  const upload = await fetch(`${base}/v1/creator/products/${productId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "file-1" },
    body: JSON.stringify({ display_name: "method.txt", media_type: "text/plain", content_base64: content.toString("base64") })
  });
  assert.equal(upload.status, 201);
  const file = await upload.json() as { id: string; projection: { kind: string } };
  assert.equal(file.projection.kind, "markdown");

  const snapshot = await fetch(`${base}/v1/creator/products/${productId}/snapshots`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "snapshot-1" },
    body: JSON.stringify({ file_ids: [file.id] })
  });
  assert.equal(snapshot.status, 201);
  const snapshotBody = await snapshot.json() as { id: string; product_id: string };
  assert.equal(snapshotBody.product_id, productId);

  const run = await fetch(`${base}/v1/creator/products/${productId}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "run-1" },
    body: JSON.stringify({ source_snapshot_id: snapshotBody.id, config: { development_questions: 2, heldout_questions: 1 } })
  });
  assert.equal(run.status, 202);
  const runBody = await run.json() as { id: string; product_id: string; source_snapshot_id: string };
  assert.equal(runBody.product_id, productId);
  assert.equal(runBody.source_snapshot_id, snapshotBody.id);

  const replay = await fetch(`${base}/v1/creator/products/${productId}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "run-1" },
    body: JSON.stringify({ source_snapshot_id: snapshotBody.id, config: { development_questions: 2, heldout_questions: 1 } })
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, runBody.id);

  const conflictingReplay = await fetch(`${base}/v1/creator/products/${productId}/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json", "idempotency-key": "run-1" },
    body: JSON.stringify({ source_snapshot_id: snapshotBody.id, config: { development_questions: 3, heldout_questions: 1 } })
  });
  assert.equal(conflictingReplay.status, 409);
  assert.equal((await conflictingReplay.json() as { error: { code: string } }).error.code, "idempotency_conflict");

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
