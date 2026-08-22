import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeAgentCorpus } from "./agentCorpusMaterialization.js";
import { RuntimeReleaseAgentCorpusResolver } from "./runtimeCorpusResolver.js";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_DIGEST = `sha256:${"a".repeat(64)}`;
const RELEASE_DIGEST = `sha256:${"b".repeat(64)}`;
const BRIEF_SPEC = { contract_version: "1", fields: [{ id: "goal", label: "What should we achieve?", required: true }] };

test("Runtime resolves the installed agent.json as the same corpus used for turn materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-release-"));
  const releaseRoot = path.join(root, PRODUCT_ID, RELEASE_DIGEST.slice("sha256:".length));
  const system = "Use the Creator's method.";
  const systemSha = digest(system);
  try {
    await mkdir(path.join(releaseRoot, "runtime/instructions"), { recursive: true });
    await mkdir(path.join(releaseRoot, "instructions"), { recursive: true });
    await writeFile(path.join(releaseRoot, "instructions/system.md"), system, "utf8");
    await writeFile(path.join(releaseRoot, "runtime/instructions/system.md"), system, "utf8");
    await writeFile(path.join(releaseRoot, "agent.json"), JSON.stringify({
      contract_version: "1",
      creator: { id: CREATOR_ID, name: "Creator" },
      product: { id: PRODUCT_ID, name: "Test Agent", promise: "A test promise.", brief_spec: BRIEF_SPEC, boundaries: [], presentation: {} },
      instructions: { system: { id: "system", path: "instructions/system.md", sha256: systemSha } },
      skills: [],
      knowledge: { documents: [] },
      tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
      evaluations: { synthetic_qa: [], held_out: [] }
    }), "utf8");
    await writeFile(path.join(releaseRoot, "runtime/manifest.json"), JSON.stringify({
      contract_version: "1",
      creator: { id: CREATOR_ID },
      product: { id: PRODUCT_ID, name: "Test Agent", promise: "A test promise." },
      corpus_digest: SOURCE_DIGEST,
      system_ref: { path: "runtime/instructions/system.md", sha256: systemSha },
      skills: [],
      knowledge: [],
      brief_spec: BRIEF_SPEC
    }), "utf8");

    const resolver = new RuntimeReleaseAgentCorpusResolver({
      registryUrl: "https://registry.example.test",
      serviceToken: "runtime-token",
      corpusRoot: root,
      fetchImpl: async () => new Response(JSON.stringify({
        release: {
          product_id: PRODUCT_ID,
          creator_id: CREATOR_ID,
          release_digest: RELEASE_DIGEST,
          corpus_digest: SOURCE_DIGEST,
          corpus_ref: `registry/${PRODUCT_ID}/releases/${RELEASE_DIGEST.slice("sha256:".length)}/corpus.json`,
          release_ref: `registry/${PRODUCT_ID}/releases/${RELEASE_DIGEST.slice("sha256:".length)}`,
          brief_spec: null,
          status: "published",
          published_at: "2026-08-22T00:00:00.000Z"
        },
        runtime_manifest_ref: `registry/${PRODUCT_ID}/releases/${RELEASE_DIGEST.slice("sha256:".length)}/runtime/manifest.json`
      }), { status: 200, headers: { "content-type": "application/json" } })
    });

    const resolved = await resolver.resolve(CREATOR_ID, PRODUCT_ID);
    assert.equal(resolved.corpus.product.id, PRODUCT_ID);
    assert.notEqual(resolved.runtimeDigest, undefined);
    await materializeAgentCorpus(resolved.root, "hello", [], resolved.runtimeDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
