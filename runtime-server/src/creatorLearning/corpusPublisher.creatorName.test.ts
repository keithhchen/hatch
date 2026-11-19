import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { Pool } from "pg";
import { RegistryStoreTs } from "../registryStore.js";
import { CorpusPublisher } from "./corpusPublisher.js";
import { CreatorRegistryReleaseStore } from "./creatorRegistryRelease.js";
import { LocalArtifactObjectStore } from "./objectStore.js";

const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const CREATOR = "11111111-1111-4111-8111-111111111111";
const NEW_CREATOR = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const NEW_PRODUCT = "44444444-4444-4444-8444-444444444444";
const corpus = (system: string) => ({ system_instructions: system, skills: [], tools: [] });

/** A bundle whose agent.json carries the placeholder name, as every live publish used to. */
function placeholderBundle(): Uint8Array {
  const file = (text: string) => ({ sha256: `sha256:${createHash("sha256").update(text).digest("hex")}` });
  const system = "System.\n";
  const empty = "[]\n";
  const manifest = {
    contract_version: "1",
    creator: { id: CREATOR, name: "Creator" },
    product: { id: PRODUCT, name: "P", description: "d", promise: "p", boundaries: [], presentation: {} },
    instructions: { system: { id: "system", path: "instructions/system.md", ...file(system) } },
    skills: [],
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: {
      synthetic_qa: [{ id: "synthetic", path: "evals/synthetic.json", ...file(empty) }],
      held_out: [{ id: "held-out", path: "evals/held-out.json", ...file(empty) }]
    }
  };
  return zipSync({
    "agent.json": strToU8(JSON.stringify(manifest)),
    "instructions/system.md": strToU8(system),
    "evals/synthetic.json": strToU8(empty),
    "evals/held-out.json": strToU8(empty)
  });
}

test("real PostgreSQL: a publish keeps the name an operator set; a new creator gets the default", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `hatch_creator_name_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "hatch-creator-name-"));
    const registry = await RegistryStoreTs.open({ corpusRoot: path.join(root, "runtime"), pool, environment: {} });
    const releases = new CreatorRegistryReleaseStore(pool);
    await releases.ensureSchema();
    const publisher = new CorpusPublisher(new LocalArtifactObjectStore(path.join(root, "objects")), registry, releases, path.join(root, "runtime"));
    const names = async (id: string) => (await pool.query("SELECT display_name FROM creators WHERE id=$1", [id])).rows.map((row) => row.display_name);
    const agentJsonName = async (creator: string, product: string, digest: string) =>
      JSON.parse(await readFile(path.join(root, "runtime", ".immutable-corpora", creator, product, `sha256-${digest.slice("sha256:".length)}`, "agent.json"), "utf8")).creator.name;

    await pool.query("INSERT INTO creators (id, display_name) VALUES ($1,$2)", [CREATOR, "MSC咨询"]);
    const base = { creatorId: CREATOR, productId: PRODUCT, productName: "P", productPromise: "promise" };
    const first = await publisher.publishUploaded({ ...base, corpus: corpus("one") });
    assert.equal(await agentJsonName(CREATOR, PRODUCT, first.published.corpus_digest), "MSC咨询");
    assert.equal(first.published.creator_name, "MSC咨询");
    await registry.activateAgentCorpusRelease(CREATOR, PRODUCT, first.published.corpus_digest, { operationId: "op-1", expectedCurrentDigest: null });
    assert.deepEqual(await names(CREATOR), ["MSC咨询"]);

    // Even a corpus that carries the placeholder cannot overwrite a real name.
    await registry.publishAgentCorpusBundle(CREATOR, PRODUCT, placeholderBundle());
    assert.deepEqual(await names(CREATOR), ["MSC咨询"]);

    const fresh = await publisher.publishUploaded({ ...base, creatorId: NEW_CREATOR, productId: NEW_PRODUCT, corpus: corpus("three") });
    assert.equal(await agentJsonName(NEW_CREATOR, NEW_PRODUCT, fresh.published.corpus_digest), "Creator");
    await registry.activateAgentCorpusRelease(NEW_CREATOR, NEW_PRODUCT, fresh.published.corpus_digest, { operationId: "op-2", expectedCurrentDigest: null });
    assert.deepEqual(await names(NEW_CREATOR), ["Creator"]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
