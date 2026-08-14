import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { Pool } from "pg";
import test from "node:test";
import { AgentCorpusResolver } from "./agentCorpus.js";
import {
  extractAgentCorpusBundle,
  prepareCurrentCorpusInstall,
  verifyAgentCorpus,
} from "./registryCorpus.js";
import {
  MAX_AGENT_CORPORA_PER_CREATOR,
  RegistryStoreTs,
  registryDatabaseTimeoutMs,
  registryPublishTimeoutMs,
} from "./registryStore.js";

function digest(text: string): string { return `sha256:${createHash("sha256").update(text).digest("hex")}`; }

function bundle(
  agentName = "Signal Review",
  options: { systemPath?: string; knowledge?: string } = {},
): Uint8Array {
  const system = "Use the creator method.\n";
  const systemPath = options.systemPath ?? "instructions/system.md";
  const knowledge = options.knowledge ?? "# Cases\n\nLong reference material.\n";
  const synthetic = "[]\n";
  const asset = (id: string, assetPath: string, text: string) => ({ id, path: assetPath, sha256: digest(text) });
  const manifest = {
    contract_version: "1",
    creator: { id: "11111111-1111-4111-8111-111111111111", name: "Maya Chen" },
    product: {
      id: "22222222-2222-4222-8222-222222222222",
      name: agentName,
      description: "Evidence-first review.",
      promise: "Turn a resume into a signal map.",
      boundaries: ["Does not invent evidence."],
      offer: { model: "per_delivery", amount_minor: 0, currency: "USD", unit: "review" },
      presentation: { accent: "fern" }
    },
    instructions: { system: asset("system", systemPath, system) },
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
    [systemPath]: strToU8(system),
    "knowledge/cases.md": strToU8(knowledge),
    "evals/synthetic.json": strToU8(synthetic),
    "evals/held-out.json": strToU8(synthetic)
  });
}

test("Registry database timeout is bounded", () => {
  assert.equal(registryDatabaseTimeoutMs({}), 5_000);
  assert.equal(registryDatabaseTimeoutMs({ HATCH_REGISTRY_DB_TIMEOUT_MS: "250" }), 250);
  assert.throws(() => registryDatabaseTimeoutMs({ HATCH_REGISTRY_DB_TIMEOUT_MS: "0" }), /HATCH_REGISTRY_DB_TIMEOUT_MS/);
  assert.equal(registryPublishTimeoutMs({}), 60_000);
  assert.equal(registryPublishTimeoutMs({ HATCH_REGISTRY_PUBLISH_TIMEOUT_MS: "250" }), 250);
  assert.throws(() => registryPublishTimeoutMs({ HATCH_REGISTRY_PUBLISH_TIMEOUT_MS: "99" }), /HATCH_REGISTRY_PUBLISH_TIMEOUT_MS/);
});

test("Registry control-plane connections accept canonical UUID tenant identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-uuid-tenant-"));
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath: path.join(root, "registry.json"),
    environment: {},
  });
  try {
    const connection = await store.upsertCreatorToolConnection({
      tenantId: "32ffccf7-893d-4ef3-bdbc-c82fc8fcb90b",
      connectionId: "seth-alpha-lite-search",
      kind: "http",
      secretRef: null,
      secret: "test-secret",
      config: { url: "https://tools.example.test/search" },
      status: "active",
    });
    assert.equal(connection.tenant_id, "32ffccf7-893d-4ef3-bdbc-c82fc8fcb90b");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("staged releases stay immutable until CAS activation and Commerce grants preserve the purchased digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-deployment-"));
  const corpusRoot = path.join(root, "corpora");
  const source = path.join(root, "candidate");
  await mkdir(source, { recursive: true });
  await extractAgentCorpusBundle(bundle("Deployment Candidate", { knowledge: "# Candidate\n\nVersion one.\n" }), source);
  const verified = await verifyAgentCorpus(source, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  const store = await RegistryStoreTs.open({
    corpusRoot,
    statePath: path.join(root, "registry.json"),
    indexer: undefined,
    environment: {}
  });
  try {
    const staged = await store.stageAgentCorpusDirectory(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      source,
      verified.digest
    );
    assert.equal(staged.corpus_digest, verified.digest);
    assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"), undefined);

    const activated = await store.activateAgentCorpusRelease(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      verified.digest,
      { operationId: "publish-op-1", expectedCurrentDigest: null }
    );
    assert.equal(activated.corpus_digest, verified.digest);
    assert.equal(
      (await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest,
      verified.digest
    );

    const grant = await store.grantAgentAccess(
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "55555555-5555-4555-8555-555555555555",
      "44444444-4444-4444-8444-444444444444",
      verified.digest,
      "pinned"
    );
    assert.equal(grant.entitlement_id, "44444444-4444-4444-8444-444444444444");
    assert.equal(grant.purchased_corpus_digest, verified.digest);
    assert.equal(grant.version_policy, "pinned");
    assert.equal((await store.revokeAgentAccess("44444444-4444-4444-8444-444444444444", "33333333-3333-4333-8333-333333333333"))?.status, "revoked");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy access row without an order is rebound to the next real Commerce entitlement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-orphan-access-"));
  const statePath = path.join(root, "registry.json");
  const creatorId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const userId = "33333333-3333-4333-8333-333333333333";
  const indexer = { stageAgentDocuments: async () => undefined, deleteAgentDocuments: async () => undefined };
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath,
    indexer: indexer as never,
    environment: {}
  });
  try {
    const published = await store.publishAgentCorpusBundle(creatorId, productId, bundle());
    const oldEntitlement = "44444444-4444-4444-8444-444444444444";
    const oldOrder = "55555555-5555-4555-8555-555555555555";
    await store.grantAgentAccess(userId, creatorId, productId, oldOrder, oldEntitlement, published.corpus_digest, "pinned");
    await store.close();

    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.agent_access[0].order_id = null;
    await writeFile(statePath, JSON.stringify(state));

    const reopened = await RegistryStoreTs.open({
      corpusRoot: path.join(root, "corpora"),
      statePath,
      indexer: indexer as never,
      environment: {}
    });
    try {
      const newEntitlement = "66666666-6666-4666-8666-666666666666";
      const newOrder = "77777777-7777-4777-8777-777777777777";
      const rebound = await reopened.grantAgentAccess(userId, creatorId, productId, newOrder, newEntitlement, published.corpus_digest, "pinned");
      assert.equal(rebound.entitlement_id, newEntitlement);
      assert.equal(rebound.order_id, newOrder);
      assert.equal((await reopened.listAgentAccess(userId))[0]?.entitlement_id, newEntitlement);
      assert.equal((await reopened.listAgentAccess(userId))[0]?.order_id, newOrder);
    } finally {
      await reopened.close();
    }
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("TypeScript Registry publishes a clean Corpus and indexes knowledge only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-"));
  const statePath = path.join(root, "registry.json");
  const calls: unknown[] = [];
  const indexer = {
    stageAgentDocuments: async (...args: unknown[]) => { calls.push(args); },
    deleteAgentDocuments: async () => undefined,
  };
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  const published = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle());
  assert.equal(published.creator_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(published.agent_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(calls.length, 1);
  const runtimeResolution = await new AgentCorpusResolver(path.join(root, "corpora")).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  assert.equal(runtimeResolution.digest, published.corpus_digest);
  const restored = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  const restoredCorpus = restored.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  assert.equal(restoredCorpus?.corpus_digest, published.corpus_digest);
  assert.equal(restoredCorpus?.product_promise, "Turn a resume into a signal map.");
  assert.deepEqual(restoredCorpus?.product_boundaries, ["Does not invent evidence."]);
  assert.deepEqual(restoredCorpus?.product_offer, { model: "per_delivery", amount_minor: 0, currency: "USD", unit: "review" });
  assert.deepEqual(restoredCorpus?.presentation, { accent: "fern" });
  const grant = await restored.grantAgentAccess("33333333-3333-4333-8333-333333333333", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "55555555-5555-4555-8555-555555555555");
  assert.equal(grant.order_id, "55555555-5555-4555-8555-555555555555");
  await assert.rejects(
    restored.grantAgentAccess("66666666-6666-4666-8666-666666666666", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", ""),
    /order_id_required/
  );
  const concurrent = await Promise.all([
    restored.grantAgentAccess("77777777-7777-4777-8777-777777777777", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "88888888-8888-4888-8888-888888888888"),
    restored.grantAgentAccess("77777777-7777-4777-8777-777777777777", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "88888888-8888-4888-8888-888888888888")
  ]);
  assert.equal(concurrent[0].entitlement_id, concurrent[1].entitlement_id);
  const reopened = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  assert.equal((await reopened.listAgentAccess("33333333-3333-4333-8333-333333333333"))[0]?.order_id, "55555555-5555-4555-8555-555555555555");
  assert.equal((await reopened.listAgentAccess("77777777-7777-4777-8777-777777777777"))[0]?.entitlement_id, concurrent[0].entitlement_id);
  const installed = await readFile(path.join(root, "corpora/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/knowledge/cases.md"), "utf8");
  assert.match(installed, /Long reference material/);
});

test("TypeScript Registry requires Qdrant when a Corpus contains knowledge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-no-index-"));
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), environment: {} });
  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle()),
    /Qdrant knowledge index is not configured/
  );
});

test("every Registry-accepted corpus must satisfy the Runtime loader contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-runtime-contract-"));
  const indexer = {
    async stageAgentDocuments(): Promise<void> {},
    async deleteAgentDocuments(): Promise<void> {},
  };
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), indexer, environment: {} });

  await assert.rejects(
    store.publishAgentCorpusBundle(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      bundle("Wrong System Path", { systemPath: "instructions/alternate.md" }),
    ),
    /runtime-loadable.*instructions\/system\.md/,
  );
  await assert.rejects(
    store.publishAgentCorpusBundle(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      bundle("Oversized Knowledge", { knowledge: "x".repeat(4 * 1024 * 1024 + 1) }),
    ),
    /runtime-loadable.*asset exceeds/,
  );
  assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"), undefined);
});

test("filesystem commit failure restores the old current corpus and never deletes its index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-file-rollback-"));
  const corpusRoot = path.join(root, "corpora");
  const statePath = path.join(root, "state.json");
  const stagedDigests: string[] = [];
  const deletedDigests: string[] = [];
  let stageCount = 0;
  const indexer = {
    async stageAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string, preparedPath: string): Promise<void> {
      stagedDigests.push(corpusDigest);
      stageCount += 1;
      if (stageCount === 2) await rm(preparedPath, { recursive: true, force: true });
    },
    async deleteAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      deletedDigests.push(corpusDigest);
    },
  };
  const store = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  const original = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Original Review"));

  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Broken Rename Review")),
    /ENOENT|no such file/i,
  );

  assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, original.corpus_digest);
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(deletedDigests.includes(stagedDigests[1]!), true);
  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
});

test("Postgres persist failure leaves metadata, current corpus, and old index authoritative", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-db-rollback-"));
  const corpusRoot = path.join(root, "corpora");
  const database = fakeRegistryPool();
  const stagedDigests: string[] = [];
  const deletedDigests: string[] = [];
  const indexer = {
    async stageAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      stagedDigests.push(corpusDigest);
    },
    async deleteAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      deletedDigests.push(corpusDigest);
    },
  };
  const store = await RegistryStoreTs.open({ corpusRoot, pool: database.pool, indexer, environment: {} });
  const original = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Database Original"));
  database.failCorpusUpsert = true;

  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Database Failure")),
    /injected database failure/,
  );

  assert.equal(database.corpusRow?.corpus_digest, original.corpus_digest);
  assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, original.corpus_digest);
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(deletedDigests.includes(stagedDigests[1]!), true);
});

test("unknown Postgres commit outcome preserves its journal and restart completes the canonical commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-db-ambiguous-"));
  const corpusRoot = path.join(root, "corpora");
  const database = fakeRegistryPool();
  const indexer = {
    async stageAgentDocuments(): Promise<void> {},
    async deleteAgentDocuments(): Promise<void> {},
  };
  const store = await RegistryStoreTs.open({ corpusRoot, pool: database.pool, indexer, environment: {} });
  await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Before Ambiguous Commit"));
  database.failCorpusUpsertAfterApply = true;
  database.failNextDigestRead = true;

  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Committed Without Response")),
    /commit outcome is unknown/,
  );
  const committedDigest = String(database.corpusRow?.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, committedDigest);
  assert.equal((await readdir(path.join(corpusRoot, ".install-journal"))).some((name) => name.endsWith(".json")), true);
  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Must Wait For Restart")),
    /commit outcome is unknown/,
  );

  const reopened = await RegistryStoreTs.open({ corpusRoot, pool: database.pool, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, committedDigest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, committedDigest);
  assert.equal((await readdir(path.join(corpusRoot, ".install-journal"))).some((name) => name.endsWith(".json")), false);
});

test("startup journal recovery restores the old current after a crash between filesystem commit and metadata persist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-crash-recovery-"));
  const corpusRoot = path.join(root, "corpora");
  const statePath = path.join(root, "registry.json");
  const deletedDigests: string[] = [];
  const indexer = {
    async stageAgentDocuments(): Promise<void> {},
    async deleteAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      deletedDigests.push(corpusDigest);
    },
  };
  const store = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  const original = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Before Crash"));

  const upload = path.join(root, "crash-upload");
  await extractAgentCorpusBundle(bundle("Filesystem Committed Before Crash"), upload);
  const verified = await verifyAgentCorpus(upload, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  const install = await prepareCurrentCorpusInstall(verified, corpusRoot);
  const journalDirectory = path.join(corpusRoot, ".install-journal");
  const cleanupDirectory = path.join(corpusRoot, ".index-gc");
  await mkdir(journalDirectory, { recursive: true });
  await mkdir(cleanupDirectory, { recursive: true });
  await writeFile(path.join(journalDirectory, "simulated-crash.json"), JSON.stringify({
    creator_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "22222222-2222-4222-8222-222222222222",
    new_digest: verified.digest,
    previous_digest: original.corpus_digest,
    current_path: install.currentPath,
    prepared_path: install.preparedPath,
    backup_path: install.backupPath,
  }), "utf8");
  await writeFile(
    path.join(cleanupDirectory, `11111111-1111-4111-8111-111111111111--22222222-2222-4222-8222-222222222222--${verified.digest.slice("sha256:".length)}.json`),
    JSON.stringify({ creator_id: "11111111-1111-4111-8111-111111111111", agent_id: "22222222-2222-4222-8222-222222222222", corpus_digest: verified.digest }),
    "utf8",
  );
  await install.commit();
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, verified.digest);

  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, original.corpus_digest);
  assert.equal(deletedDigests.includes(verified.digest), true);
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal((await readdir(journalDirectory)).some((name) => name.endsWith(".json")), false);
});

test("state-file persist failure does not expose new metadata or leave the new filesystem current", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-state-rollback-"));
  const corpusRoot = path.join(root, "corpora");
  const statePath = path.join(root, "registry.json");
  const stagedDigests: string[] = [];
  const deletedDigests: string[] = [];
  const indexer = {
    async stageAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      stagedDigests.push(corpusDigest);
    },
    async deleteAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      deletedDigests.push(corpusDigest);
    },
  };
  const store = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  const original = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("State Original"));
  const internals = store as unknown as { persistState(): Promise<void> };
  const persistState = internals.persistState.bind(store);
  internals.persistState = async () => { throw new Error("injected state persistence failure"); };

  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("State Failure")),
    /injected state persistence failure/,
  );
  assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, original.corpus_digest);
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(deletedDigests.includes(stagedDigests[1]!), true);

  internals.persistState = persistState;
  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
});

test("publish hard deadline rolls back current and independently cleans a partially staged digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-publish-timeout-"));
  const corpusRoot = path.join(root, "corpora");
  const statePath = path.join(root, "state.json");
  const stagedDigests: string[] = [];
  const deletedDigests: string[] = [];
  let shouldStall = false;
  const indexer = {
    async stageAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      stagedDigests.push(corpusDigest);
      if (shouldStall) await new Promise<void>(() => undefined);
    },
    async deleteAgentDocuments(_creatorId: string, _agentId: string, corpusDigest: string): Promise<void> {
      deletedDigests.push(corpusDigest);
    },
  };
  const store = await RegistryStoreTs.open({
    corpusRoot,
    statePath,
    indexer,
    // Leave enough headroom for the initial filesystem/index setup on a
    // shared CI runner; the stalled indexer below still exercises the hard
    // deadline path and the test remains bounded by the <1s assertion.
    publishTimeoutMs: 500,
    environment: {},
  });
  const original = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Timeout Original"));
  shouldStall = true;
  const startedAt = Date.now();
  await assert.rejects(
    store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Timeout Candidate")),
    (error) => (error as { code?: string }).code === "registry_publish_timeout",
  );
  assert.ok(Date.now() - startedAt < 1_000);
  const failedDigest = stagedDigests.at(-1)!;
  await waitFor(() => deletedDigests.includes(failedDigest));
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")).digest, original.corpus_digest);

  // The timed-out operation must release the Registry's unique mutation turn
  // after its independent cleanup settles.
  shouldStall = false;
  const recovered = await store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle("Timeout Candidate"));
  assert.equal(store.getAgentCorpus("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")?.corpus_digest, recovered.corpus_digest);
});

test("Registry caps agents per Creator and pages the public catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-quota-"));
  const statePath = path.join(root, "state.json");
  const corpora = Array.from({ length: MAX_AGENT_CORPORA_PER_CREATOR }, (_, index) => ({
    creator_id: "11111111-1111-4111-8111-111111111111",
    agent_id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
    corpus_digest: `sha256:${String(index).padStart(64, "0")}`,
    creator_name: "Maya Chen",
    product_id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
    product_name: `Product ${index}`,
    product_boundaries: [],
    presentation: {},
    knowledge_namespace: `11111111-1111-4111-8111-111111111111:${String(index).padStart(12, "0")}`,
    status: "published",
    published_at: new Date(1_700_000_000_000 + index).toISOString(),
  }));
  await writeFile(statePath, JSON.stringify({ schema_version: 2, agent_corpora: corpora, agent_access: [] }), "utf8");
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath,
    indexer: {
      stageAgentDocuments: async () => undefined,
      deleteAgentDocuments: async () => undefined,
    },
    environment: {},
  });
  try {
    assert.equal((await store.listAllAgentCorpora()).length, 20);
    assert.equal((await store.listAllAgentCorpora({ limit: 10, offset: 10 })).length, 10);
    assert.equal((await store.listAllAgentCorpora({ limit: 21 })).length, 20);
    await assert.rejects(store.listAllAgentCorpora({ limit: 22 }), /catalog limit is invalid/);
    await assert.rejects(
      store.publishAgentCorpusBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", bundle()),
      /may publish at most 20 Agents/,
    );
  } finally {
    await store.close();
  }
});

test("Registry refuses unmigrated split Agent/Product identities at startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-uuid-cutover-state-"));
  const statePath = path.join(root, "state.json");
  const creatorId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const otherProductId = "33333333-3333-4333-8333-333333333333";
  const corpus = {
    creator_id: creatorId,
    agent_id: otherProductId,
    corpus_digest: `sha256:${"a".repeat(64)}`,
    creator_name: "Maya Chen",
    product_id: productId,
    product_name: "Signal Review",
    product_boundaries: [],
    presentation: {},
    knowledge_namespace: `${creatorId}:${productId}`,
    status: "published",
    published_at: "2026-08-03T00:00:00.000Z"
  };
  await writeFile(statePath, JSON.stringify({ schema_version: 2, agent_corpora: [corpus], agent_access: [] }), "utf8");
  await assert.rejects(
    RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, environment: {} }),
    /agent_id must equal product_id/
  );

  await writeFile(statePath, JSON.stringify({
    schema_version: 2,
    agent_corpora: [{ ...corpus, agent_id: productId }],
    agent_access: [{
      entitlement_id: "44444444-4444-4444-8444-444444444444",
      user_id: "55555555-5555-4555-8555-555555555555",
      creator_id: creatorId,
      agent_id: otherProductId,
      product_id: productId,
      status: "active",
      granted_at: "2026-08-03T00:00:00.000Z"
    }]
  }), "utf8");
  await assert.rejects(
    RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, environment: {} }),
    /agent_id must equal product_id/
  );
  await rm(root, { recursive: true, force: true });
});

test("Postgres reads access revocation and tool rotation from the canonical database on every request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-pg-canonical-"));
  const database = fakeRegistryPool();
  database.corpusRow = {
    creator_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "22222222-2222-4222-8222-222222222222",
    corpus_digest: `sha256:${"1".repeat(64)}`,
    creator_name: "Maya Chen",
    product_id: "22222222-2222-4222-8222-222222222222",
    product_name: "Signal Review",
    product_description: "Review work",
    product_json: JSON.stringify({ presentation: { accent: "orange" } }),
    knowledge_namespace: "maya:signal",
    status: "published",
    published_at: "2026-08-03T00:00:00.000Z",
  };
  database.accessRows = [{
    entitlement_id: "44444444-4444-4444-8444-444444444444",
    user_id: "33333333-3333-4333-8333-333333333333",
    creator_id: "11111111-1111-4111-8111-111111111111",
    agent_id: "22222222-2222-4222-8222-222222222222",
    product_id: "22222222-2222-4222-8222-222222222222",
    order_id: "55555555-5555-4555-8555-555555555555",
    status: "active",
    granted_at: "2026-08-03T00:00:00.000Z",
  }];
  database.toolConnectionRow = {
    id: "signal-http",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    kind: "http",
    secret_ref: "vault://signal",
    secret_value: "old-secret",
    config_json: JSON.stringify({ url: "https://tools.example.test/signal" }),
    status: "active",
  };
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    pool: database.pool,
    indexer: {
      async stageAgentDocuments(): Promise<void> {},
      async deleteAgentDocuments(): Promise<void> {},
    },
    environment: {},
  });

  assert.equal((await store.listAgentAccessPresentation("33333333-3333-4333-8333-333333333333")).length, 1);
  assert.equal((await store.listAgentAccessPresentation("33333333-3333-4333-8333-333333333333", { entitlementId: "44444444-4444-4444-8444-444444444444" }))[0]?.entitlement_id, "44444444-4444-4444-8444-444444444444");
  const targetedQuery = [...database.queries].reverse().find((query) => /FROM agent_access AS a/.test(query.text));
  assert.match(targetedQuery?.text ?? "", /a\.entitlement_id=\$2/);
  assert.deepEqual(targetedQuery?.values, ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", 1, 0]);
  assert.equal((await store.resolveCreatorToolConnection({
    tenantId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    toolId: "creator.signal",
  })).secret, "old-secret");

  database.accessRows[0]!.status = "revoked";
  database.toolConnectionRow = { ...database.toolConnectionRow, status: "disabled", secret_value: "rotated-secret" };
  assert.deepEqual(await store.listAgentAccess("33333333-3333-4333-8333-333333333333"), []);
  assert.deepEqual(await store.listAgentAccessPresentation("33333333-3333-4333-8333-333333333333"), []);
  await assert.rejects(
    store.resolveCreatorToolConnection({ tenantId: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222", toolId: "creator.signal" }),
    /not active/,
  );

  database.toolConnectionRow = { ...database.toolConnectionRow, status: "active" };
  assert.equal((await store.resolveCreatorToolConnection({
    tenantId: "11111111-1111-4111-8111-111111111111",
    agentId: "22222222-2222-4222-8222-222222222222",
    toolId: "creator.signal",
  })).secret, "rotated-secret");
});

test("Registry access projection respects status and joins current presentation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-access-"));
  const statePath = path.join(root, "state.json");
  await writeFile(statePath, JSON.stringify({
    schema_version: 2,
    agent_corpora: [{
      creator_id: "11111111-1111-4111-8111-111111111111",
      agent_id: "22222222-2222-4222-8222-222222222222",
      corpus_digest: `sha256:${"a".repeat(64)}`,
      creator_name: "Maya Chen",
      product_id: "22222222-2222-4222-8222-222222222222",
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
        entitlement_id: "66666666-6666-4666-8666-666666666666",
        user_id: "33333333-3333-4333-8333-333333333333",
        creator_id: "11111111-1111-4111-8111-111111111111",
        agent_id: "22222222-2222-4222-8222-222222222222",
        product_id: "22222222-2222-4222-8222-222222222222",
        status: "active",
        granted_at: "2026-08-03T00:00:00.000Z"
      },
      {
        entitlement_id: "77777777-7777-4777-8777-777777777777",
        user_id: "33333333-3333-4333-8333-333333333333",
        creator_id: "11111111-1111-4111-8111-111111111111",
        agent_id: "88888888-8888-4888-8888-888888888888",
        product_id: "88888888-8888-4888-8888-888888888888",
        status: "revoked",
        granted_at: "2026-08-04T00:00:00.000Z"
      }
    ]
  }), "utf8");

  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath });
  try {
    assert.deepEqual((await store.listAgentAccess("33333333-3333-4333-8333-333333333333")).map((grant) => grant.entitlement_id), ["66666666-6666-4666-8666-666666666666"]);
    assert.deepEqual(
      (await store.listAgentAccess("33333333-3333-4333-8333-333333333333", { entitlementId: "66666666-6666-4666-8666-666666666666" })).map((grant) => grant.entitlement_id),
      ["66666666-6666-4666-8666-666666666666"],
    );
    assert.deepEqual((await store.listAgentAccessPresentation("33333333-3333-4333-8333-333333333333"))[0], {
      entitlement_id: "66666666-6666-4666-8666-666666666666",
      user_id: "33333333-3333-4333-8333-333333333333",
      creator_id: "11111111-1111-4111-8111-111111111111",
      agent_id: "22222222-2222-4222-8222-222222222222",
      product_id: "22222222-2222-4222-8222-222222222222",
      status: "active",
      granted_at: "2026-08-03T00:00:00.000Z",
      creator: { id: "11111111-1111-4111-8111-111111111111", name: "Maya Chen" },
      product: { id: "22222222-2222-4222-8222-222222222222", name: "Signal Review", description: "Review work" },
      presentation: { accent: "orange" }
    });
  } finally {
    await store.close();
  }
});

type FakeRegistryDatabase = {
  pool: Pool;
  failCorpusUpsert: boolean;
  failCorpusUpsertAfterApply: boolean;
  failNextDigestRead: boolean;
  corpusRow: Record<string, unknown> | undefined;
  accessRows: Array<Record<string, unknown>>;
  toolConnectionRow: Record<string, unknown> | undefined;
  queries: Array<{ text: string; values: unknown[] | undefined }>;
};

function fakeRegistryPool(): FakeRegistryDatabase {
  const database = {
    pool: undefined as unknown as Pool,
    failCorpusUpsert: false,
    failCorpusUpsertAfterApply: false,
    failNextDigestRead: false,
    corpusRow: undefined,
    accessRows: [],
    toolConnectionRow: undefined,
    queries: [],
  } as FakeRegistryDatabase;
  database.pool = {
    async query(query: string | { text: string; values?: unknown[] }, positionalValues?: unknown[]) {
      const text = typeof query === "string" ? query : query.text;
      const values = typeof query === "string" ? positionalValues : query.values;
      database.queries.push({ text, values });
      if (/^\s*SELECT corpus_digest FROM agent_corpora/.test(text)) {
        if (database.failNextDigestRead) {
          database.failNextDigestRead = false;
          throw new Error("injected reconciliation read failure");
        }
        return { rows: database.corpusRow ? [{ corpus_digest: database.corpusRow.corpus_digest }] : [] };
      }
      if (/^\s*SELECT creator_id, agent_id, corpus_digest/.test(text)) {
        return { rows: database.corpusRow ? [database.corpusRow] : [] };
      }
      if (/FROM agent_access AS a\s+JOIN agent_corpora AS c/.test(text)) {
        const entitlementId = /a\.entitlement_id=\$2/.test(text) ? values?.[1] : undefined;
        const limit = Number(values?.[entitlementId ? 2 : 1] ?? 20);
        const offset = Number(values?.[entitlementId ? 3 : 2] ?? 0);
        const rows = database.accessRows
          .filter((row) => row.user_id === values?.[0] && row.status === "active")
          .filter((row) => !entitlementId || row.entitlement_id === entitlementId)
          .slice(offset, offset + limit)
          .map((row) => ({
            ...row,
            access_status: row.status,
            creator_name: database.corpusRow?.creator_name,
            product_name: database.corpusRow?.product_name,
            product_description: database.corpusRow?.product_description,
            product_json: database.corpusRow?.product_json,
          }));
        return { rows };
      }
      if (/FROM agent_access\s+WHERE user_id=\$1/.test(text)) {
        const entitlementId = /entitlement_id=\$2/.test(text) ? values?.[1] : undefined;
        const limit = Number(values?.[entitlementId ? 2 : 1] ?? 20);
        const offset = Number(values?.[entitlementId ? 3 : 2] ?? 0);
        return { rows: database.accessRows
          .filter((row) => row.user_id === values?.[0] && row.status === "active")
          .filter((row) => !entitlementId || row.entitlement_id === entitlementId)
          .slice(offset, offset + limit) };
      }
      if (/^\s*SELECT entitlement_id, user_id, creator_id, agent_id, product_id, order_id, status, granted_at FROM agent_access/.test(text)) {
        return { rows: database.accessRows };
      }
      if (/FROM agent_tool_bindings AS b JOIN tool_connections AS c/.test(text)) {
        return { rows: database.toolConnectionRow ? [database.toolConnectionRow] : [] };
      }
      if (/^\s*SELECT id, tenant_id, kind, secret_ref, secret_value, config_json, status FROM tool_connections/.test(text)) {
        return { rows: database.toolConnectionRow ? [database.toolConnectionRow] : [] };
      }
      if (/^\s*SELECT tenant_id, agent_id, tool_id, connection_id FROM agent_tool_bindings/.test(text)) {
        return { rows: [] };
      }
      if (/^\s*SELECT /.test(text) || /^\s*CREATE |^\s*ALTER /.test(text)) return { rows: [] };
      if (/^\s*INSERT INTO agent_corpora/.test(text)) {
        if (database.failCorpusUpsert) throw new Error("injected database failure");
        database.corpusRow = {
          creator_id: values?.[0],
          agent_id: values?.[1],
          corpus_digest: values?.[2],
          creator_name: values?.[3],
          product_id: values?.[4],
          product_name: values?.[5],
          product_description: values?.[6],
          product_json: values?.[7],
          knowledge_namespace: values?.[8],
          status: values?.[9],
          published_at: values?.[10],
        };
        if (database.failCorpusUpsertAfterApply) {
          database.failCorpusUpsertAfterApply = false;
          throw new Error("injected response loss after commit");
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {},
  } as unknown as Pool;
  return database;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
