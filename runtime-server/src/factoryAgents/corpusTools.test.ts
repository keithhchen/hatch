import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { createRegistryServerFromEnvironment } from "../registryServer.js";
import { RuntimeReleaseAgentCorpusResolver } from "../runtimeCorpusResolver.js";
import { materializeAgentCorpus } from "../agentCorpusMaterialization.js";
import { WorkbenchStore } from "./store.js";
import { corpusTools, registryRequest } from "./corpusTools.js";
import { digest } from "./files.js";

// Automated local integration: actual HTTP handlers, auth, storage, bundle validation and Runtime resolver.
// No model or production-service UAT is claimed by these tests.
test("Generation uploads canonical files through Registry and the existing Runtime resolver loads the same version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-corpus-test-"));
  const runtimeRoot = path.join(root, "runtime");
  const server = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1", REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"), HATCH_RUNTIME_CORPUS_ROOT: runtimeRoot,
    HATCH_REGISTRY_STATE_PATH: path.join(root, "registry.json"),
    HATCH_CREATOR_FACTORY_ROOT: path.join(root, "factory"),
    HATCH_AUTH_SIGNING_SECRET: "unit-test-secret", HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: "unit-test-runtime",
    DASHSCOPE_API_KEY: "",
  });
  try {
    const address = server.server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "factory-test@example.test", password: "password-123", display_name: "Factory Test" }) });
    assert.equal(signup.status, 201);
    const auth = await signup.json() as { token: string; account: { id: string } };
    const env = { HATCH_FACTORY_REGISTRY_URL: base, HATCH_FACTORY_CREATOR_TOKEN: auth.token };
    const product = await registryRequest(env, "/v1/creator/products", { name: "Canonical definition test", promise: "Review an argument using its evidence." }) as { product: { product_id: string } };
    const productId = product.product.product_id;
    await assert.rejects(registryRequest(env, `/v1/creator/products/${productId}/registry`, {}), /422.*corpus_required/);
    const store = new WorkbenchStore(path.join(root, "workspaces"));
    const session = await store.create("generation");
    const system = "Review the customer's evidence. Ask for missing facts. Never invent citations.\n";
    await store.put(session.id, "output/SYSTEM.md", Buffer.from(system), { actor: "agent" });
    await store.put(session.id, "output/skills/review/SKILL.md", Buffer.from("---\nname: review\ndescription: Review a customer argument.\n---\n\nRead references/evidence.md. Identify the claim, inspect evidence, and explain any gap.\n"), { actor: "agent" });
    await store.put(session.id, "output/skills/review/references/evidence.md", Buffer.from("# Evidence\nCheck whether the evidence supports the exact claim.\n"), { actor: "agent" });
    const hostScope = { creatorId: auth.account.id, productId };
    const tools = corpusTools(store, session.id, () => {}, hostScope, env);
    hostScope.productId = "99999999-9999-4999-8999-999999999999";
    const upload = tools.find(t => t.name === "corpus_upload")!;
    const exposedParameters = JSON.stringify(upload.parameters);
    assert.ok(!exposedParameters.includes("productId") && !exposedParameters.includes("product_id") && !exposedParameters.includes('"name"'));
    const args = { title: "Argument review", opening_questions: [{ label: "Paste the argument to review.", required: true }, { label: "Who is the audience?", required: false }], promise: "Review an argument using its evidence.", skills: [{ path: "output/skills/review/SKILL.md", references: [{ path: "output/skills/review/references/evidence.md", kind: "method" }] }] };
    const { title: _title, opening_questions: _questions, ...withoutStorefront } = args;
    await assert.doesNotReject(upload.execute("publish-without-storefront", withoutStorefront));
    await upload.execute("publish", args);
    const saved = await store.get(session.id); assert.ok(saved.corpus);
    assert.equal(saved.corpus.product_id, productId);
    assert.equal(saved.corpus.status, "published");
    const afterPublish = await registryRequest(env, "/v1/creator/products") as { products: Array<{ product_id: string }> };
    assert.deepEqual(afterPublish.products.map(entry => entry.product_id), [productId]);
    const releaseDir = path.join(runtimeRoot, productId, saved.corpus.release_digest.slice(7));
    assert.equal(await readFile(path.join(releaseDir, "instructions/system.md"), "utf8"), system);
    assert.equal(digest(await readFile(path.join(releaseDir, "source-corpus.json"))), saved.corpus.corpus_digest);
    const resolver = new RuntimeReleaseAgentCorpusResolver({ registryUrl: base, serviceToken: "unit-test-runtime", corpusRoot: runtimeRoot });
    const resolved = await resolver.resolve(auth.account.id, productId, saved.corpus.corpus_digest);
    await materializeAgentCorpus(resolved.root, "Review this claim", [], resolved.runtimeDigest);
    assert.equal(resolved.corpus.skills[0]?.id, "review");
    const revisedPromise = "Turn a customer argument into a clear, evidence-based recommendation.";
    await upload.execute("retry", { ...args, promise: revisedPromise });
    assert.equal((await store.get(session.id)).corpus?.release_digest, saved.corpus.release_digest);
    const revisedProduct = await registryRequest(env, `/v1/creator/products/${productId}`) as { product: { promise: string } };
    assert.equal(revisedProduct.product.promise, revisedPromise);
    const written = revisedProduct.product as unknown as { name: string; brief_spec: { fields: Array<{ id: string; label: string; required: boolean }> } };
    assert.equal(written.name, "Argument review");
    assert.deepEqual(written.brief_spec.fields, [{ id: "q1", label: "Paste the argument to review.", required: true }, { id: "q2", label: "Who is the audience?", required: false }]);
    await assert.rejects(store.put(session.id, "output/CORPUS.md", Buffer.from("fake receipt"), { actor: "agent" }), /immutable/);

    // Completion over quality: a missing file or a broken Skill is skipped and reported to the Builder, never blocking.
    const lenient = await upload.execute("unknown-file", { ...args, skills: [...args.skills, { path: "output/skills/missing/SKILL.md", references: [] }] }) as { details?: unknown; content?: Array<{ text?: string }> };
    const reported = JSON.stringify(lenient);
    assert.match(reported, /output\/skills\/missing\/SKILL\.md/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
