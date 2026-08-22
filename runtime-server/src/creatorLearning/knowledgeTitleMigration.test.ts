import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentCorpusSchema, loadAgentCorpus } from "../agentCorpus.js";
import { runtimeCorpusManifestSchema } from "../runtimeReleaseContract.js";
import {
  CreatorRegistryReleaseStore,
  type CreatorRegistryRelease,
} from "./creatorRegistryRelease.js";
import {
  LocalArtifactObjectStore,
  type ArtifactObjectStore,
  type ObjectStoreObject,
  type ObjectStorePutOptions,
} from "./objectStore.js";
import { migrateKnowledgeTitles } from "./knowledgeTitleMigration.js";
import type { AgentKnowledgeIndexer } from "../qdrantIndexer.js";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

test("migrateKnowledgeTitles converts live Knowledge metadata and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-knowledge-title-migration-"));
  try {
    const fixture = await createLegacyFixture(root);
    const beforeAgent = await readFile(fixture.agentPath);
    const beforeRuntime = await readFile(fixture.runtimePath);
    const beforeObjects = await fixture.objects.list(fixture.release.release_ref);
    await assert.rejects(
      migrateKnowledgeTitles({
        objectStore: fixture.objects,
        releaseStore: fixture.releases,
        runtimeCorpusRoot: fixture.runtimeRoot,
        verifyOnly: true,
      }),
      /still contains historical Knowledge source_summary/,
    );
    assert.equal((await fixture.releases.getLive(PRODUCT_ID))?.release_digest, fixture.release.release_digest);
    assert.deepEqual(await fixture.objects.list(fixture.release.release_ref), beforeObjects);

    const indexedTitles: string[] = [];
    const knowledgeIndexer: AgentKnowledgeIndexer = {
      async stageAgentDocuments(_creatorId, _agentId, _corpusDigest, _corpusRoot, documents) {
        indexedTitles.push(...documents.map((document) => document.title));
      },
      async deleteAgentDocuments() {}
    };

    const first = await migrateKnowledgeTitles({
      objectStore: fixture.objects,
      releaseStore: fixture.releases,
      runtimeCorpusRoot: fixture.runtimeRoot,
      knowledgeIndexer,
    });

    assert.equal(first.scanned, 1);
    assert.equal(first.migrated, 1);
    assert.equal(first.unchanged, 0);
    assert.equal(first.verified, 1);
    assert.deepEqual(indexedTitles, ["A preserved reader title"]);

    const migrated = await fixture.releases.getLive(PRODUCT_ID);
    assert.ok(migrated);
    assert.notEqual(migrated.release_digest, fixture.release.release_digest);
    assert.equal(migrated.corpus_digest, fixture.release.corpus_digest);
    assert.equal((await fixture.releases.listLive()).length, 1);

    const newRoot = path.join(
      fixture.runtimeRoot,
      PRODUCT_ID,
      migrated.release_digest.slice("sha256:".length),
    );
    const newAgent = JSON.parse(await readFile(path.join(newRoot, "agent.json"), "utf8")) as {
      knowledge: { documents: Array<Record<string, unknown>> };
    };
    const newRuntime = JSON.parse(await readFile(path.join(newRoot, "runtime/manifest.json"), "utf8")) as {
      knowledge: Array<Record<string, unknown>>;
    };
    assert.equal(newAgent.knowledge.documents[0]?.title, "A preserved reader title");
    assert.equal("source_summary" in newAgent.knowledge.documents[0]!, false);
    assert.equal(newRuntime.knowledge[0]?.title, "A preserved reader title");
    assert.equal("source_summary" in newRuntime.knowledge[0]!, false);
    assert.doesNotThrow(() => AgentCorpusSchema.parse(newAgent));
    assert.doesNotThrow(() => runtimeCorpusManifestSchema.parse(newRuntime));
    await loadAgentCorpus(newRoot);

    const migratedKnowledge = await readFile(path.join(newRoot, "knowledge/original.md"));
    const migratedRuntimeKnowledge = await readFile(path.join(newRoot, "runtime/knowledge/original.md"));
    assert.deepEqual(migratedKnowledge, fixture.knowledgeBytes);
    assert.deepEqual(migratedRuntimeKnowledge, fixture.knowledgeBytes);
    assert.equal(digest(migratedKnowledge), fixture.knowledgeDigest);
    assert.deepEqual(await readFile(fixture.agentPath), beforeAgent);
    assert.deepEqual(await readFile(fixture.runtimePath), beforeRuntime);

    const newPrefix = migrated.release_ref;
    assert.deepEqual(await fixture.objects.get(`${newPrefix}/corpus.json`), fixture.corpusBytes);
    assert.deepEqual(
      await fixture.objects.get(`${newPrefix}/runtime/knowledge/original.md`),
      fixture.knowledgeBytes,
    );
    const releaseJson = JSON.parse(await fixture.objects.get(`${newPrefix}/release.json`).then((bytes) => bytes.toString("utf8"))) as Record<string, unknown>;
    assert.equal(releaseJson.release_digest, migrated.release_digest);
    assert.equal(releaseJson.runtime_manifest_ref, migrated.runtime_manifest_ref);

    const second = await migrateKnowledgeTitles({
      objectStore: fixture.objects,
      releaseStore: fixture.releases,
      runtimeCorpusRoot: fixture.runtimeRoot,
    });
    assert.equal(second.scanned, 1);
    assert.equal(second.migrated, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(second.verified, 1);
    assert.equal((await fixture.releases.getLive(PRODUCT_ID))?.release_digest, migrated.release_digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateKnowledgeTitles leaves the live pointer untouched when an immutable asset write fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-knowledge-title-migration-failure-"));
  try {
    const fixture = await createLegacyFixture(root);
    const failingObjects = new FailingObjectStore(fixture.objects);
    await assert.rejects(
      migrateKnowledgeTitles({
        objectStore: failingObjects,
        releaseStore: fixture.releases,
        runtimeCorpusRoot: fixture.runtimeRoot,
      }),
      /intentional immutable object failure/,
    );
    assert.equal((await fixture.releases.getLive(PRODUCT_ID))?.release_digest, fixture.release.release_digest);
    const productEntries = await readdir(path.join(fixture.runtimeRoot, PRODUCT_ID));
    assert.deepEqual(productEntries, [fixture.release.release_digest.slice("sha256:".length)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateKnowledgeTitles verifyOnly is read-only and fails on historical data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-knowledge-title-migration-verify-"));
  try {
    const fixture = await createLegacyFixture(root);
    const beforeEntries = await readdir(path.join(fixture.runtimeRoot, PRODUCT_ID));
    await assert.rejects(
      migrateKnowledgeTitles({
        objectStore: fixture.objects,
        releaseStore: fixture.releases,
        runtimeCorpusRoot: fixture.runtimeRoot,
        verifyOnly: true,
      }),
      /still contains historical Knowledge source_summary/,
    );
    assert.equal((await fixture.releases.getLive(PRODUCT_ID))?.release_digest, fixture.release.release_digest);
    assert.deepEqual(await readdir(path.join(fixture.runtimeRoot, PRODUCT_ID)), beforeEntries);
    assert.deepEqual((await fixture.objects.list(fixture.release.release_ref)).sort(), [
      `${fixture.release.release_ref}/corpus.json`,
      `${fixture.release.release_ref}/release.json`,
      `${fixture.release.release_ref}/runtime/instructions/system.md`,
      `${fixture.release.release_ref}/runtime/knowledge/original.md`,
      `${fixture.release.release_ref}/runtime/manifest.json`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type Fixture = {
  runtimeRoot: string;
  objects: LocalArtifactObjectStore;
  releases: CreatorRegistryReleaseStore;
  release: CreatorRegistryRelease;
  agentPath: string;
  runtimePath: string;
  knowledgeBytes: Buffer;
  knowledgeDigest: string;
  corpusBytes: Buffer;
};

async function createLegacyFixture(root: string): Promise<Fixture> {
  const runtimeRoot = path.join(root, "runtime-corpora");
  const objectRoot = path.join(root, "objects");
  const objects = new LocalArtifactObjectStore(objectRoot);
  const releases = new CreatorRegistryReleaseStore();
  const releaseDigest = digest(Buffer.from("legacy-release"));
  const releaseRef = `registry/${PRODUCT_ID}/releases/${releaseDigest.slice("sha256:".length)}`;
  const corpusBytes = Buffer.from('{"legacy":"source corpus"}\n', "utf8");
  const knowledgeBytes = Buffer.from("Original Knowledge bytes must not change.\n", "utf8");
  const systemBytes = Buffer.from("Use the preserved Creator method.\n", "utf8");
  const knowledgeDigest = digest(knowledgeBytes);
  const systemDigest = digest(systemBytes);
  const runtimeManifest = {
    contract_version: "1",
    creator: { id: CREATOR_ID },
    product: { id: PRODUCT_ID, name: "Legacy Product", promise: "Preserve knowledge." },
    corpus_digest: digest(corpusBytes),
    system_ref: { path: "runtime/instructions/system.md", sha256: systemDigest },
    skills: [],
    knowledge: [{
      id: "source-doc",
      source_summary: "A preserved reader title",
      ref: { path: "runtime/knowledge/original.md", sha256: knowledgeDigest },
    }],
    tools: [],
    brief_spec: null,
  };
  const agentManifest = {
    contract_version: "1",
    creator: { id: CREATOR_ID, name: "Creator" },
    product: { id: PRODUCT_ID, name: "Legacy Product", promise: "Preserve knowledge.", boundaries: [], presentation: {} },
    instructions: { system: { id: "system", path: "instructions/system.md", sha256: systemDigest } },
    skills: [],
    knowledge: { documents: [{
      id: "source-doc",
      path: "knowledge/original.md",
      sha256: knowledgeDigest,
      retrieval_only: true,
      source_summary: "A preserved reader title",
    }] },
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
    ],
    evaluations: { synthetic_qa: [], held_out: [] },
  };
  const runtimeBytes = encodeJson(runtimeManifest);
  const agentBytes = encodeJson(agentManifest);
  const oldRoot = path.join(runtimeRoot, PRODUCT_ID, releaseDigest.slice("sha256:".length));
  await mkdir(path.join(oldRoot, "instructions"), { recursive: true });
  await mkdir(path.join(oldRoot, "knowledge"), { recursive: true });
  await mkdir(path.join(oldRoot, "runtime/instructions"), { recursive: true });
  await mkdir(path.join(oldRoot, "runtime/knowledge"), { recursive: true });
  await writeFile(path.join(oldRoot, "instructions/system.md"), systemBytes);
  await writeFile(path.join(oldRoot, "knowledge/original.md"), knowledgeBytes);
  await writeFile(path.join(oldRoot, "runtime/instructions/system.md"), systemBytes);
  await writeFile(path.join(oldRoot, "runtime/knowledge/original.md"), knowledgeBytes);
  const agentPath = path.join(oldRoot, "agent.json");
  const runtimePath = path.join(oldRoot, "runtime/manifest.json");
  await writeFile(agentPath, agentBytes);
  await writeFile(runtimePath, runtimeBytes);

  await objects.put(`${releaseRef}/corpus.json`, corpusBytes, { immutable: true });
  await objects.put(`${releaseRef}/runtime/instructions/system.md`, systemBytes, { immutable: true });
  await objects.put(`${releaseRef}/runtime/knowledge/original.md`, knowledgeBytes, { immutable: true });
  await objects.put(`${releaseRef}/runtime/manifest.json`, runtimeBytes, { immutable: true });
  await objects.put(`${releaseRef}/release.json`, encodeJson({
    product_id: PRODUCT_ID,
    creator_id: CREATOR_ID,
    release_digest: releaseDigest,
    corpus_digest: digest(corpusBytes),
    corpus_ref: `${releaseRef}/corpus.json`,
    release_ref: releaseRef,
    runtime_manifest_ref: `${releaseRef}/runtime/manifest.json`,
    brief_spec: null,
    status: "published",
    published_at: "2026-08-22T00:00:00.000Z",
  }), { immutable: true });
  const release = await releases.publish({
    product_id: PRODUCT_ID,
    creator_id: CREATOR_ID,
    release_digest: releaseDigest,
    corpus_digest: digest(corpusBytes),
    corpus_ref: `${releaseRef}/corpus.json`,
    release_ref: releaseRef,
    runtime_manifest_ref: `${releaseRef}/runtime/manifest.json`,
    brief_spec: null,
    published_at: "2026-08-22T00:00:00.000Z",
  });
  return {
    runtimeRoot,
    objects,
    releases,
    release,
    agentPath,
    runtimePath,
    knowledgeBytes,
    knowledgeDigest,
    corpusBytes,
  };
}

class FailingObjectStore implements ArtifactObjectStore {
  constructor(private readonly delegate: LocalArtifactObjectStore) {}

  async put(_key: string, _content: Buffer | string, _options?: ObjectStorePutOptions): Promise<ObjectStoreObject> {
    throw new Error("intentional immutable object failure");
  }

  async get(key: string): Promise<Buffer> { return this.delegate.get(key); }
  async list(prefix: string): Promise<string[]> { return this.delegate.list(prefix); }
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
