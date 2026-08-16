import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { InMemoryDistillationGraphStore } from "./creatorLearning/distillationGraph.js";

test("Creator Factory service persists complete product metadata and canonical declared tools", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-release-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const service = new CreatorFactoryService(repository, root);
  const product = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Research Brief",
    description: "A sourced executive brief.",
    promise: "One decision-ready recommendation.",
    boundaries: ["No unsupported claims."],
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
    { id: "11111111-1111-4111-8111-111111111111", name: "Release Creator" },
    createRequest({ agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", product, tools }),
    "release-input-1"
  );
  assert.deepEqual(created.run.product, product);
  assert.deepEqual(created.run.declaredToolIds, [
    "hatch.web_search",
    "hatch.file_search",
    ...tools.map((tool) => tool.id)
  ]);

  const stored = await repository.getForCreator("11111111-1111-4111-8111-111111111111", created.run.id);
  assert.deepEqual(stored?.input.product, product);
  assert.deepEqual(stored?.input.tools, [
    { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
    { id: "hatch.file_search", kind: "hatch_builtin", capability: "file_search" },
    ...tools
  ]);

  const defaulted = await service.create(
    { id: "11111111-1111-4111-8111-111111111111", name: "Release Creator" },
    createRequest({ productName: "Default tool run" }),
    "release-input-default-tools"
  );
  assert.deepEqual(
    (await repository.getForCreator("11111111-1111-4111-8111-111111111111", defaulted.run.id))?.input.tools,
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
        { id: "11111111-1111-4111-8111-111111111111", name: "Release Creator" },
        createRequest({ tools: item.tools as CreateFactoryRunRequest["tools"] }),
        `invalid-tool-${index}`
      ),
      item.error,
      item.label
    );
  }
});

test("Creator Factory service strictly validates Product and presentation metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-invalid-product-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new CreatorFactoryService(new InMemoryCreatorFactoryRepository(), root);
  const invalid: Array<{ product: unknown; error: RegExp }> = [
    { product: { id: "brief", name: "Brief", unknown: true }, error: /product contains unsupported field: unknown/ },
    { product: { id: "brief", name: "Brief", offer: { amount_minor: 0 } }, error: /product contains unsupported field: offer/ },
    { product: { id: "brief", name: "Brief", presentation: [] }, error: /presentation must be a plain object/ }
  ];
  for (const [index, item] of invalid.entries()) {
    await assert.rejects(
      () => service.create(
        { id: "11111111-1111-4111-8111-111111111111", name: "Release Creator" },
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
    productName: "Publishable sales reply",
    productPromise: "Choose one tradeoff and return copy ready to publish.",
    sources: [{
      id: "S1",
      authority: "creator_current" as const,
      title: "Creator correction",
      content: "Do not give a menu. Choose and finish the copy."
    }],
    config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
  };
  const created = await service.create({ id: "11111111-1111-4111-8111-111111111111", name: "Service Creator" }, request, "request-1");
  const replay = await service.create({ id: "11111111-1111-4111-8111-111111111111", name: "Service Creator" }, request, "request-1");
  assert.equal(created.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, created.run.id);
  assert.equal((await service.list("another-creator")).length, 0);

  await worker.workOnce();
  const waiting = await service.get("11111111-1111-4111-8111-111111111111", created.run.id);
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
    () => service.submitAnswers("11111111-1111-4111-8111-111111111111", created.run.id, {
      expectedVersion: waiting.version,
      questionBatchId: "",
      answers: waiting.pendingQuestions.map((question) => ({ questionId: question.id, answer: "Stale" }))
    }),
    /question_batch_id must not be empty/
  );
  await assert.rejects(
    () => service.submitAnswers("11111111-1111-4111-8111-111111111111", created.run.id, {
      expectedVersion: waiting.version,
      questionBatchId: `qbatch_v1_${"f".repeat(64)}`,
      answers: waiting.pendingQuestions.map((question) => ({ questionId: question.id, answer: "Stale" }))
    }),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );
  await assert.rejects(
    () => service.submitAnswers("11111111-1111-4111-8111-111111111111", created.run.id, {
      expectedVersion: waiting.version,
      questionBatchId: waiting.questionBatchId!,
      answers: waiting.pendingQuestions.slice(0, 1).map((question) => ({ questionId: question.id, answer: "Incomplete" }))
    }),
    /missing=/
  );

  const queued = await service.submitAnswers("11111111-1111-4111-8111-111111111111", created.run.id, {
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
  const replayed = await service.submitAnswers("11111111-1111-4111-8111-111111111111", created.run.id, {
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
  const ready = await service.get("11111111-1111-4111-8111-111111111111", created.run.id);
  assert.equal(ready.status, "ready", ready.lastError);
  assert.equal(ready.candidate?.version, 2);
  assert.ok(ready.candidate?.systemDigest.startsWith("sha256:"));
  assert.ok(ready.candidate?.corpusDigest?.startsWith("sha256:"));
  assert.equal(ready.candidate?.corpusVerified, true);
  assert.equal(ready.pendingQuestions.length, 0);
  assert.equal(JSON.stringify(ready).includes("systemInstructions"), false);
  const review = await service.getReview("11111111-1111-4111-8111-111111111111", created.run.id);
  assert.equal(review.corpus.available, true);
  assert.ok(review.corpus.assets.some((asset) => asset.layer === "system" && asset.content.length > 0));
  assert.ok(review.corpus.assets.length >= 1);
  assert.ok(review.corpus.assets.every((asset) => asset.content.length > 0 && asset.sha256.startsWith("sha256:")));
  assert.equal(review.corpus.evaluationAssets.included, false);
  assert.equal(review.corpus.evaluationAssets.sealed, true);
  const completed = await repository.getForCreator("11111111-1111-4111-8111-111111111111", created.run.id);
  const development = parseQaSet(await new FactoryFileStore(root, created.run.id).readArtifact(completed!.state!.artifacts.developmentQa!));
  const heldout = parseQaSet(await new FactoryFileStore(root, created.run.id).readArtifact(completed!.state!.artifacts.heldoutRounds[0]!));
  assert.equal([...development, ...heldout].some((row) => row.answer.includes("## Final post")), true);
});

test("Creator Review is an immutable, idempotent projection over candidate cases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const graph = new InMemoryDistillationGraphStore();
  const service = new CreatorFactoryService(repository, root, undefined, undefined, graph);
  const creator = { id: "11111111-1111-4111-8111-111111111111", name: "Review Creator" };
  const product = await service.createProduct(creator.id, { name: "Reviewable method", promise: "Return one finished recommendation." });
  const document = await service.createSourceDocument(creator.id, {
    productId: product.id,
    displayName: "method.md",
    mediaType: "text/markdown",
    bytes: Buffer.from("# Method\nChoose one supported recommendation.\n", "utf8")
  });
  const created = await service.create(creator, createRequest({
    productId: product.id,
    productName: product.name,
    productPromise: product.promise,
    sources: undefined,
    sourceDocumentIds: [document.id],
    config: { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 }
  }), "review-run-1");
  const factory = new CreatorFactory(root, passingPromptRunner, async (execution) => `Customer-ready result for ${execution.question}`, { model: { provider: "test", model: "service-script" }, graphStore: graph });
  const worker = new CreatorFactoryWorker(repository, factory, { workerId: "review-worker", leaseMs: 60_000, heartbeatMs: 0 });
  await worker.workOnce();
  const waiting = await service.get(creator.id, created.run.id);
  await service.submitAnswers(creator.id, created.run.id, {
    expectedVersion: waiting.version,
    submissionId: "review-answer-1",
    questionBatchId: waiting.questionBatchId!,
    answers: waiting.pendingQuestions.map((question) => ({ questionId: question.id, answer: `Reference ${question.id}` }))
  });
  await worker.workOnce();
  const ready = await service.get(creator.id, created.run.id);
  assert.equal(ready.status, "ready", ready.lastError);
  const projection = await service.getReview(creator.id, created.run.id);
  assert.equal(projection.blind.sealed, true);
  assert.equal(projection.blind.total, 1);
  assert.equal(projection.cases.length, 2);
  assert.equal(projection.unresolvedCount, projection.cases.length);
  assert.equal(projection.releaseReady, false);
  const target = projection.cases[0]!;
  const accepted = await service.review(creator.id, created.run.id, {
    action: "accept",
    caseId: target.id,
    caseDigest: target.caseDigest,
    candidateDigest: projection.candidateDigest,
    expectedVersion: projection.version
  }, "review-accept-1");
  assert.equal(accepted.review.cases.find((item) => item.id === target.id)?.status, "accepted");
  assert.equal(accepted.review.unresolvedCount, projection.cases.length - 1);
  const replay = await service.review(creator.id, created.run.id, {
    action: "accept",
    caseId: target.id,
    caseDigest: target.caseDigest,
    candidateDigest: projection.candidateDigest,
    expectedVersion: projection.version
  }, "review-accept-1");
  assert.equal(replay.review.cases.find((item) => item.id === target.id)?.status, "accepted");
  const correctionTarget = projection.cases.find((item) => item.id !== target.id)!;
  const corrected = await service.review(creator.id, created.run.id, {
    action: "correct",
    caseId: correctionTarget.id,
    caseDigest: correctionTarget.caseDigest,
    candidateDigest: projection.candidateDigest,
    expectedVersion: projection.version,
    correction: "Return one finished recommendation.",
    why: "The result must be decisive and directly usable."
  }, "review-correction-1");
  assert.equal(corrected.nextRun, undefined);
  assert.equal(corrected.review.correctionCount, 1);
  assert.equal(corrected.review.rerunReady, true);
  assert.equal(corrected.review.cases.find((item) => item.id === correctionTarget.id)?.status, "correction_saved");
  const rerun = await service.review(creator.id, created.run.id, {
    action: "rerun",
    candidateDigest: projection.candidateDigest,
    expectedVersion: projection.version
  }, "review-rerun-1");
  assert.ok(rerun.nextRun?.id);
  assert.notEqual(rerun.nextRun?.revisionId, ready.revisionId);
  const nextStored = await repository.getForCreator(creator.id, rerun.nextRun!.id);
  assert.equal(nextStored?.input.reviewContext?.mode, "correction");
  assert.equal(nextStored?.input.reviewContext?.sourceRunId, created.run.id);
  await worker.workOnce();
  const correctedReady = await service.get(creator.id, rerun.nextRun!.id);
  assert.equal(correctedReady.status, "ready", correctedReady.lastError);
  assert.equal(correctedReady.candidate?.version, (ready.candidate?.version ?? 0) + 1);
  await assert.rejects(
    () => service.review(creator.id, created.run.id, {
      action: "accept",
      caseId: target.id,
      caseDigest: target.caseDigest,
      candidateDigest: "sha256:" + "0".repeat(64),
      expectedVersion: projection.version
    }, "review-stale-1"),
    (error: unknown) => error instanceof CreatorFactoryRepositoryError && error.code === "version_conflict"
  );
});

test("held-out review confirmation promotes the sealed case without restarting Creator intake", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-heldout-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const graph = new InMemoryDistillationGraphStore();
  const service = new CreatorFactoryService(repository, root, undefined, undefined, graph);
  const creator = { id: "11111111-1111-4111-8111-111111111111", name: "Blind Review Creator" };
  const product = await service.createProduct(creator.id, { name: "Blind review method", promise: "Return one finished recommendation." });
  const document = await service.createSourceDocument(creator.id, {
    productId: product.id,
    displayName: "method.md",
    mediaType: "text/markdown",
    bytes: Buffer.from("# Method\nChoose one supported recommendation.\n", "utf8")
  });
  const created = await service.create(creator, createRequest({
    productId: product.id,
    productName: product.name,
    productPromise: product.promise,
    sources: undefined,
    sourceDocumentIds: [document.id],
    config: { developmentQuestions: 2, heldoutQuestions: 2, maxCorpusRevisions: 3 }
  }), "heldout-review-run-1");
  let questionRound = 0;
  let heldoutFailureEmitted = false;
  const promptCalls: FactoryPromptCall[] = [];
  const promptRunner = async (call: FactoryPromptCall): Promise<string> => {
    promptCalls.push(call);
    if (call.purpose === "eval.generate_questions") {
      questionRound += 1;
      const count = Number(/Question count:\s*(\d+)/.exec(call.prompt)?.[1]);
      return Array.from({ length: count }, (_, index) => [
        `## Q${index + 1}`,
        "### Question",
        `Write customer result ${questionRound}-${index + 1}.`,
        "### Why this question",
        "It requires a concrete choice.",
        "### Leakage group",
        `review-group-${questionRound}-${index + 1}`
      ].join("\n")).join("\n\n");
    }
    if (call.purpose === "eval.judge_result" && call.prompt.includes("HELDOUT_FAIL") && !heldoutFailureEmitted) {
      heldoutFailureEmitted = true;
      return "## Verdict\nFAIL\n## Diagnosis\nThe sealed case exposed a missing boundary.\n## Few-shot candidate\nNone\n## Corpus reflection\nMake the boundary explicit.";
    }
    return passingPromptRunner(call);
  };
  const factory = new CreatorFactory(root, promptRunner, async (execution) => `Customer-ready result for ${execution.question}`, { model: { provider: "test", model: "heldout-review" }, graphStore: graph });
  const worker = new CreatorFactoryWorker(repository, factory, { workerId: "heldout-review-worker", leaseMs: 60_000, heartbeatMs: 0 });
  await worker.workOnce();
  const waiting = await service.get(creator.id, created.run.id);
  const heldoutIds = [...waiting.pendingQuestions]
    .map((question, index) => ({ question, index }))
    .sort((left, right) => createHash("sha256").update(`${created.run.id}:review-group-1-${left.index + 1}`).digest("hex").localeCompare(createHash("sha256").update(`${created.run.id}:review-group-1-${right.index + 1}`).digest("hex")))
    .slice(2)
    .map(({ question }) => question.id);
  assert.equal(heldoutIds.length, 2);
  await service.submitAnswers(creator.id, created.run.id, {
    expectedVersion: waiting.version,
    submissionId: "heldout-review-answer-1",
    questionBatchId: waiting.questionBatchId!,
    answers: waiting.pendingQuestions.map((question) => ({
      questionId: question.id,
      answer: question.id === heldoutIds[0] ? "HELDOUT_FAIL" : question.id === heldoutIds[1] ? "SEALED_PASS" : `Reference ${question.id}`
    }))
  });
  await worker.workOnce();
  const paused = await service.get(creator.id, created.run.id);
  assert.equal(paused.stage, "review_required");
  const review = await service.getReview(creator.id, created.run.id);
  assert.equal(review.blind.failed, 1);
  assert.equal(review.blind.needsCreatorAction, true);
  assert.equal(JSON.stringify(review).includes("HELDOUT_FAIL"), false);
  const next = await service.review(creator.id, created.run.id, {
    action: "heldout_correction",
    candidateDigest: review.candidateDigest,
    expectedVersion: review.version,
    correction: "Confirmed the sealed failure and promoted its original Creator reference.",
    why: "A sealed failure must become a known case before it can influence the next Corpus."
  }, "heldout-review-confirm-1");
  assert.ok(next.nextRun?.id);
  await worker.workOnce();
  const nextStored = await repository.getForCreator(creator.id, next.nextRun!.id);
  assert.equal(nextStored?.state?.stage, "awaiting_creator_answers");
  assert.equal(nextStored?.state?.pendingQuestionBatch?.purpose, "replacement_heldout");
  assert.equal(nextStored?.state?.replacementHeldoutNeeded, 2);
  assert.ok(nextStored?.input.reviewContext?.calibrationArtifact);
  const nextStore = new FactoryFileStore(root, next.nextRun!.id);
  const promoted = parseQaSet(await nextStore.readArtifact(nextStored!.state!.artifacts.regressionSet!));
  assert.equal(promoted.some((row) => row.answer.includes("HELDOUT_FAIL")), true);
  const replacement = await service.get(creator.id, next.nextRun!.id);
  await service.submitAnswers(creator.id, next.nextRun!.id, {
    expectedVersion: replacement.version,
    submissionId: "heldout-review-replacement-answers-1",
    questionBatchId: replacement.questionBatchId!,
    answers: replacement.pendingQuestions.map((question) => ({ questionId: question.id, answer: `Replacement reference ${question.id}` }))
  });
  await worker.workOnce();
  const replacementCompile = promptCalls.filter((call) => call.purpose === "corpus.compile").at(-1);
  assert.ok(replacementCompile);
  assert.equal(replacementCompile!.prompt.includes("SEALED_PASS"), false);
});

test("a Distillation Product keeps one Product identity across revisions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-product-product-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const graph = new InMemoryDistillationGraphStore();
  const service = new CreatorFactoryService(repository, root, undefined, undefined, graph);
  const creator = { id: "11111111-1111-4111-8111-111111111111", name: "Product Creator" };
  const product = await service.createProduct(creator.id, { name: "Stable product product", promise: "A single product identity across revisions." });
  assert.match(product.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(product.runId, product.id);
  assert.equal((await graph.derive(product.id)).runId, product.id);
  assert.deepEqual(product.briefSpec?.fields.map((field) => field.id), ["goal", "context"]);
  assert.equal(product.briefSpec?.fields[0]?.required, true);
  const document = await service.createSourceDocument(creator.id, {
    productId: product.id,
    displayName: "method.md",
    mediaType: "text/markdown",
    bytes: Buffer.from("# Method\nChoose one supported answer.\n", "utf8")
  });
  const sourceSnapshot = await service.createSourceSnapshot(creator.id, {
    productId: product.id,
    documentIds: [document.id]
  });
  const request = createRequest({
    runId: "factory_stable_product_replay",
    productId: product.id,
    productName: product.name,
    productPromise: product.promise,
    sources: undefined,
    sourceDocumentIds: undefined,
    sourceSnapshotId: sourceSnapshot.id
  });
  const first = await service.create(creator, request, "stable-product-product-1");
  const replay = await service.create(creator, request, "stable-product-product-1");
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.run.revisionId, first.run.revisionId);
  const second = await service.create(creator, { ...request, runId: "factory_stable_product_revision_2" }, "stable-product-product-2");
  assert.equal(first.run.agentId, product.id);
  assert.equal(first.run.product?.id, product.id);
  assert.equal(second.run.agentId, product.id);
  assert.equal(second.run.product?.id, product.id);
  const currentProduct = await service.getProduct(creator.id, product.id);
  assert.equal(currentProduct.id, product.id);
  assert.notEqual(first.run.revisionId, second.run.revisionId);
  await assert.rejects(
    () => service.create(creator, { ...request, product: { id: "another-product" } }, "stable-product-product-mismatch"),
    /bound to another Product/
  );
});

test("a failed graph write does not poison the next Product revision parent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-product-revision-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const graph = new InMemoryDistillationGraphStore();
  const service = new CreatorFactoryService(repository, root, undefined, undefined, graph);
  const creator = { id: "11111111-1111-4111-8111-111111111111", name: "Retry Creator" };
  const product = await service.createProduct(creator.id, { name: "Retryable product", promise: "A stable revision lineage." });
  const document = await service.createSourceDocument(creator.id, {
    productId: product.id,
    displayName: "method.md",
    mediaType: "text/markdown",
    bytes: Buffer.from("# Method\nChoose one supported answer.\n", "utf8")
  });
  const request = createRequest({ productId: product.id, productName: product.name, productPromise: product.promise, sources: undefined, sourceDocumentIds: [document.id] });

  const first = await service.create(creator, request, "revision-retry-first");
  const currentProduct = await service.getProduct(creator.id, product.id);
  assert.equal(currentProduct.latestRevisionId, first.run.revisionId);

  // Simulate a pre-fix failed attempt that advanced only the Product pointer.
  await repository.setProductRevision(creator.id, product.id, {
    runId: currentProduct.runId!,
    revisionId: "factory_stale_revision"
  });

  const second = await service.create(creator, request, "revision-retry-second");
  const finalProduct = await service.getProduct(creator.id, product.id);
  assert.equal(second.run.revisionNumber, 2);
  assert.equal(second.run.parentRevisionId, first.run.revisionId);
  assert.equal(finalProduct.latestRevisionId, second.run.revisionId);
  assert.equal((await graph.derive(product.id)).currentRevisionId, second.run.revisionId);
});

function createRequest(overrides: Partial<CreateFactoryRunRequest> = {}): CreateFactoryRunRequest {
  return {
    productName: "Decision-ready research brief",
    productPromise: "Choose one supported recommendation and return a finished brief.",
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
  if (call.purpose === "evidence.extract") return "# Product evidence\nExplicit [S1:L1].";
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
