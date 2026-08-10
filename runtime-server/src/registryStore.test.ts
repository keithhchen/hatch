import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import test from "node:test";
import { AgentCorpusResolver } from "./agentCorpus.js";
import { RegistryStoreTs } from "./registryStore.js";

function digest(text: string): string { return `sha256:${createHash("sha256").update(text).digest("hex")}`; }

function bundle(agentName = "Signal Review"): Uint8Array {
  const system = "Use the creator method.\n";
  const knowledge = "# Cases\n\nLong reference material.\n";
  const synthetic = "[]\n";
  const asset = (id: string, assetPath: string, text: string) => ({ id, path: assetPath, sha256: digest(text) });
  const manifest = {
    contract_version: "1",
    agent_id: "signal-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: {
      id: "signal-review",
      name: agentName,
      description: "Evidence-first review.",
      promise: "Turn a resume into a signal map.",
      boundaries: ["Does not invent evidence."],
      offer: { model: "per_delivery", amount_minor: 0, currency: "USD", unit: "review" },
      presentation: { accent: "fern" }
    },
    instructions: { system: asset("system", "instructions/system.md", system) },
    skills: [],
    knowledge: { documents: [{ ...asset("cases", "knowledge/cases.md", knowledge), retrieval_only: true, source_summary: "Cases" }] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
    ],
    evaluations: {
      synthetic_qa: [asset("synthetic", "evals/synthetic.json", synthetic)],
      held_out: [asset("held-out", "evals/held-out.json", synthetic)]
    }
  };
  return zipSync({
    "agent.json": strToU8(JSON.stringify(manifest)),
    "instructions/system.md": strToU8(system),
    "knowledge/cases.md": strToU8(knowledge),
    "evals/synthetic.json": strToU8(synthetic),
    "evals/held-out.json": strToU8(synthetic)
  });
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
  const runtimeResolution = await new AgentCorpusResolver(path.join(root, "corpora")).resolve("maya-chen", "signal-review");
  assert.equal(runtimeResolution.digest, published.corpus_digest);
  const restored = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  const restoredCorpus = restored.getAgentCorpus("maya-chen", "signal-review");
  assert.equal(restoredCorpus?.corpus_digest, published.corpus_digest);
  assert.equal(restoredCorpus?.product_promise, "Turn a resume into a signal map.");
  assert.deepEqual(restoredCorpus?.product_boundaries, ["Does not invent evidence."]);
  assert.deepEqual(restoredCorpus?.product_offer, { model: "per_delivery", amount_minor: 0, currency: "USD", unit: "review" });
  assert.deepEqual(restoredCorpus?.presentation, { accent: "fern" });
  const grant = await restored.grantAgentAccess("buyer-one", "maya-chen", "signal-review", "order-one");
  assert.equal(grant.order_id, "order-one");
  const reopened = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  assert.equal(reopened.listAgentAccess("buyer-one")[0]?.order_id, "order-one");
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

test("Registry access projection respects status and joins current presentation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-access-"));
  const statePath = path.join(root, "state.json");
  await writeFile(statePath, JSON.stringify({
    schema_version: 1,
    agent_corpora: [{
      creator_id: "maya",
      agent_id: "signal",
      corpus_digest: "sha256:signal",
      creator_name: "Maya Chen",
      product_id: "signal-product",
      product_name: "Signal Review",
      product_description: "Review work",
      product_boundaries: [],
      presentation: { accent: "orange" },
      knowledge_namespace: "maya:signal",
      status: "published",
      published_at: "2026-08-03T00:00:00.000Z"
    }],
    agent_access: [
      {
        entitlement_id: "ent_active",
        user_id: "jordan",
        creator_id: "maya",
        agent_id: "signal",
        product_id: "signal-product",
        status: "active",
        granted_at: "2026-08-03T00:00:00.000Z"
      },
      {
        entitlement_id: "ent_revoked",
        user_id: "jordan",
        creator_id: "maya",
        agent_id: "other",
        product_id: "other-product",
        status: "revoked",
        granted_at: "2026-08-04T00:00:00.000Z"
      }
    ]
  }), "utf8");

  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath });
  try {
    assert.deepEqual(store.listAgentAccess("jordan").map((grant) => grant.entitlement_id), ["ent_active"]);
    assert.deepEqual(store.listAgentAccessPresentation("jordan")[0], {
      entitlement_id: "ent_active",
      user_id: "jordan",
      creator_id: "maya",
      agent_id: "signal",
      product_id: "signal-product",
      status: "active",
      granted_at: "2026-08-03T00:00:00.000Z",
      creator: { id: "maya", name: "Maya Chen" },
      product: { id: "signal-product", name: "Signal Review", description: "Review work" },
      presentation: { accent: "orange" }
    });
  } finally {
    await store.close();
  }
});
