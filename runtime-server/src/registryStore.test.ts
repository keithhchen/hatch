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
    agent_id: "signal-review",
    creator: { id: "maya-chen", name: "Maya Chen" },
    ...(backwardCompatibleWith ? { release: { backward_compatible_with: backwardCompatibleWith } } : {}),
    product: {
      id: "signal-review",
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

test("TypeScript Registry publishes a clean Corpus and indexes knowledge only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-"));
  const statePath = path.join(root, "registry.json");
  const calls: unknown[] = [];
  const indexer = {
    stageAgentDocuments: async (...args: unknown[]) => { calls.push(args); },
    deleteAgentDocuments: async () => undefined,
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
  const grant = await restored.grantAgentAccess("buyer-one", "maya-chen", "signal-review", "order-one", "entitlement-one", published.corpus_digest);
  assert.equal(grant.entitlement_id, "entitlement-one");
  assert.equal(grant.order_id, "order-one");
  await assert.rejects(
    restored.grantAgentAccess("buyer-missing-order", "maya-chen", "signal-review", ""),
    /order_id_required/
  );
  const concurrent = await Promise.all([
    restored.grantAgentAccess("buyer-concurrent", "maya-chen", "signal-review", "order-concurrent"),
    restored.grantAgentAccess("buyer-concurrent", "maya-chen", "signal-review", "order-concurrent")
  ]);
  assert.equal(concurrent[0].entitlement_id, concurrent[1].entitlement_id);
  const reopened = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), statePath, indexer: indexer as never, environment: {} });
  assert.equal((await reopened.listAgentAccess("buyer-one"))[0]?.order_id, "order-one");
  assert.equal((await reopened.listAgentAccess("buyer-concurrent"))[0]?.entitlement_id, concurrent[0].entitlement_id);
  const installed = await readFile(path.join(root, "corpora/maya-chen/signal-review/knowledge/cases.md"), "utf8");
  assert.match(installed, /Long reference material/);
});

test("legacy access without an order and immutable purchase digest is explicitly isolated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-legacy-access-"));
  const statePath = path.join(root, "registry.json");
  await writeFile(statePath, JSON.stringify({
    schema_version: 1,
    agent_corpora: [],
    agent_access: [{
      entitlement_id: "legacy-lifetime-access",
      user_id: "legacy-buyer",
      creator_id: "legacy-creator",
      agent_id: "legacy-agent",
      product_id: "legacy-product",
      status: "active",
      granted_at: "2025-01-01T00:00:00.000Z"
    }],
    creator_tool_connections: []
  }));

  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath,
    environment: {}
  });

  assert.deepEqual(store.listAgentAccess("legacy-buyer"), []);
  await store.close();
});

test("Registry accepts only immutable same-agent compatibility predecessors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-compatible-"));
  const indexer = { replaceAgentDocuments: async () => {} };
  const store = await RegistryStoreTs.open({
    corpusRoot: path.join(root, "corpora"),
    statePath: path.join(root, "registry.json"),
    indexer: indexer as never,
    environment: {}
  });
  const first = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review V1"));
  const compatible = await store.publishAgentCorpusBundle(
    "maya-chen",
    "signal-review",
    bundle("Signal Review V2", first.corpus_digest)
  );
  assert.equal(compatible.backward_compatible_with, first.corpus_digest);
  const resolved = await new AgentCorpusResolver(path.join(root, "corpora")).resolve(
    "maya-chen",
    "signal-review",
    compatible.corpus_digest
  );
  assert.equal(resolved.corpus.release?.backward_compatible_with, first.corpus_digest);
  const trackedGrant = await store.grantAgentAccess(
    "buyer-compatible",
    "maya-chen",
    "signal-review",
    "order-compatible",
    "entitlement-compatible",
    first.corpus_digest,
    "track_current_compatible"
  );
  assert.equal(trackedGrant.version_policy, "track_current_compatible");
  assert.equal(trackedGrant.effective_corpus_digest, first.corpus_digest);
  assert.deepEqual(trackedGrant.version_history, []);
  await assert.rejects(
    store.publishAgentCorpusBundle(
      "maya-chen",
      "signal-review",
      bundle("Signal Review invalid", `sha256:${"f".repeat(64)}`)
    ),
    /immutable release for the same creator and agent/
  );
});

test("Registry stages Factory candidates without changing current and activates them with CAS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-stage-cas-"));
  const corpusRoot = path.join(root, "corpora");
  const statePath = path.join(root, "registry.json");
  const indexer = { replaceAgentDocuments: async () => {} };
  const store = await RegistryStoreTs.open({ corpusRoot, statePath, indexer: indexer as never, environment: {} });
  const resolver = new AgentCorpusResolver(corpusRoot);

  const first = await store.stageAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review staged V1"));
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review"), undefined);
  const exactStaged = await store.getAgentCorpusRelease("maya-chen", "signal-review", first.corpus_digest);
  assert.equal(exactStaged?.corpus_digest, first.corpus_digest);
  assert.equal(exactStaged?.product_name, "Signal Review staged V1");
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review"), undefined, "an exact release read must not activate it");
  assert.equal(
    await store.getAgentCorpusRelease("maya-chen", "another-agent", first.corpus_digest),
    undefined,
    "the exact release authority is scoped to creator and agent"
  );
  await assert.rejects(resolver.resolve("maya-chen", "signal-review"), /ENOENT|not materialized/);
  assert.equal(
    (await resolver.resolve("maya-chen", "signal-review", first.corpus_digest)).digest,
    first.corpus_digest,
    "stage must durably materialize the immutable release"
  );

  const activatedFirst = await store.activateAgentCorpusRelease(
    "maya-chen",
    "signal-review",
    first.corpus_digest,
    { operationId: "deploy-first", expectedCurrentDigest: null }
  );
  assert.equal(activatedFirst.corpus_digest, first.corpus_digest);
  assert.equal((await resolver.resolve("maya-chen", "signal-review")).digest, first.corpus_digest);

  const second = await store.stageAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review staged V2", first.corpus_digest));
  const exactSecond = await store.getAgentCorpusRelease("maya-chen", "signal-review", second.corpus_digest);
  assert.equal(exactSecond?.backward_compatible_with, first.corpus_digest);
  assert.equal(
    (await resolver.resolve("maya-chen", "signal-review")).digest,
    first.corpus_digest,
    "a later stage must not move the serving pointer"
  );
  await assert.rejects(
    store.activateAgentCorpusRelease(
      "maya-chen",
      "signal-review",
      second.corpus_digest,
      { operationId: "deploy-stale", expectedCurrentDigest: null }
    ),
    (error: unknown) => error instanceof RegistryDeploymentConflictError
      && error.expectedCurrentDigest === null
      && error.currentCorpusDigest === first.corpus_digest
  );

  const activatedSecond = await store.activateAgentCorpusRelease(
    "maya-chen",
    "signal-review",
    second.corpus_digest,
    { operationId: "deploy-second", expectedCurrentDigest: first.corpus_digest }
  );
  const replay = await store.activateAgentCorpusRelease(
    "maya-chen",
    "signal-review",
    second.corpus_digest,
    { operationId: "deploy-second", expectedCurrentDigest: first.corpus_digest }
  );
  assert.deepEqual(replay, activatedSecond, "target-current is an idempotent replay even after CAS has advanced");
  assert.equal((await resolver.resolve("maya-chen", "signal-review")).digest, second.corpus_digest);
});

test("Factory directory stage and publish reject a replaced candidate before any side effect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-factory-digest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexCalls: unknown[] = [];
  const indexer = { replaceAgentDocuments: async (...args: unknown[]) => { indexCalls.push(args); } };
  const corpusRoot = path.join(root, "corpora");
  const store = await RegistryStoreTs.open({
    corpusRoot,
    statePath: path.join(root, "registry.json"),
    indexer: indexer as never,
    environment: {}
  });

  for (const operation of ["stage", "publish"] as const) {
    const source = path.join(root, `${operation}-candidate`);
    await extractAgentCorpusBundle(bundle(`Approved ${operation}`), source);
    const approved = await verifyAgentCorpus(source, "maya-chen", "signal-review");

    // Simulate replacement after Factory returned its ready DB digest but
    // before Registry re-read the hand-off directory.
    await rm(source, { recursive: true, force: true });
    await extractAgentCorpusBundle(bundle(`Replaced ${operation}`), source);
    const replacement = await verifyAgentCorpus(source, "maya-chen", "signal-review");
    assert.notEqual(replacement.digest, approved.digest);

    await assert.rejects(
      operation === "stage"
        ? store.stageAgentCorpusDirectory(
            "maya-chen",
            "signal-review",
            source,
            approved.digest,
          )
        : store.publishAgentCorpusDirectory(
            "maya-chen",
            "signal-review",
            source,
            approved.digest,
          ),
      (error: unknown) => error instanceof RegistryFactoryCandidateChangedError
        && error.expectedCorpusDigest === approved.digest
        && error.currentCorpusDigest === replacement.digest
    );

    assert.equal(indexCalls.length, 0, `${operation} must not index a changed candidate`);
    assert.equal(store.getAgentCorpus("maya-chen", "signal-review"), undefined);
    assert.equal(await store.getAgentCorpusRelease("maya-chen", "signal-review", approved.digest), undefined);
    assert.equal(await store.getAgentCorpusRelease("maya-chen", "signal-review", replacement.digest), undefined);
  }

  assert.deepEqual(await store.listAllAgentCorpora(), []);
  await assert.rejects(
    new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review"),
    /ENOENT|not materialized/
  );
});

test("Registry serializes competing CAS activations and only one target wins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-cas-race-"));
  const corpusRoot = path.join(root, "corpora");
  const indexer = { replaceAgentDocuments: async () => {} };
  const store = await RegistryStoreTs.open({
    corpusRoot,
    statePath: path.join(root, "registry.json"),
    indexer: indexer as never,
    environment: {}
  });
  const first = await store.stageAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review race V1"));
  await store.activateAgentCorpusRelease("maya-chen", "signal-review", first.corpus_digest, {
    operationId: "race-initial",
    expectedCurrentDigest: null
  });
  const second = await store.stageAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review race V2", first.corpus_digest));
  const third = await store.stageAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review race V3", first.corpus_digest));
  const attempts = await Promise.allSettled([
    store.activateAgentCorpusRelease("maya-chen", "signal-review", second.corpus_digest, {
      operationId: "race-second",
      expectedCurrentDigest: first.corpus_digest
    }),
    store.activateAgentCorpusRelease("maya-chen", "signal-review", third.corpus_digest, {
      operationId: "race-third",
      expectedCurrentDigest: first.corpus_digest
    })
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejection = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(rejection?.status === "rejected" && rejection.reason instanceof RegistryDeploymentConflictError);
  const current = store.getAgentCorpus("maya-chen", "signal-review");
  assert.ok(current?.corpus_digest === second.corpus_digest || current?.corpus_digest === third.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, current?.corpus_digest);
});

test("Registry open repairs a stale filesystem pointer from durable current metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-pointer-repair-"));
  const corpusRoot = path.join(root, "corpora");
  const statePath = path.join(root, "registry.json");
  const indexer = { replaceAgentDocuments: async () => {} };
  const store = await RegistryStoreTs.open({ corpusRoot, statePath, indexer: indexer as never, environment: {} });
  const first = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review repair V1"));
  const second = await store.stageAgentCorpusBundle("maya-chen", "signal-review", bundle("Signal Review repair V2", first.corpus_digest));
  await store.activateAgentCorpusRelease("maya-chen", "signal-review", second.corpus_digest, {
    operationId: "repair-second",
    expectedCurrentDigest: first.corpus_digest
  });

  // This is the on-disk shape of a process dying after metadata commit but
  // before the final pointer replacement: durable metadata says V2 while the
  // old V1 pointer remains.
  await writeFile(currentAgentCorpusPointerPath(corpusRoot, "maya-chen", "signal-review"), JSON.stringify({
    schema_version: 1,
    creator_id: "maya-chen",
    agent_id: "signal-review",
    corpus_digest: first.corpus_digest,
    activated_at: new Date(0).toISOString()
  }) + "\n", "utf8");
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, first.corpus_digest);

  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer: indexer as never, environment: {} });
  assert.equal(reopened.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, second.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, second.corpus_digest);
});

test("TypeScript Registry requires Qdrant when a Corpus contains knowledge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-no-index-"));
  const store = await RegistryStoreTs.open({ corpusRoot: path.join(root, "corpora"), environment: {} });
  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle()),
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
      "maya-chen",
      "signal-review",
      bundle("Wrong System Path", { systemPath: "instructions/alternate.md" }),
    ),
    /runtime-loadable.*instructions\/system\.md/,
  );
  await assert.rejects(
    store.publishAgentCorpusBundle(
      "maya-chen",
      "signal-review",
      bundle("Oversized Knowledge", { knowledge: "x".repeat(4 * 1024 * 1024 + 1) }),
    ),
    /runtime-loadable.*asset exceeds/,
  );
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review"), undefined);
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
  const original = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Original Review"));

  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Broken Rename Review")),
    /ENOENT|no such file/i,
  );

  assert.equal(store.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, original.corpus_digest);
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(deletedDigests.includes(stagedDigests[1]!), true);
  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
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
  const original = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Database Original"));
  database.failCorpusUpsert = true;

  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Database Failure")),
    /injected database failure/,
  );

  assert.equal(database.corpusRow?.corpus_digest, original.corpus_digest);
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, original.corpus_digest);
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
  await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Before Ambiguous Commit"));
  database.failCorpusUpsertAfterApply = true;
  database.failNextDigestRead = true;

  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Committed Without Response")),
    /commit outcome is unknown/,
  );
  const committedDigest = String(database.corpusRow?.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, committedDigest);
  assert.equal((await readdir(path.join(corpusRoot, ".install-journal"))).some((name) => name.endsWith(".json")), true);
  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Must Wait For Restart")),
    /commit outcome is unknown/,
  );

  const reopened = await RegistryStoreTs.open({ corpusRoot, pool: database.pool, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, committedDigest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, committedDigest);
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
  const original = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Before Crash"));

  const upload = path.join(root, "crash-upload");
  await extractAgentCorpusBundle(bundle("Filesystem Committed Before Crash"), upload);
  const verified = await verifyAgentCorpus(upload, "maya-chen", "signal-review");
  const install = await prepareCurrentCorpusInstall(verified, corpusRoot);
  const journalDirectory = path.join(corpusRoot, ".install-journal");
  const cleanupDirectory = path.join(corpusRoot, ".index-gc");
  await mkdir(journalDirectory, { recursive: true });
  await mkdir(cleanupDirectory, { recursive: true });
  await writeFile(path.join(journalDirectory, "simulated-crash.json"), JSON.stringify({
    creator_id: "maya-chen",
    agent_id: "signal-review",
    new_digest: verified.digest,
    previous_digest: original.corpus_digest,
    current_path: install.currentPath,
    prepared_path: install.preparedPath,
    backup_path: install.backupPath,
  }), "utf8");
  await writeFile(
    path.join(cleanupDirectory, `maya-chen--signal-review--${verified.digest.slice("sha256:".length)}.json`),
    JSON.stringify({ creator_id: "maya-chen", agent_id: "signal-review", corpus_digest: verified.digest }),
    "utf8",
  );
  await install.commit();
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, verified.digest);

  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, original.corpus_digest);
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
  const original = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("State Original"));
  const internals = store as unknown as { persistState(): Promise<void> };
  const persistState = internals.persistState.bind(store);
  internals.persistState = async () => { throw new Error("injected state persistence failure"); };

  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("State Failure")),
    /injected state persistence failure/,
  );
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, original.corpus_digest);
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(deletedDigests.includes(stagedDigests[1]!), true);

  internals.persistState = persistState;
  const reopened = await RegistryStoreTs.open({ corpusRoot, statePath, indexer, environment: {} });
  assert.equal(reopened.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
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
    publishTimeoutMs: 200,
    environment: {},
  });
  const original = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Timeout Original"));
  shouldStall = true;
  const startedAt = Date.now();
  await assert.rejects(
    store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Timeout Candidate")),
    (error) => (error as { code?: string }).code === "registry_publish_timeout",
  );
  assert.ok(Date.now() - startedAt < 1_000);
  const failedDigest = stagedDigests.at(-1)!;
  await waitFor(() => deletedDigests.includes(failedDigest));
  assert.equal(deletedDigests.includes(original.corpus_digest), false);
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, original.corpus_digest);
  assert.equal((await new AgentCorpusResolver(corpusRoot).resolve("maya-chen", "signal-review")).digest, original.corpus_digest);

  // The timed-out operation must release the Registry's unique mutation turn
  // after its independent cleanup settles.
  shouldStall = false;
  const recovered = await store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle("Timeout Candidate"));
  assert.equal(store.getAgentCorpus("maya-chen", "signal-review")?.corpus_digest, recovered.corpus_digest);
});

test("Registry caps agents per Creator and pages the public catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-quota-"));
  const statePath = path.join(root, "state.json");
  const corpora = Array.from({ length: MAX_AGENT_CORPORA_PER_CREATOR }, (_, index) => ({
    creator_id: "maya-chen",
    agent_id: `agent-${index}`,
    corpus_digest: `sha256:${String(index).padStart(64, "0")}`,
    creator_name: "Maya Chen",
    product_id: `product-${index}`,
    product_name: `Product ${index}`,
    product_boundaries: [],
    presentation: {},
    knowledge_namespace: `maya-chen:agent-${index}`,
    status: "published",
    published_at: new Date(1_700_000_000_000 + index).toISOString(),
  }));
  await writeFile(statePath, JSON.stringify({ schema_version: 1, agent_corpora: corpora, agent_access: [] }), "utf8");
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
      store.publishAgentCorpusBundle("maya-chen", "signal-review", bundle()),
      /may publish at most 20 Agents/,
    );
  } finally {
    await store.close();
  }
});

test("Postgres reads access revocation and tool rotation from the canonical database on every request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-registry-pg-canonical-"));
  const database = fakeRegistryPool();
  database.corpusRow = {
    creator_id: "maya",
    agent_id: "signal",
    corpus_digest: `sha256:${"1".repeat(64)}`,
    creator_name: "Maya Chen",
    product_id: "signal-product",
    product_name: "Signal Review",
    product_description: "Review work",
    product_json: JSON.stringify({ presentation: { accent: "orange" } }),
    knowledge_namespace: "maya:signal",
    status: "published",
    published_at: "2026-08-03T00:00:00.000Z",
  };
  database.accessRows = [{
    entitlement_id: "ent_pg",
    user_id: "jordan",
    creator_id: "maya",
    agent_id: "signal",
    product_id: "signal-product",
    order_id: "order_pg",
    status: "active",
    granted_at: "2026-08-03T00:00:00.000Z",
  }];
  database.toolConnectionRow = {
    id: "signal-http",
    tenant_id: "maya",
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

  assert.equal((await store.listAgentAccessPresentation("jordan")).length, 1);
  assert.equal((await store.listAgentAccessPresentation("jordan", { entitlementId: "ent_pg" }))[0]?.entitlement_id, "ent_pg");
  const targetedQuery = [...database.queries].reverse().find((query) => /FROM agent_access AS a/.test(query.text));
  assert.match(targetedQuery?.text ?? "", /a\.entitlement_id=\$2/);
  assert.deepEqual(targetedQuery?.values, ["jordan", "ent_pg", 1, 0]);
  assert.equal((await store.resolveCreatorToolConnection({
    tenantId: "maya",
    agentId: "signal",
    toolId: "creator.signal",
  })).secret, "old-secret");

  database.accessRows[0]!.status = "revoked";
  database.toolConnectionRow = { ...database.toolConnectionRow, status: "disabled", secret_value: "rotated-secret" };
  assert.deepEqual(await store.listAgentAccess("jordan"), []);
  assert.deepEqual(await store.listAgentAccessPresentation("jordan"), []);
  await assert.rejects(
    store.resolveCreatorToolConnection({ tenantId: "maya", agentId: "signal", toolId: "creator.signal" }),
    /not active/,
  );

  database.toolConnectionRow = { ...database.toolConnectionRow, status: "active" };
  assert.equal((await store.resolveCreatorToolConnection({
    tenantId: "maya",
    agentId: "signal",
    toolId: "creator.signal",
  })).secret, "rotated-secret");
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
    assert.deepEqual((await store.listAgentAccess("jordan")).map((grant) => grant.entitlement_id), ["ent_active"]);
    assert.deepEqual(
      (await store.listAgentAccess("jordan", { entitlementId: "ent_active" })).map((grant) => grant.entitlement_id),
      ["ent_active"],
    );
    assert.deepEqual((await store.listAgentAccessPresentation("jordan"))[0], {
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
