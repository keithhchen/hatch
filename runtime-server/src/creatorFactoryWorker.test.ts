import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  parseQuestions
} from "./creatorLearning/markdown.js";
import { InMemoryCreatorFactoryRepository } from "./creatorLearning/repository.js";
import type { ArtifactObjectStore } from "./creatorLearning/objectStore.js";
import { issueQuestionBatch } from "./creatorLearning/questionBatch.js";
import type { CreatorFactoryRepository, FactoryRunRecord } from "./creatorLearning/repository.js";
import type { FactoryPromptCall, FactoryStartInput } from "./creatorLearning/types.js";
import { CreatorFactoryWorker } from "./creatorLearning/worker.js";

test("durable worker claims a run, pauses for Creator answers, and resumes the same Factory state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const assertLease = repository.assertLease.bind(repository);
  let leaseGuardChecks = 0;
  repository.assertLease = async (input) => {
    leaseGuardChecks += 1;
    await assertLease(input);
  };
  await repository.create({
    id: "worker-run",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "create-worker-run",
    input: {
      runId: "worker-run",
      creator: { id: "11111111-1111-4111-8111-111111111111", name: "Worker Creator" },
      taskName: "Ready-to-publish reply",
      taskBrief: "Return one decisive reply that can be published directly.",
      sources: [{
        id: "S1",
        authority: "creator_current",
        title: "Current method",
        content: "Choose one answer and make it usable."
      }],
      config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
    }
  });
  const factory = new CreatorFactory(
    root,
    passingPromptRunner,
    async (execution) => `Publishable: ${execution.question}`,
    { model: { provider: "test", model: "worker-script" } }
  );
  const worker = new CreatorFactoryWorker(repository, factory, {
    workerId: "worker-one",
    leaseMs: 60_000,
    heartbeatMs: 0
  });

  const waiting = await worker.workOnce();
  assert.equal(waiting?.status, "waiting_for_creator");
  assert.equal(waiting?.state?.stage, "awaiting_creator_answers");
  assert.ok(leaseGuardChecks > 0, "worker must fence file commits against its DB lease");
  const store = new FactoryFileStore(root, "worker-run");
  const questions = parseQuestions(await store.readArtifact(waiting!.state!.artifacts.currentQuestionBatch!));
  await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "worker-run",
    answers: {
      answerMarkdown: renderAnswers(questions),
      questionBatchId: waiting!.state!.artifacts.currentQuestionBatch!.batchId
    },
    expectedVersion: waiting!.version
  });

  const ready = await worker.workOnce();
  assert.equal(ready?.status, "ready");
  assert.equal(ready?.state?.stage, "ready");
  assert.equal(ready?.state?.artifacts.corpusCandidates.length, 2);
  assert.equal(await worker.workOnce(), undefined);
});

test("worker treats a missing OSS state object as a new run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-worker-oss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objects = new Map<string, Buffer>();
  const objectStore: ArtifactObjectStore = {
    async put(key, content) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      objects.set(key, Buffer.from(bytes));
      return { key, sha256: "sha256:test", bytes: bytes.byteLength };
    },
    async get(key) {
      const bytes = objects.get(key);
      if (bytes) return Buffer.from(bytes);
      const error = Object.assign(new Error("The specified key does not exist."), { code: "NoSuchKey", status: 404 });
      throw error;
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    }
  };
  const creatorId = "11111111-1111-4111-8111-111111111111";
  const repository = new InMemoryCreatorFactoryRepository();
  await repository.create({
    id: "worker-oss-run",
    creatorId,
    idempotencyKey: "create-worker-oss-run",
    input: {
      runId: "worker-oss-run",
      creator: { id: creatorId, name: "Worker Creator" },
      taskName: "Ready-to-publish reply",
      taskBrief: "Return one decisive reply that can be published directly.",
      sources: [{ id: "S1", authority: "creator_current", title: "Current method", content: "Choose one answer and make it usable." }],
      config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
    }
  });
  const factory = new CreatorFactory(
    root,
    passingPromptRunner,
    async (execution) => `Publishable: ${execution.question}`,
    { model: { provider: "test", model: "worker-script" }, objectStore }
  );
  const worker = new CreatorFactoryWorker(repository, factory, {
    workerId: "worker-oss",
    leaseMs: 60_000,
    heartbeatMs: 0
  });

  const waiting = await worker.workOnce();
  assert.equal(waiting?.status, "waiting_for_creator");
  assert.equal(waiting?.state?.stage, "awaiting_creator_answers");
});

test("worker never replays an old pending submission into a fresh replacement Question batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-worker-stale-answers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  await repository.create({
    id: "worker-stale-run",
    creatorId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "create-stale-run",
    input: {
      runId: "worker-stale-run",
      creator: { id: "11111111-1111-4111-8111-111111111111", name: "Worker Creator" },
      taskName: "Ready-to-publish reply",
      taskBrief: "Return one decisive reply that can be published directly.",
      sources: [{ id: "S1", authority: "creator_current", title: "Current method", content: "Choose one usable answer." }],
      config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
    }
  });
  const factory = new CreatorFactory(root, passingPromptRunner, async (execution) => `Publishable: ${execution.question}`);
  const worker = new CreatorFactoryWorker(repository, factory, {
    workerId: "worker-stale",
    leaseMs: 60_000,
    heartbeatMs: 0
  });
  const initialWaiting = await worker.workOnce();
  const oldBatch = initialWaiting!.state!.artifacts.currentQuestionBatch!;
  const store = new FactoryFileStore(root, "worker-stale-run");
  const initialQuestions = parseQuestions(await store.readArtifact(oldBatch));
  await repository.submitAnswers({
    creatorId: "11111111-1111-4111-8111-111111111111",
    runId: "worker-stale-run",
    expectedVersion: initialWaiting!.version,
    answers: {
      answers: initialQuestions.map((question) => ({ questionId: question.id, answer: `Old answer ${question.id}` })),
      submissionId: "old-submission",
      questionBatchId: oldBatch.batchId
    }
  });

  // Simulate the exact cross-store failure: the file graph consumed the old
  // answers and durably reached a new replacement batch, but DB complete did
  // not run, so Postgres still contains the old pending submission.
  const replacement = issueQuestionBatch(
    "worker-stale-run",
    await store.writeArtifact("question-batches/replacement-test.md", [
      "# Replacement",
      "## H2.Q1",
      "### Question",
      "Write a genuinely fresh reply.",
      "### Why this question",
      "Fresh boundary.",
      "### Leakage group",
      "fresh-replacement"
    ].join("\n"), true)
  );
  const local = await store.loadState();
  local.stage = "awaiting_creator_answers";
  local.artifacts.currentQuestionBatch = replacement;
  local.pendingQuestionBatch = { purpose: "replacement_heldout", count: 1 };
  await store.saveState(local);

  const synchronized = await worker.workOnce();
  assert.equal(synchronized?.status, "waiting_for_creator");
  assert.equal(synchronized?.pendingAnswers, undefined);
  assert.equal(synchronized?.state?.artifacts.currentQuestionBatch?.sha256, replacement.sha256);
  assert.equal(synchronized?.state?.artifacts.currentQuestionBatch?.batchId, replacement.batchId);
});

test("worker fails closed on legacy pending Creator answers without a run-scoped Question batch ID", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-worker-unbound-answers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input: FactoryStartInput = {
    runId: "worker-unbound-answers",
    creator: { id: "11111111-1111-4111-8111-111111111111", name: "Worker Creator" },
    taskName: "Ready-to-publish reply",
    taskBrief: "Return one decisive reply that can be published directly.",
    sources: [{ id: "S1", authority: "creator_current", title: "Current method", content: "Choose one usable answer." }],
    config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
  };
  const factory = new CreatorFactory(root, passingPromptRunner, async () => "unused");
  const waiting = await factory.start(input);
  const questions = parseQuestions(await new FactoryFileStore(root, waiting.runId).readArtifact(
    waiting.artifacts.currentQuestionBatch!
  ));
  let submitCalled = false;
  const originalSubmit = factory.submitCreatorAnswers.bind(factory);
  factory.submitCreatorAnswers = async (...args: Parameters<CreatorFactory["submitCreatorAnswers"]>) => {
    submitCalled = true;
    return originalSubmit(...args);
  };
  const timestamp = new Date().toISOString();
  const claimed: FactoryRunRecord = {
    id: waiting.runId,
    creatorId: input.creator.id,
    idempotencyKey: "legacy-unbound",
    input,
    status: "running",
    factoryStage: waiting.stage,
    state: waiting,
    pendingAnswers: {
      answers: questions.map((question) => ({ questionId: question.id, answer: `Answer ${question.id}` }))
    },
    version: 2,
    attempts: 1,
    leaseOwner: "worker-unbound",
    leaseToken: "lease-unbound",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  let failure = "";
  const repository = {
    claim: async () => structuredClone(claimed),
    fail: async (request: { error: string }) => {
      failure = request.error;
      return { ...structuredClone(claimed), status: "needs_attention" as const, lastError: request.error };
    },
    assertLease: async () => undefined
  } as unknown as CreatorFactoryRepository;
  const worker = new CreatorFactoryWorker(repository, factory, {
    workerId: "worker-unbound",
    heartbeatMs: 0
  });

  const result = await worker.workOnce();
  assert.equal(result?.status, "needs_attention");
  assert.match(failure, /without a run-scoped Question batch ID/);
  assert.equal(submitCalled, false);
});

async function passingPromptRunner(call: FactoryPromptCall): Promise<string> {
  if (call.purpose === "evidence.extract") return "# Task evidence\nExplicit [S1:L1].";
  if (call.purpose === "eval.generate_questions") {
    return [1, 2, 3].map((number) => [
      `## Q${number}`,
      "### Question",
      `Write reply ${number}.`,
      "### Why this question",
      "It tests a decision.",
      "### Leakage group",
      `group-${number}`
    ].join("\n")).join("\n\n");
  }
  if (call.purpose === "corpus.compile") return layeredCorpusFixture();
  return "## Verdict\nPASS\n## Diagnosis\nAligned.\n## Few-shot candidate\nNone\n## Corpus reflection\nNo change.";
}

function layeredCorpusFixture(): string {
  return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    "Choose one answer and make it publishable.",
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "Compile the Creator's decisive finished-result behavior.",
    "# Requirements traceability",
    "- R1 Creator evidence -> system / instructions/system.md.",
    "# Preservation audit",
    "## Retained",
    "- system / instructions/system.md and its finished-result behavior.",
    "## Added or changed",
    "- R1 is explicit.",
    "## Removed",
    "- None.",
    "## Merged",
    "- None.",
    "## Conflict resolutions",
    "- None.",
    "## Asset identity, path, or layer changes",
    "- None.",
    "# Compilation complete",
    CORPUS_COMPILATION_END_MARKER
  ].join("\n");
}

function renderAnswers(questions: ReturnType<typeof parseQuestions>): string {
  return questions.map((question) => [
    `## ${question.id}`,
    "### Question",
    question.question,
    "### Creator Answer",
    `Creator answer for ${question.id}`
  ].join("\n")).join("\n\n");
}
