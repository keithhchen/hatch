import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CREATOR_FACTORY_JSON_BODY_MAX_BYTES,
  createRegistryServerFromEnvironment
} from "./registryServer.js";

test("Registry Creator Factory API authenticates ownership and creates idempotently", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-http-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "registry.json"),
    HATCH_CREATOR_FACTORY_ROOT: path.join(root, "factory-runs"),
    HATCH_AUTH_SIGNING_SECRET: "factory-http-secret",
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
  const creatorA = await signup(base, "factory-a@example.com", "Creator A");
  const creatorB = await signup(base, "factory-b@example.com", "Creator B");
  const body = {
    product_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    product: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Publishable Reply",
      description: "One finished customer response.",
      promise: "A decisive reply grounded in Creator evidence.",
      boundaries: ["No unsupported claims."],
      offer: { model: "per_delivery", amount_minor: 2500, currency: "USD", unit: "reply" },
      presentation: { accent: "cobalt", card: { density: "compact" } }
    },
    tools: [
      { id: "hatch.local.workspace", kind: "local_harness", capability: "filesystem" },
      {
        id: "creator.account-lookup",
        kind: "http_function",
        connection_ref: "account-api",
        operation: "lookup_account",
        input_schema: { type: "object", properties: { account_id: { type: "string" } }, required: ["account_id"] }
      },
      {
        id: "creator.crm-record",
        kind: "mcp_tool",
        connection_ref: "creator-crm",
        tool_name: "find_record",
        input_schema: { type: "object", properties: { id: { type: "string" } } }
      }
    ],
    task_name: "Publishable reply",
    task_brief: "Choose one recommendation and return final copy.",
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Current correction",
      content: "Do not give options. Make the choice."
    }],
    config: { development_questions: 2, heldout_questions: 1, max_corpus_revisions: 2 }
  };

  const unauthenticated = await fetch(`${base}/v1/creator/factory-runs`);
  assert.equal(unauthenticated.status, 401);
  const missingKey = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${creatorA}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(missingKey.status, 422);

  const first = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creatorA}`,
      "content-type": "application/json",
      "idempotency-key": "create-factory-1"
    },
    body: JSON.stringify(body)
  });
  assert.equal(first.status, 202);
  const created = await first.json() as {
    id: string;
    status: string;
    pending_questions: unknown[];
    product: typeof body.product;
    declared_tool_ids: string[];
  };
  assert.equal(created.status, "queued");
  assert.deepEqual(created.pending_questions, []);
  assert.deepEqual(created.product, body.product);
  assert.deepEqual(created.declared_tool_ids, [
    "hatch.web_search",
    "hatch.file_search",
    ...body.tools.map((tool) => tool.id)
  ]);

  const replay = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creatorA}`,
      "content-type": "application/json",
      "idempotency-key": "create-factory-1"
    },
    body: JSON.stringify(body)
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, created.id);
  const conflictingReplay = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creatorA}`,
      "content-type": "application/json",
      "idempotency-key": "create-factory-1"
    },
    body: JSON.stringify({ ...body, task_name: "A different task" })
  });
  assert.equal(conflictingReplay.status, 409);

  const secretBearingTool = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creatorA}`,
      "content-type": "application/json",
      "idempotency-key": "create-factory-secret-tool"
    },
    body: JSON.stringify({
      ...body,
      tools: [{
        id: "creator.unsafe",
        kind: "http_function",
        connection_ref: "unsafe-api",
        operation: "lookup",
        endpoint_url: "https://example.com",
        credential: "must-not-enter-corpus"
      }]
    })
  });
  assert.equal(secretBearingTool.status, 422);
  assert.match((await secretBearingTool.json() as { detail: string }).detail, /forbidden/i);

  const invalidProduct = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creatorA}`,
      "content-type": "application/json",
      "idempotency-key": "create-factory-invalid-product"
    },
    body: JSON.stringify({
      ...body,
      product: { ...body.product, offer: { amount_minor: 2500, currency: "usd" } }
    })
  });
  assert.equal(invalidProduct.status, 422);
  assert.match((await invalidProduct.json() as { detail: string }).detail, /uppercase currency/);

  const list = await fetch(`${base}/v1/creator/factory-runs`, {
    headers: { authorization: `Bearer ${creatorA}` }
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json() as { runs: unknown[] }).runs.length, 1);
  const crossCreator = await fetch(`${base}/v1/creator/factory-runs/${encodeURIComponent(created.id)}`, {
    headers: { authorization: `Bearer ${creatorB}` }
  });
  assert.equal(crossCreator.status, 404);

  const largeButSupported = await fetch(`${base}/v1/creator/factory-runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creatorA}`,
      "content-type": "application/json",
      "idempotency-key": "create-factory-large"
    },
    body: JSON.stringify({
      ...body,
      sources: [{ ...body.sources[0], content: "x".repeat(1024 * 1024 + 128) }]
    })
  });
  assert.equal(largeButSupported.status, 202);

  assert.equal(
    await oversizedFactoryRequest(base, creatorA),
    413
  );
});

function oversizedFactoryRequest(base: string, token: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/v1/creator/factory-runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "create-factory-oversized",
        "content-length": String(CREATOR_FACTORY_JSON_BODY_MAX_BYTES + 1)
      }
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

async function signup(base: string, email: string, displayName: string): Promise<string> {
  const response = await fetch(`${base}/v1/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", role: "creator", display_name: displayName })
  });
  assert.equal(response.status, 201);
  return (await response.json() as { token: string }).token;
}
