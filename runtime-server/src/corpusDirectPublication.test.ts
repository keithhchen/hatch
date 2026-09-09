import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createRegistryServerFromEnvironment } from "./registryServer.js";
import { RuntimeReleaseAgentCorpusResolver } from "./runtimeCorpusResolver.js";
import { materializeAgentCorpus } from "./agentCorpusMaterialization.js";

// Local integration of actual Registry publication and Runtime loading; no production/model UAT.
test("Generation publishes a direct definition without a Corpus Node and Runtime loads it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-corpus-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const server = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1", REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"), HATCH_RUNTIME_CORPUS_ROOT: runtimeRoot,
    HATCH_REGISTRY_STATE_PATH: path.join(root, "registry.json"),
    HATCH_CREATOR_FACTORY_ROOT: path.join(root, "factory"),
    HATCH_AUTH_SIGNING_SECRET: "unit-test-secret", HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: "unit-test-runtime",
    HATCH_QDRANT_URL: "", DASHSCOPE_API_KEY: "",
  });
  try {
    const address = server.server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "factory-test@example.test", password: "password-123", role: "creator", display_name: "Factory Test" }) });
    assert.equal(signup.status, 201);
    const auth = await signup.json() as { token: string; account: { id: string } };
    const request = async (route: string, body?: unknown): Promise<any> => {
      const r = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await r.json();
      if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(payload)}`);
      return payload;
    };
    const product = await request("/v1/creator/products", { name: "Canonical definition test", promise: "Review an argument using its evidence." }) as { product: { product_id: string } };
    let productId = product.product.product_id;
    await assert.rejects(request(`/v1/creator/products/${productId}/registry`, {}), /422.*corpus_required/);
    const system = "Review the customer's evidence. Ask for missing facts. Never invent citations.\n";
    const corpus = { system_instructions: system, skills: [{ id: "review", title: "Evidence review", when_to_use: "Review an argument", instruction: "Read references/evidence.md and explain which claims the evidence supports.", references: [{ id: "evidence", kind: "method", content: "Check whether evidence supports the exact claim." }] }], knowledge: [], tools: [] };
    const receipt = await request(`/v1/creator/products/${productId}/registry`, { corpus });
    assert.equal(receipt.status, "published");
    assert.equal(receipt.execution_id, undefined);
    const resolver = new RuntimeReleaseAgentCorpusResolver({ registryUrl: base, serviceToken: "unit-test-runtime", corpusRoot: runtimeRoot });
    const resolved = await resolver.resolve(auth.account.id, productId, receipt.corpus_digest);
    await materializeAgentCorpus(resolved.root, "Review this claim", [], resolved.runtimeDigest);
    assert.equal(resolved.corpus.skills[0]?.id, "review");
    assert.equal(await readFile(path.join(resolved.root, "instructions/system.md"), "utf8"), system);
    const retry = await request(`/v1/creator/products/${productId}/registry`, { corpus });
    assert.equal(retry.release_digest, receipt.release_digest);
    await assert.rejects(request(`/v1/creator/products/${productId}/registry`, { corpus: { ...corpus, knowledge: [{ source: `creator-products/${auth.account.id}/${productId}/files/missing/projection.md`, title: "Unowned source" }] } }), /422/);
    assert.equal((await resolver.resolve(auth.account.id, productId, receipt.corpus_digest)).corpus.skills[0]?.id, "review");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
