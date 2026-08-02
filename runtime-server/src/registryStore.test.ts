import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { test } from "node:test";
import { RegistryStoreTs } from "./registryStore.js";

function digest(text: string): string { return `sha256:${createHash("sha256").update(text).digest("hex")}`; }

function bundle(agentName = "Signal Review", options: { creatorTools?: boolean; knowledge?: boolean } = {}): Uint8Array {
  const system = "Use the creator method.\n";
  const knowledge = "# Cases\n\nLong reference material.\n";
  const synthetic = "[]\n";
  const asset = (id: string, assetPath: string, text: string) => ({ id, path: assetPath, sha256: digest(text) });
  const manifest: Record<string, unknown> = {
    contract_version: "1",
    agent_id: "signal-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: { id: "signal-review", name: agentName },
    instructions: { system: asset("system", "instructions/system.md", system) },
    skills: [],
    knowledge: { documents: [] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
      ...(options.creatorTools ? [
        { id: "creator.market_data", kind: "http_function", connection_ref: "market-api", operation: "get_snapshot", description: "Get a snapshot.", input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false } },
        { id: "creator.crm_lookup", kind: "mcp_tool", connection_ref: "creator-crm", tool_name: "lookup_customer", description: "Look up a customer." }
      ] : [])
    ],
    evaluations: {
      synthetic_qa: [asset("synthetic", "evals/synthetic.json", synthetic)],
      held_out: [asset("held-out", "evals/held-out.json", synthetic)]
    }
  };
  if (options.knowledge !== false) {
    (manifest.knowledge as { documents: unknown[] }).documents = [{ ...asset("cases", "knowledge/cases.md", knowledge), retrieval_only: true, source_summary: "Cases" }];
  }
  const files: Record<string, Uint8Array> = {
    "agent.json": strToU8(JSON.stringify(manifest)),
    "instructions/system.md": strToU8(system),
    "evals/synthetic.json": strToU8(synthetic),
    "evals/held-out.json": strToU8(synthetic)
  };
  if (options.knowledge !== false) files["knowledge/cases.md"] = strToU8(knowledge);
  return zipSync(files);
}

test("TypeScript Registry publishes a clean Corpus and indexes knowledge only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-"));
  const statePath = path.join(root, "registry.json");
  const calls: unknown[] = [];
  const indexer = {
    replaceAgentDocuments: async (...args: unknown[]) => { calls.push(args); }
  };
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  const published = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle());
  assert.equal(published.creator_id, "maya-chen");
  assert.equal(published.agent_id, "signal-review");
  assert.equal(calls.length, 1);
  const restored = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  assert.equal(restored.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, published.corpus_digest);
  const installed = await readFile(path.join(root, "corpora/maya-chen/signal-review/knowledge/cases.md"), "utf8");
  assert.match(installed, /Long reference material/);
});

test("TypeScript Registry requires Qdrant when a Corpus contains knowledge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-no-index-"));
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), environment: {} });
  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle()),
    /Qdrant knowledge index is not configured/
  );
});

test("TypeScript Registry Control Plane binds declared creator tools and resolves them without credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-control-plane-"));
  const statePath = path.join(root, "registry.json");
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, environment: {} });
  await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review", { creatorTools: true, knowledge: false }));

  await store.upsertConnection({
    creatorId: "maya-chen",
    connectionId: "market-api",
    kind: "http",
    secretRef: "env:MARKET_API_KEY",
    config: { url: "https://api.example.com/v1/snapshot" },
    status: "active"
  });
  await store.upsertConnection({
    creatorId: "maya-chen",
    connectionId: "creator-crm",
    kind: "mcp",
    secretRef: null,
    config: { url: "https://mcp.example.com" },
    status: "active"
  });

  await store.upsertConnection({
    creatorId: "maya-chen",
    connectionId: "other-api",
    kind: "http",
    secretRef: null,
    config: { url: "https://api.example.com/v2" },
    status: "active"
  });

  await store.bindAgentTool({ creatorId: "maya-chen", agentId: "signal-review", toolId: "creator.market_data", connectionId: "market-api" });
  await store.bindAgentTool({ creatorId: "maya-chen", agentId: "signal-review", toolId: "creator.crm_lookup", connectionId: "creator-crm" });

  const http = await store.resolveAgentToolConnection("maya-chen", "signal-review", "creator.market_data");
  assert.equal(http.kind, "http");
  assert.equal(http.secret_ref, "env:MARKET_API_KEY");
  assert.deepEqual(http.config, { url: "https://api.example.com/v1/snapshot" });
  const mcp = await store.resolveAgentToolConnection("maya-chen", "signal-review", "creator.crm_lookup");
  assert.equal(mcp.kind, "mcp");

  const restored = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, environment: {} });
  assert.deepEqual(await restored.resolveAgentToolConnection("maya-chen", "signal-review", "creator.market_data"), http);

  await assert.rejects(
    store.upsertConnection({
      creatorId: "maya-chen",
      connectionId: "bad-api",
      kind: "http",
      secretRef: null,
      config: { url: "https://api.example.com", api_key: "leaked" },
      status: "active"
    }),
    /must not contain credentials/
  );
  await assert.rejects(
    store.bindAgentTool({ creatorId: "maya-chen", agentId: "signal-review", toolId: "creator.market_data", connectionId: "creator-crm" }),
    /does not match Control Plane kind/
  );
  await assert.rejects(
    store.bindAgentTool({ creatorId: "maya-chen", agentId: "signal-review", toolId: "creator.crm_lookup", connectionId: "market-api" }),
    /does not match Control Plane kind/
  );
  await assert.rejects(
    store.bindAgentTool({ creatorId: "maya-chen", agentId: "signal-review", toolId: "creator.market_data", connectionId: "other-api" }),
    /does not match connection_ref/
  );
  await assert.rejects(
    store.bindAgentTool({ creatorId: "maya-chen", agentId: "signal-review", toolId: "creator.unknown", connectionId: "market-api" }),
    /does not declare tool_id/
  );
  await assert.rejects(
    store.resolveAgentToolConnection("maya-chen", "signal-review", "creator.unknown"),
    /no Control Plane binding/
  );
});
