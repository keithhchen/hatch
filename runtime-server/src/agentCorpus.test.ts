import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import { AgentCorpusResolver, AgentCorpusSchema, CorpusKnowledgeProvider, HttpKnowledgeProvider, loadAgentCorpus, QdrantKnowledgeProvider } from "./agentCorpus.js";
import { DeterministicAgentRuntime } from "./agentRuntime.js";
import { createRuntimeServer } from "./index.js";

const tempRoots: string[] = [];
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CREATOR_ID = "33333333-3333-4333-8333-333333333333";
const ENTITLEMENT_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "66666666-6666-4666-8666-666666666666";
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("Agent Corpus bounds catalog metadata, arrays, and embedded JSON", () => {
  const asset = { id: "asset", path: "evals/asset.json", sha256: `sha256:${"a".repeat(64)}` };
  const base = {
    contract_version: "1",
    creator: { id: CREATOR_ID, name: "Bounded Creator" },
    product: { id: PRODUCT_ID, name: "Bounded Product", presentation: {} },
    instructions: { system: { ...asset, id: "system", path: "instructions/system.md" } },
    skills: [],
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: { synthetic_qa: [{ ...asset, id: "synthetic" }], held_out: [{ ...asset, id: "held-out" }] },
  };
  assert.equal(AgentCorpusSchema.safeParse(base).success, true);
  assert.equal(AgentCorpusSchema.safeParse({
    ...base,
    product: { ...base.product, description: "x".repeat(8_193) },
  }).success, false);
  assert.equal(AgentCorpusSchema.safeParse({
    ...base,
    tools: Array.from({ length: 129 }, (_, index) => ({
      id: `creator.bound.tool-${index}`,
      kind: "http_function",
      connection_ref: "bounded-connection",
      operation: "run",
    })),
  }).success, false);
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 10; index += 1) nested = { child: nested };
  assert.equal(AgentCorpusSchema.safeParse({
    ...base,
    product: { ...base.product, presentation: nested },
  }).success, false);
});

test("Agent Corpus requires the canonical Knowledge title field", () => {
  const asset = { id: "knowledge-1", path: "knowledge/one.md", sha256: `sha256:${"a".repeat(64)}`, retrieval_only: true };
  const base = {
    contract_version: "1",
    creator: { id: CREATOR_ID, name: "Creator" },
    product: { id: PRODUCT_ID, name: "Product", presentation: {} },
    instructions: { system: { id: "system", path: "instructions/system.md", sha256: `sha256:${"b".repeat(64)}` } },
    skills: [],
    knowledge: { documents: [{ ...asset, title: "Canonical title" }] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin" }],
    evaluations: { synthetic_qa: [], held_out: [] },
  };
  assert.equal(AgentCorpusSchema.safeParse(base).success, true);
  assert.equal(AgentCorpusSchema.safeParse({
    ...base,
    knowledge: { documents: [{ ...asset, source_summary: "Legacy summary" }] },
  }).success, false);
});

test("Agent Corpus loads clean assets and scopes knowledge by creator and agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-agent-corpus-"));
  tempRoots.push(root);
  await mkdir(path.join(root, "instructions"), { recursive: true });
  await mkdir(path.join(root, "knowledge"), { recursive: true });
  await mkdir(path.join(root, "evals"), { recursive: true });
  const system = "Follow the creator's global method.\n";
  const knowledge = "A resume should lead with the strongest evidence.\n\nUse concise bullets.\n";
  await writeFile(path.join(root, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(root, "knowledge/method.md"), knowledge, "utf8");
  const asset = (assetPath: string, content: string, id: string) => ({ id, path: assetPath, sha256: digest(content) });
  const evals = "[]";
  await writeFile(path.join(root, "evals/evals.json"), evals, "utf8");
  const corpus = {
    contract_version: "1",
    creator: { id: CREATOR_ID, name: "Maya Chen" },
    product: {
      id: PRODUCT_ID,
      name: "Signal Resume Review",
      // Pre-cutover immutable Corpus bytes may still contain this removed
      // metadata. The loader must ignore it without changing the release.
      offer: { model: "per_delivery", amount_minor: 0, currency: "USD" }
    },
    instructions: { system: asset("instructions/system.md", system, "instructions-system") },
    skills: [],
    knowledge: { documents: [{ ...asset("knowledge/method.md", knowledge, "knowledge-001"), retrieval_only: true, title: "Resume method" }] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
    ],
    evaluations: {
      synthetic_qa: [asset("evals/evals.json", evals, "evals-synthetic")],
      held_out: [asset("evals/evals.json", evals, "evals-held-out")]
    }
  } as const;
  await writeFile(path.join(root, "agent.json"), JSON.stringify(corpus), "utf8");

  const loaded = await loadAgentCorpus(root);
  assert.equal("offer" in loaded.product, false);
  const provider = new CorpusKnowledgeProvider(root, loaded);
  const hits = await provider.search({ creatorId: CREATOR_ID, agentId: PRODUCT_ID, corpusDigest: `sha256:${"1".repeat(64)}`, query: "strongest evidence", limit: 4 });
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.text, /strongest evidence/);
  await assert.rejects(
    provider.search({ creatorId: OTHER_CREATOR_ID, agentId: PRODUCT_ID, corpusDigest: `sha256:${"1".repeat(64)}`, query: "evidence", limit: 4 }),
    /creator scope/
  );
});

test("remote KnowledgeProvider always sends the current creator and agent scope", async () => {
  let received: Record<string, unknown> | undefined;
  const gateway = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hits: [{ id: "kb-1", text: "scoped method", score: 1 }] }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  try {
    const hits = await new HttpKnowledgeProvider(`http://127.0.0.1:${address.port}/search`).search({
      creatorId: CREATOR_ID,
      agentId: PRODUCT_ID,
      corpusDigest: `sha256:${"1".repeat(64)}`,
      query: "evidence",
      limit: 4
    });
    assert.deepEqual(received, {
      creator_id: CREATOR_ID,
      agent_id: PRODUCT_ID,
      corpus_digest: `sha256:${"1".repeat(64)}`,
      query: "evidence",
      top_k: 4
    });
    assert.equal(hits[0]?.id, "kb-1");
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
  }
});

test("Qdrant KnowledgeProvider embeds, scopes, reranks, and returns source metadata", async () => {
  let qdrantQuery: Record<string, unknown> | undefined;
  const gateway = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
    response.setHeader("content-type", "application/json");
    if (request.url?.includes("/points/query")) {
      qdrantQuery = body;
      response.end(JSON.stringify({ result: { points: [
        { id: "p1", score: 0.9, payload: { text: "first candidate", document_id: "doc-1", source_path: "knowledge/first.md", heading: "First" } },
        { id: "p2", score: 0.8, payload: { text: "second candidate", document_id: "doc-2", source_path: "knowledge/second.md", heading: "Second" } }
      ] } }));
      return;
    }
    if (request.url?.endsWith("/embeddings")) {
      response.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, index) => index === 0 ? 0.1 : 0) }] }));
      return;
    }
    if (request.url?.endsWith("/reranks")) {
      response.end(JSON.stringify({ results: [
        { index: 1, relevance_score: 0.97 },
        { index: 0, relevance_score: 0.44 }
      ] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const provider = new QdrantKnowledgeProvider(base, "qdrant-test", "dashscope-test", {
      collection: "hatch_knowledge_text_v4_1024",
      embeddingBaseUrl: base,
      rerankBaseUrl: base
    });
    const hits = await provider.search({ creatorId: "maya-chen", agentId: "signal-resume-review", corpusDigest: `sha256:${"1".repeat(64)}`, query: "evidence", limit: 1 });
    assert.deepEqual((qdrantQuery?.filter as Record<string, unknown>)?.must, [
      { key: "creator_id", match: { value: "maya-chen" } },
      { key: "agent_id", match: { value: "signal-resume-review" } },
      { key: "corpus_digest", match: { value: `sha256:${"1".repeat(64)}` } }
    ]);
    assert.equal(qdrantQuery?.limit, 30);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "p2");
    assert.equal(hits[0]?.document_id, "doc-2");
    assert.equal(hits[0]?.source_path, "knowledge/second.md");
    assert.equal(hits[0]?.heading, "Second");
    assert.equal(hits[0]?.source, "knowledge/second.md · Second");
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
  }
});

test("Agent Corpus resolver loads the Registry current creator/agent path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-agent-corpus-root-"));
  tempRoots.push(root);
  const creatorRoot = path.join(root, CREATOR_ID, PRODUCT_ID);
  await mkdir(path.join(creatorRoot, "instructions"), { recursive: true });
  await mkdir(path.join(creatorRoot, "evals"), { recursive: true });
  const system = "Global method.";
  const evals = "[]";
  await writeFile(path.join(creatorRoot, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(creatorRoot, "evals/evals.json"), evals, "utf8");
  const asset = (assetPath: string, content: string, id: string) => ({ id, path: assetPath, sha256: digest(content) });
  await writeFile(path.join(creatorRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    creator: { id: CREATOR_ID, name: "Maya Chen" },
    product: {
      id: PRODUCT_ID,
      name: "Signal Resume Review",
    },
    instructions: { system: asset("instructions/system.md", system, "instructions-system") },
    skills: [],
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: { synthetic_qa: [asset("evals/evals.json", evals, "synthetic")], held_out: [asset("evals/evals.json", evals, "held-out")] }
  }), "utf8");
  const resolved = await new AgentCorpusResolver(root).resolve(CREATOR_ID, PRODUCT_ID);
  assert.equal(resolved.corpus.product.id, PRODUCT_ID);
  await assert.rejects(new AgentCorpusResolver(root).resolve(OTHER_CREATOR_ID, PRODUCT_ID), /missing|ENOENT|Agent Corpus/);
});



test("current Agent Corpus entitlements are discoverable and bind the Desktop session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-agent-corpus-entitlement-"));
  tempRoots.push(root);
  const creatorRoot = path.join(root, CREATOR_ID, PRODUCT_ID);
  await mkdir(path.join(creatorRoot, "instructions"), { recursive: true });
  await mkdir(path.join(creatorRoot, "evals"), { recursive: true });
  const system = "Review the supplied file using Maya's method.";
  const evals = "[]";
  await writeFile(path.join(creatorRoot, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(creatorRoot, "evals/evals.json"), evals, "utf8");
  const asset = (assetPath: string, content: string, id: string) => ({ id, path: assetPath, sha256: digest(content) });
  await writeFile(path.join(creatorRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    creator: { id: CREATOR_ID, name: "Maya Chen" },
    product: {
      id: PRODUCT_ID,
      name: "Signal Resume Review",
      description: "Review a resume.",
    },
    instructions: { system: asset("instructions/system.md", system, "instructions-system") },
    skills: [],
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: { synthetic_qa: [asset("evals/evals.json", evals, "synthetic")], held_out: [asset("evals/evals.json", evals, "held-out")] }
  }), "utf8");
  const entitlement = {
    entitlement_id: ENTITLEMENT_ID,
    order_id: ORDER_ID,
    user_id: USER_ID,
    creator_id: CREATOR_ID,
    product_id: PRODUCT_ID,
    agent_id: PRODUCT_ID,
    status: "active" as const
  };
  const entitlementResolver = {
    list: async ({ licenseToken }: { licenseToken: string }) => licenseToken === "license-jordan" ? [entitlement] : [],
    resolve: async ({ licenseToken, entitlementId }: { licenseToken: string; entitlementId: string }) => {
      if (licenseToken !== "license-jordan" || entitlementId !== entitlement.entitlement_id) throw new Error("not entitled");
      return entitlement;
    }
  };
  const runtime = createRuntimeServer({
    createRuntime: () => new DeterministicAgentRuntime(),
    agentCorpusResolver: new AgentCorpusResolver(root),
    entitlementResolver
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address === "object");
  try {
    const library = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer license-jordan" }
    });
    assert.equal(library.status, 200);
    const payload = await library.json() as { creator_agents: Array<{ product_id: string }> };
    assert.equal(payload.creator_agents[0]?.product_id, PRODUCT_ID);

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      socket.once("open", () => socket.send(JSON.stringify({
        type: "client.hello",
        protocol_version: "0.7",
        license_token: "license-jordan",
        entitlement_id: entitlement.entitlement_id,
        local_tools: []
      })));
    });
    assert.equal(ready.type, "session.ready");
    assert.equal(ready.product_id, PRODUCT_ID);
    assert.match(String(ready.corpus_digest), /^sha256:[a-f0-9]{64}$/);
    socket.close();
  } finally {
    await runtime.close();
  }
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
