import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import { AgentCorpusResolver, CorpusKnowledgeProvider, HttpKnowledgeProvider, loadAgentCorpus, QdrantKnowledgeProvider } from "./agentCorpus.js";
import { DeterministicAgentRuntime } from "./agentRuntime.js";
import { createRuntimeServer } from "./index.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
    agent_id: "signal-resume-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: {
      id: "signal-resume-review",
      name: "Signal Resume Review",
    },
    instructions: { system: asset("instructions/system.md", system, "instructions-system") },
    skills: [],
    knowledge: { documents: [{ ...asset("knowledge/method.md", knowledge, "knowledge-001"), retrieval_only: true, source_summary: "Resume method" }] },
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
  const provider = new CorpusKnowledgeProvider(root, loaded);
  const hits = await provider.search({ creatorId: "maya-chen", agentId: "signal-resume-review", query: "strongest evidence", limit: 4 });
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.text, /strongest evidence/);
  await assert.rejects(
    provider.search({ creatorId: "other-creator", agentId: "signal-resume-review", query: "evidence", limit: 4 }),
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
      creatorId: "maya-chen",
      agentId: "signal-resume-review",
      query: "evidence",
      limit: 4
    });
    assert.deepEqual(received, {
      creator_id: "maya-chen",
      agent_id: "signal-resume-review",
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
    const hits = await provider.search({ creatorId: "maya-chen", agentId: "signal-resume-review", query: "evidence", limit: 1 });
    assert.deepEqual((qdrantQuery?.filter as Record<string, unknown>)?.must, [
      { key: "creator_id", match: { value: "maya-chen" } },
      { key: "agent_id", match: { value: "signal-resume-review" } }
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
  const creatorRoot = path.join(root, "maya-chen", "signal-resume-review");
  await mkdir(path.join(creatorRoot, "instructions"), { recursive: true });
  await mkdir(path.join(creatorRoot, "evals"), { recursive: true });
  const system = "Global method.";
  const evals = "[]";
  await writeFile(path.join(creatorRoot, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(creatorRoot, "evals/evals.json"), evals, "utf8");
  const asset = (assetPath: string, content: string, id: string) => ({ id, path: assetPath, sha256: digest(content) });
  await writeFile(path.join(creatorRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    agent_id: "signal-resume-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: {
      id: "signal-resume-review",
      name: "Signal Resume Review",
    },
    instructions: { system: asset("instructions/system.md", system, "instructions-system") },
    skills: [],
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: { synthetic_qa: [asset("evals/evals.json", evals, "synthetic")], held_out: [asset("evals/evals.json", evals, "held-out")] }
  }), "utf8");
  const resolved = await new AgentCorpusResolver(root).resolve("maya-chen", "signal-resume-review");
  assert.equal(resolved.corpus.product.id, "signal-resume-review");
  await assert.rejects(new AgentCorpusResolver(root).resolve("other-creator", "signal-resume-review"), /missing|ENOENT|Agent Corpus/);
});



test("current Agent Corpus entitlements are discoverable and bind the Desktop session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-agent-corpus-entitlement-"));
  tempRoots.push(root);
  const creatorRoot = path.join(root, "maya-chen", "signal-resume-review");
  await mkdir(path.join(creatorRoot, "instructions"), { recursive: true });
  await mkdir(path.join(creatorRoot, "evals"), { recursive: true });
  const system = "Review the supplied file using Maya's method.";
  const evals = "[]";
  await writeFile(path.join(creatorRoot, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(creatorRoot, "evals/evals.json"), evals, "utf8");
  const asset = (assetPath: string, content: string, id: string) => ({ id, path: assetPath, sha256: digest(content) });
  await writeFile(path.join(creatorRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    agent_id: "signal-resume-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    product: {
      id: "signal-resume-review",
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
    entitlement_id: "ent_maya_resume",
    order_id: "order_maya_resume",
    user_id: "buyer-jordan",
    creator_id: "maya-chen",
    product_id: "signal-resume-review",
    agent_id: "signal-resume-review",
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
    const payload = await library.json() as { creator_agents: Array<{ agent_id: string }> };
    assert.equal(payload.creator_agents[0]?.agent_id, "signal-resume-review");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      socket.once("open", () => socket.send(JSON.stringify({
        type: "client.hello",
        protocol_version: "0.3",
        installation_id: "desktop-jordan",
        license_token: "license-jordan",
        entitlement_id: entitlement.entitlement_id,
        creator_id: entitlement.creator_id,
        agent_id: entitlement.agent_id,
        local_tools: []
      })));
    });
    assert.equal(ready.type, "session.ready");
    assert.equal(ready.agent_id, "signal-resume-review");
    assert.match(String(ready.corpus_digest), /^sha256:[a-f0-9]{64}$/);
    socket.close();
  } finally {
    await runtime.close();
  }
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
