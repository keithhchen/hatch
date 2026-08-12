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
  parseQaSet
} from "./creatorLearning/markdown.js";
import { CreatorFactoryRepositoryError, InMemoryCreatorFactoryRepository } from "./creatorLearning/repository.js";
import { CreatorFactoryService, type CreateFactoryRunRequest } from "./creatorLearning/service.js";
import type { FactoryPromptCall } from "./creatorLearning/types.js";
import { CreatorFactoryWorker } from "./creatorLearning/worker.js";

test("Creator Factory service persists complete product metadata and canonical declared tools", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-release-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const service = new CreatorFactoryService(repository, root);
  const product = {
    id: "research-brief",
    name: "Research Brief",
    description: "A sourced executive brief.",
    promise: "One decision-ready recommendation.",
    boundaries: ["No unsupported claims."],
    offer: {
      model: "per_delivery" as const,
      amount_minor: 4900,
      currency: "USD",
      unit: "brief"
    },
    presentation: { accent: "fern", layout: { density: "compact" } }
  };
  const tools = [
    { id: "hatch.local.files", kind: "local_harness" as const, capability: "filesystem" as const },
    { id: "hatch.local.command", kind: "local_harness" as const, capability: "shell" as const },
    { id: "hatch.local.repository", kind: "local_harness" as const, capability: "git" as const },
    {
      id: "creator.company-lookup",
      kind: "http_function" as const,
      connection_ref: "company-api",
      operation: "lookup_company",
      description: "Look up one company.",
      input_schema: {
        type: "object",
        properties: { company: { type: "string" } },
        required: ["company"],
        additionalProperties: false
      }
    },
    {
      id: "creator.crm-record",
      kind: "mcp_tool" as const,
      connection_ref: "creator-crm",
      tool_name: "find_record",
      input_schema: { type: "object", properties: { id: { type: "string" } } }
    }
  ];
  const created = await service.create(
    { id: "creator-release", name: "Release Creator" },
    createRequest({ agentId: "research-brief", product, tools }),
    "release-input-1"
  );
  assert.deepEqual(created.run.product, product);
  assert.deepEqual(created.run.declaredToolIds, [
    "hatch.web_search",
    "hatch.file_search",
    ...tools.map((tool) => tool.id)
  ]);

  const stored = await repository.getForCreator("creator-release", created.run.id);
  assert.deepEqual(stored?.input.product, product);
  assert.deepEqual(stored?.input.tools, [
    { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
    { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
    ...tools
  ]);

  const defaulted = await service.create(
    { id: "creator-release", name: "Release Creator" },
    createRequest({ taskName: "Default tool run" }),
    "release-input-default-tools"
  );
  assert.deepEqual(
    (await repository.getForCreator("creator-release", defaulted.run.id))?.input.tools,
    [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" }
    ]
  );
});

test("Creator Factory service rejects non-canonical or secret-bearing tool declarations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-invalid-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new CreatorFactoryService(new InMemoryCreatorFactoryRepository(), root);
  const invalid: Array<{ label: string; tools: unknown; error: RegExp }> = [
    {
      label: "endpoint metadata",
      tools: [{ id: "creator.lookup", kind: "http_function", connection_ref: "lookup-api", operation: "lookup", endpoint: "https://example.com" }],
      error: /endpoint.*forbidden/i
    },
    {
      label: "secret metadata",
      tools: [{ id: "creator.lookup", kind: "http_function", connection_ref: "lookup-api", operation: "lookup", secret_ref: "vault-key" }],
      error: /secret_ref.*forbidden/i
    },
    {
      label: "provider metadata",
      tools: [{ id: "creator.lookup", kind: "http_function", connection_ref: "lookup-api", operation: "lookup", provider: "example" }],
      error: /provider.*forbidden/i
    },
    {
      label: "duplicate id",
      tools: [
        { id: "hatch.local.files", kind: "local_harness", capability: "filesystem" },
        { id: "hatch.local.files", kind: "local_harness", capability: "filesystem" }
      ],
      error: /Duplicate tool id/
    },
    {
      label: "wrong kind fields",
      tools: [{ id: "creator.lookup", kind: "http_function", connection_ref: "lookup-api", tool_name: "lookup" }],
      error: /unsupported field: tool_name/
    },
    {
      label: "missing kind-specific field",
      tools: [{ id: "creator.lookup", kind: "mcp_tool", connection_ref: "lookup-api" }],
      error: /tool_name must not be empty/
    },
    {
      label: "non-canonical connection ref",
      tools: [{ id: "creator.lookup", kind: "http_function", connection_ref: "https://example.com", operation: "lookup" }],
      error: /connection_ref must be a lowercase Agent Corpus identifier/
    },
    {
      label: "wrong built-in capability",
      tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "file_search" }],
      error: /canonical hatch\.web_search/
    },
    {
      label: "array input schema",
      tools: [{ id: "creator.lookup", kind: "http_function", connection_ref: "lookup-api", operation: "lookup", input_schema: [] }],
      error: /input_schema must be a plain object/
    },
    {
      label: "unsupported kind",
      tools: [{ id: "creator.lookup", kind: "browser", connection_ref: "lookup-api", operation: "lookup" }],
      error: /kind must be hatch_builtin/
    }
  ];
  for (const [index, item] of invalid.entries()) {
    await assert.rejects(
      () => service.create(
        { id: "creator-release", name: "Release Creator" },
        createRequest({ tools: item.tools as CreateFactoryRunRequest["tools"] }),
        `invalid-tool-${index}`
      ),
      item.error,
      item.label
    );
  }
});

test("Creator Factory service strictly validates offer and presentation metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-invalid-product-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new CreatorFactoryService(new InMemoryCreatorFactoryRepository(), root);
  const invalid: Array<{ product: unknown; error: RegExp }> = [
    { product: { id: "brief", name: "Brief", unknown: true }, error: /product contains unsupported field: unknown/ },
    { product: { id: "brief", name: "Brief", offer: { amount_minor: -1, currency: "USD" } }, error: /amount_minor/ },
    { product: { id: "brief", name: "Brief", offer: { amount_minor: 100, currency: "usd" } }, error: /uppercase currency/ },
    { product: { id: "brief", name: "Brief", offer: { amount_minor: 100, currency: "USD", endpoint: "x" } }, error: /product\.offer contains unsupported field: endpoint/ },
    { product: { id: "brief", name: "Brief", offer: { amount_minor: 100, currency: "USD", model: "lifetime" } }, error: /per_delivery or subscription/ },
    { product: { id: "brief", name: "Brief", presentation: [] }, error: /presentation must be a plain object/ }
  ];
  for (const [index, item] of invalid.entries()) {
    await assert.rejects(
      () => service.create(
        { id: "creator-release", name: "Release Creator" },
        createRequest({ product: item.product as CreateFactoryRunRequest["product"] }),
        `invalid-product-${index}`
      ),
      item.error
    );
  }
});

test("Creator Factory service exposes only owned questions and candidate metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const service = new CreatorFactoryService(repository, root);
  const factory = new CreatorFactory(
    root,
    passingPromptRunner,
    async (execution) => `Customer-ready result for ${execution.question}`,
    { model: { provider: "test", model: "service-script" } }
  );
  const worker = new CreatorFactoryWorker(repository, factory, { workerId: "service-worker", leaseMs: 60_000, heartbeatMs: 0 });
  const request = {
    taskName: "Publishable sales reply",
    taskBrief: "Choose one tradeoff and return copy ready to publish.",
    sources: [{
      id: "S1",
      authority: "creator_current" as const,
      title: "Creator correction",
      content: "Do not give a menu. Choose and finish the copy."
    }],
    config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
  };
  const created = await service.create({ id: "creator-service", name: "Service Creator" }, request, "request-1");
  const replay = await service.create({ id: "creator-service", name: "Service Creator" }, request, "request-1");
  assert.equal(created.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, created.run.id);
  assert.equal((await service.list("another-creator")).length, 0);

  await worker.workOnce();
  const waiting = await service.get("creator-service", created.run.id);
  assert.equal(waiting.status, "waiting_for_creator");
  assert.equal(waiting.pendingQuestions.length, 3);
  assert.ok(waiting.questionBatchId?.startsWith("qbatch_v1_"));
  assert.equal(JSON.stringify(waiting).includes("currentQuestionBatch"), false);
  assert.equal(JSON.stringify(waiting).includes("sealed/"), false);

  await assert.rejects(
    () => service.get("another-creator", created.run.id),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "run_not_found"
  );
  await assert.rejects(
    () => service.submitAnswers("creator-service", created.run.id, {
      expectedVersion: waiting.version,
      questionBatchId: "",
      answers: waiting.pendingQuestions.map((question) => ({ questionId: question.id, answer: "Stale" }))
    }),
    /question_batch_id must not be empty/
  );
  await assert.rejects(
    () => service.submitAnswers("creator-service", created.run.id, {
      expectedVersion: waiting.version,
      questionBatchId: `qbatch_v1_${"f".repeat(64)}`,
      answers: waiting.pendingQuestions.map((question) => ({ questionId: question.id, answer: "Stale" }))
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );
  await assert.rejects(
    () => service.submitAnswers("creator-service", created.run.id, {
      expectedVersion: waiting.version,
      questionBatchId: waiting.questionBatchId!,
      answers: waiting.pendingQuestions.slice(0, 1).map((question) => ({ questionId: question.id, answer: "Incomplete" }))
    }),
    /missing=/
  );

  const queued = await service.submitAnswers("creator-service", created.run.id, {
    expectedVersion: waiting.version,
    submissionId: "answer-submit-1",
    questionBatchId: waiting.questionBatchId!,
    answers: waiting.pendingQuestions.map((question, index) => ({
      questionId: question.id,
      answer: index === 0
        ? "# Launch plan\n## Final post\nShip one decisive answer."
        : `Creator reference for ${question.id}`
    }))
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.pendingQuestions.length, 0);
  const replayed = await service.submitAnswers("creator-service", created.run.id, {
    expectedVersion: waiting.version,
    submissionId: "answer-submit-1",
    questionBatchId: waiting.questionBatchId!,
    answers: waiting.pendingQuestions.map((question, index) => ({
      questionId: question.id,
      answer: index === 0
        ? "# Launch plan\n## Final post\nShip one decisive answer."
        : `Creator reference for ${question.id}`
    }))
  });
  assert.equal(replayed.status, "queued");
  assert.equal(replayed.version, queued.version);

  await worker.workOnce();
  const ready = await service.get("creator-service", created.run.id);
  assert.equal(ready.status, "ready", ready.lastError);
  assert.equal(ready.candidate?.version, 2);
  assert.ok(ready.candidate?.systemDigest.startsWith("sha256:"));
  assert.ok(ready.candidate?.corpusDigest?.startsWith("sha256:"));
  assert.equal(ready.candidate?.corpusVerified, true);
  assert.equal(ready.pendingQuestions.length, 0);
  assert.equal(JSON.stringify(ready).includes("systemInstructions"), false);
  const completed = await repository.getForCreator("creator-service", created.run.id);
  const development = parseQaSet(await new FactoryFileStore(root, created.run.id).readArtifact(completed!.state!.artifacts.developmentQa!));
  const heldout = parseQaSet(await new FactoryFileStore(root, created.run.id).readArtifact(completed!.state!.artifacts.heldoutRounds[0]!));
  assert.equal([...development, ...heldout].some((row) => row.answer.includes("## Final post")), true);
});

function createRequest(overrides: Partial<CreateFactoryRunRequest> = {}): CreateFactoryRunRequest {
  return {
    taskName: "Decision-ready research brief",
    taskBrief: "Choose one supported recommendation and return a finished brief.",
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Creator method",
      content: "Use verified evidence and make one concrete choice."
    }],
    ...overrides
  };
}

async function passingPromptRunner(call: FactoryPromptCall): Promise<string> {
  if (call.purpose === "evidence.extract") return "# Task evidence\nExplicit [S1:L1].";
  if (call.purpose === "eval.generate_questions") {
    const count = Number(/Question count:\s*(\d+)/.exec(call.prompt)?.[1]);
    return Array.from({ length: count }, (_, index) => [
      `## Q${index + 1}`,
      "### Question",
      `Write customer result ${index + 1}.`,
      "### Why this question",
      "It requires a concrete choice.",
      "### Leakage group",
      `service-group-${index + 1}`
    ].join("\n")).join("\n\n");
  }
  if (call.purpose === "corpus.compile") return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    "# Corpus",
    "Choose one result and make it publishable.",
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "The Creator reference requires one finished result.",
    "# Requirements traceability",
    "- R1 Creator answer -> system/instructions/system.md: choose and finish one result.",
    "# Preservation audit",
    "## Retained",
    "- The decisive finished-result behavior remains in the system asset.",
    "## Added or changed",
    "- R1 is explicit in the system asset.",
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
  return "## Verdict\nPASS\n## Diagnosis\nAligned.\n## Few-shot candidate\nNone\n## Corpus reflection\nNo change.";
}
