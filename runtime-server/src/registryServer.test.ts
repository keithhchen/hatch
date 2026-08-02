import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { createRegistryServerFromEnvironment } from "./registryServer.js";

function digest(text: string): string { return `sha256:${createHash("sha256").update(text).digest("hex")}`; }

function controlPlaneCorpusBundle(): Uint8Array {
  const system = "Use the creator method.\n";
  const synthetic = "[]\n";
  const asset = (id: string, assetPath: string, text: string) => ({ id, path: assetPath, sha256: digest(text) });
  const manifest = {
    contract_version: "1",
    agent_id: "signal-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: { id: "signal-review", name: "Signal Review" },
    instructions: { system: asset("system", "instructions/system.md", system) },
    skills: [],
    knowledge: { documents: [] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
      { id: "creator.market_data", kind: "http_function", connection_ref: "market-api", operation: "get_snapshot", input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false } },
      { id: "creator.crm_lookup", kind: "mcp_tool", connection_ref: "creator-crm", tool_name: "lookup_customer" }
    ],
    evaluations: {
      synthetic_qa: [asset("synthetic", "evals/synthetic.json", synthetic)],
      held_out: [asset("held-out", "evals/held-out.json", synthetic)]
    }
  };
  return zipSync({
    "agent.json": strToU8(JSON.stringify(manifest)),
    "instructions/system.md": strToU8(system),
    "evals/synthetic.json": strToU8(synthetic),
    "evals/held-out.json": strToU8(synthetic)
  });
}

test("TypeScript Registry exposes auth and Corpus catalog endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-server-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), { status: "ok" });
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com", password: "password-123", role: "user", display_name: "Test User" }) });
    assert.equal(signup.status, 201);
    const auth = await signup.json() as { token: string; account: { role: string } };
    assert.equal(auth.account.role, "user");
    const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.token}` } });
    assert.equal(me.status, 200);
  } finally {
    await registry.close();
  }
});

test("TypeScript Registry Control Plane exposes upsert, bind, and runtime resolve for HTTP and MCP tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-control-plane-server-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN: "test-publish-token",
    HATCH_AUTH_SIGNING_SECRET: "test-secret",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  const tokenHeaders = { authorization: "Bearer test-publish-token", "content-type": "application/json", "x-hatch-creator-id": "maya-chen" };
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;

    const publish = await fetch(`${base}/v1/agent-corpora?creator_id=maya-chen&agent_id=signal-review`, {
      method: "POST",
      headers: tokenHeaders,
      body: new Uint8Array(controlPlaneCorpusBundle())
    });
    assert.equal(publish.status, 201);

    const upsert = await fetch(`${base}/v1/control-plane/connections/market-api`, {
      method: "PUT",
      headers: tokenHeaders,
      body: JSON.stringify({ kind: "http", secret_ref: "env:MARKET_API_KEY", config: { url: "https://api.example.com/v1/snapshot" }, status: "active" })
    });
    assert.equal(upsert.status, 200);
    const connection = await upsert.json() as { id: string; creator_id: string; kind: string; secret_ref: string | null; config: Record<string, unknown> };
    assert.equal(connection.id, "market-api");
    assert.equal(connection.creator_id, "maya-chen");
    assert.equal(connection.kind, "http");

    await fetch(`${base}/v1/control-plane/connections/creator-crm`, {
      method: "PUT",
      headers: tokenHeaders,
      body: JSON.stringify({ kind: "mcp", secret_ref: null, config: { url: "https://mcp.example.com" } })
    });

    const bind = await fetch(`${base}/v1/creators/maya-chen/agents/signal-review/tools/creator.market_data`, {
      method: "PUT",
      headers: tokenHeaders,
      body: JSON.stringify({ connection_id: "market-api" })
    });
    assert.equal(bind.status, 204);
    await fetch(`${base}/v1/creators/maya-chen/agents/signal-review/tools/creator.crm_lookup`, {
      method: "PUT",
      headers: tokenHeaders,
      body: JSON.stringify({ connection_id: "creator-crm" })
    });

    const resolved = await fetch(`${base}/v1/runtime/creators/maya-chen/agents/signal-review/tools/creator.crm_lookup`, { headers: tokenHeaders });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), {
      id: "creator-crm",
      creator_id: "maya-chen",
      kind: "mcp",
      secret_ref: null,
      config: { url: "https://mcp.example.com" },
      status: "active"
    });

    const leak = await fetch(`${base}/v1/control-plane/connections/leaky-api`, {
      method: "PUT",
      headers: tokenHeaders,
      body: JSON.stringify({ kind: "http", secret_ref: null, config: { url: "https://api.example.com", api_key: "should-not-pass" } })
    });
    assert.equal(leak.status, 422);

    const mismatch = await fetch(`${base}/v1/creators/maya-chen/agents/signal-review/tools/creator.market_data`, {
      method: "PUT",
      headers: tokenHeaders,
      body: JSON.stringify({ connection_id: "creator-crm" })
    });
    assert.equal(mismatch.status, 422);

    const missing = await fetch(`${base}/v1/runtime/creators/maya-chen/agents/signal-review/tools/creator.unknown`, { headers: tokenHeaders });
    assert.equal(missing.status, 404);

    const noHeader = await fetch(`${base}/v1/control-plane/connections/market-api`, {
      method: "PUT",
      headers: { authorization: "Bearer test-publish-token", "content-type": "application/json" },
      body: JSON.stringify({ kind: "http", config: { url: "https://api.example.com" } })
    });
    assert.equal(noHeader.status, 400);

    const noToken = await fetch(`${base}/v1/control-plane/connections/market-api`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-hatch-creator-id": "maya-chen" },
      body: JSON.stringify({ kind: "http", config: { url: "https://api.example.com" } })
    });
    assert.equal(noToken.status, 403);
  } finally {
    await registry.close();
  }
});
