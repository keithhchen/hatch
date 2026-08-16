import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import { handleCreatorFactoryHttp } from "./creatorLearning/httpApi.js";
import { deriveQuestionBatchId, issueQuestionBatch } from "./creatorLearning/questionBatch.js";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  parseCreatorAnswerQuestionBatchId,
  parseQuestions,
  renderCreatorAnswerTemplate
} from "./creatorLearning/markdown.js";
import type { CreatorQuestion, FactoryPromptCall, FactoryStartInput } from "./creatorLearning/types.js";
import type { CreatorFactoryService } from "./creatorLearning/service.js";

test("Creator answer templates carry exactly one canonical run-scoped Question batch ID", () => {
  const batchId = `qbatch_v1_${"a".repeat(64)}`;
  const questions = [{ id: "I.Q1", question: "Finish this case.", leakageGroup: "case-1" }];
  const template = renderCreatorAnswerTemplate(questions, batchId);

  assert.equal(parseCreatorAnswerQuestionBatchId(template), batchId);
  assert.throws(
    () => parseCreatorAnswerQuestionBatchId(template.replace("<!-- HATCH_CREATOR_QUESTION_BATCH", "<!-- REMOVED")),
    /exactly one run-scoped Question batch ID marker/
  );
  assert.throws(
    () => parseCreatorAnswerQuestionBatchId(`${template}\n${template}`),
    /exactly one run-scoped Question batch ID marker/
  );
  assert.throws(
    () => renderCreatorAnswerTemplate(questions, "sha256:not-canonical"),
    /canonical run-scoped Question batch ID/
  );
  assert.throws(
    () => parseCreatorAnswerQuestionBatchId(
      template.replace(
        `<!-- HATCH_CREATOR_QUESTION_BATCH_ID: ${batchId} -->`,
        `<!-- HATCH_CREATOR_QUESTION_BATCH_SHA256: sha256:${"b".repeat(64)} -->`
      )
    ),
    /exactly one run-scoped Question batch ID marker/
  );
});

test("issuing the same sealed Question artifact twice uses a fresh persisted nonce", () => {
  const artifact = {
    path: "sealed/question-batches/same.md",
    sha256: `sha256:${"c".repeat(64)}`,
    createdAt: "2026-08-12T00:00:00.000Z",
    sealed: true as const
  };
  const first = issueQuestionBatch("same-run", artifact);
  const second = issueQuestionBatch("same-run", artifact);
  assert.notEqual(first.batchNonce, second.batchNonce);
  assert.notEqual(first.batchId, second.batchId);
  assert.equal(first.batchId, deriveQuestionBatchId("same-run", artifact.sha256, first.batchNonce));
  assert.equal(second.batchId, deriveQuestionBatchId("same-run", artifact.sha256, second.batchNonce));
});

test("Creator Factory HTTP answers require question_batch_id before service dispatch", async () => {
  const response = await handleCreatorFactoryHttp({
    method: "POST",
    pathname: "/v1/creator/factory-runs/run-1/answers",
    headers: {},
    body: { answers: [{ question_id: "I.Q1", answer: "Answer" }] },
    creator: { id: "33333333-3333-4333-8333-333333333333", display_name: "Creator One" }
  }, {} as CreatorFactoryService);

  assert.equal(response?.status, 422);
  assert.match(String((response?.body as { detail?: unknown }).detail), /question_batch_id is required/);
});

test("identical Questions across runs still reject cross-run answers before any write or LLM call", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-answer-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let promptCalls = 0;
  let hatchCalls = 0;
  const factory = new CreatorFactory(
    root,
    async (call) => {
      promptCalls += 1;
      return passingRunner(call);
    },
    async (execution) => {
      hatchCalls += 1;
      return `Finished result for ${execution.question}`;
    },
    { model: { provider: "test", model: "answer-binding" } }
  );
  const waitingA = await factory.start(sampleInput("answer-binding-a", "RUN_A"));
  const waitingB = await factory.start(sampleInput("answer-binding-b", "RUN_B"));
  const storeA = new FactoryFileStore(root, waitingA.runId);
  const storeB = new FactoryFileStore(root, waitingB.runId);
  const questionsA = parseQuestions(await storeA.readArtifact(waitingA.artifacts.currentQuestionBatch!));
  const questionsB = parseQuestions(await storeB.readArtifact(waitingB.artifacts.currentQuestionBatch!));
  assert.deepEqual(questionsA.map((question) => question.id), questionsB.map((question) => question.id));
  assert.deepEqual(questionsA, questionsB, "the generated Question bytes must be identical for this replay test");
  assert.equal(
    waitingA.artifacts.currentQuestionBatch!.sha256,
    waitingB.artifacts.currentQuestionBatch!.sha256,
    "artifact SHA proves integrity only and may be identical across runs"
  );
  assert.notEqual(
    waitingA.artifacts.currentQuestionBatch!.batchId,
    waitingB.artifacts.currentQuestionBatch!.batchId,
    "fresh run-scoped IDs must differ even for byte-identical Questions"
  );
  for (const waiting of [waitingA, waitingB]) {
    const batch = waiting.artifacts.currentQuestionBatch!;
    assert.equal(
      batch.batchId,
      deriveQuestionBatchId(waiting.runId, batch.sha256, batch.batchNonce),
      "the persisted ID must bind nonce + run + artifact SHA"
    );
    const reloaded = await factory.status(waiting.runId);
    assert.equal(reloaded.artifacts.currentQuestionBatch?.batchNonce, batch.batchNonce);
    assert.equal(reloaded.artifacts.currentQuestionBatch?.batchId, batch.batchId);
  }

  const templateB = await storeB.readArtifact(waitingB.artifacts.creatorAnswerTemplate!);
  assert.equal(
    parseCreatorAnswerQuestionBatchId(templateB),
    waitingB.artifacts.currentQuestionBatch!.batchId
  );
  const staleAnswers = answerMarkdown(questionsA, (question) => `Old answer for ${question.id}`);
  const before = await directorySnapshot(storeB.directory);
  const callsBeforeRejections = { promptCalls, hatchCalls };

  await assert.rejects(
    () => factory.submitCreatorAnswers(waitingB.runId, staleAnswers, ""),
    /require the run-scoped Question batch ID/
  );
  assert.deepEqual(await directorySnapshot(storeB.directory), before);

  await assert.rejects(
    () => factory.submitCreatorAnswers(
      waitingB.runId,
      staleAnswers,
      waitingA.artifacts.currentQuestionBatch!.batchId
    ),
    /stale or unknown Question batch/
  );
  assert.deepEqual(await directorySnapshot(storeB.directory), before);
  assert.deepEqual({ promptCalls, hatchCalls }, callsBeforeRejections, "cross-run rejection must execute no model");

  await assert.rejects(
    () => factory.submitCreatorAnswers(
      waitingB.runId,
      staleAnswers,
      `sha256:${"f".repeat(64)}`
    ),
    /stale or unknown Question batch/
  );
  assert.deepEqual(await directorySnapshot(storeB.directory), before);
  assert.deepEqual({ promptCalls, hatchCalls }, callsBeforeRejections);

  const legacyState = await storeA.loadState();
  const legacyBatch = legacyState.artifacts.currentQuestionBatch as unknown as {
    batchId?: string;
    batchNonce?: string;
  };
  delete legacyBatch.batchId;
  delete legacyBatch.batchNonce;
  await storeA.saveState(legacyState);
  const legacyBefore = await directorySnapshot(storeA.directory);
  const callsBeforeLegacyRejection = { promptCalls, hatchCalls };
  await assert.rejects(
    () => factory.submitCreatorAnswers(
      waitingA.runId,
      staleAnswers,
      waitingA.artifacts.currentQuestionBatch!.batchId
    ),
    /no valid run-scoped Question batch binding/
  );
  assert.deepEqual(await directorySnapshot(storeA.directory), legacyBefore);
  assert.deepEqual({ promptCalls, hatchCalls }, callsBeforeLegacyRejection);

  const ready = await factory.submitCreatorAnswers(
    waitingB.runId,
    answerMarkdown(questionsB, (question) => `Current answer for ${question.id}`),
    waitingB.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(ready.stage, "ready", ready.lastError);
});

test("Factory start owns a fresh run directory exclusively, including partial and concurrent starts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-exclusive-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let promptCalls = 0;
  const factory = new CreatorFactory(
    root,
    async (call) => {
      promptCalls += 1;
      return passingRunner(call);
    },
    async () => "unused",
    { model: { provider: "test", model: "exclusive-start" } }
  );

  const input = sampleInput("exclusive-existing", "EXISTING");
  const waiting = await factory.start(input);
  assert.equal(waiting.stage, "awaiting_creator_answers");
  const callsAfterFirstStart = promptCalls;
  const existingSnapshot = await directorySnapshot(path.join(root, input.runId!));
  await assert.rejects(() => factory.start(input), /already exists; refusing to overwrite/);
  assert.equal(promptCalls, callsAfterFirstStart, "duplicate start must not reach an LLM");
  assert.deepEqual(await directorySnapshot(path.join(root, input.runId!)), existingSnapshot);

  const partialRunId = "exclusive-partial";
  const partialDirectory = path.join(root, partialRunId);
  await mkdir(partialDirectory);
  await writeFile(path.join(partialDirectory, "recovery-sentinel.txt"), "do not overwrite\n", "utf8");
  const partialSnapshot = await directorySnapshot(partialDirectory);
  await assert.rejects(
    () => factory.start(sampleInput(partialRunId, "PARTIAL")),
    /already exists; refusing to overwrite/
  );
  assert.equal(promptCalls, callsAfterFirstStart, "partial-run rejection must not reach an LLM");
  assert.deepEqual(await directorySnapshot(partialDirectory), partialSnapshot);

  const racingInput = sampleInput("exclusive-race", "RACE");
  const racing = await Promise.allSettled([factory.start(racingInput), factory.start(racingInput)]);
  assert.equal(racing.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = racing.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok(rejection);
  assert.match(String(rejection.reason), /already exists; refusing to overwrite/);
  assert.equal(promptCalls, callsAfterFirstStart + 2, "only the winning start may run Evidence and Question nodes");
});

async function passingRunner(call: FactoryPromptCall): Promise<string> {
  if (call.purpose === "evidence.extract") {
    return "# Product evidence\nChoose one supported tradeoff and finish the deliverable [S1:L1].";
  }
  if (call.purpose === "eval.generate_questions") {
    const count = call.outputContract?.kind === "question_set" ? call.outputContract.expectedCount : 2;
    return Array.from({ length: count }, (_, index) => [
      `## Q${index + 1}`,
      "### Question",
      `Shared case ${index + 1}: produce the bounded deliverable.`,
      "### Why this question",
      "It tests a material tradeoff.",
      "### Leakage group",
      `shared-scenario-${index + 1}`
    ].join("\n")).join("\n\n");
  }
  if (call.purpose === "corpus.compile") return corpusFixture();
  return passingEvaluation();
}

function sampleInput(runId: string, flavor: string): FactoryStartInput {
  return {
    runId,
    creator: { id: "11111111-1111-4111-8111-111111111111", name: "Creator Binding" },
    productName: `One publishable decision ${flavor}`,
    productPromise: `${flavor}: make one supported tradeoff and return a complete usable result.`,
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Creator rule",
      content: "Use supported facts, choose the material constraint, and complete the output."
    }],
    config: { developmentQuestions: 1, heldoutQuestions: 1, maxCorpusRevisions: 3 }
  };
}

function answerMarkdown(
  questions: CreatorQuestion[],
  answer: (question: CreatorQuestion) => string
): string {
  return [
    "# Creator answers",
    ...questions.flatMap((question) => [
      `## ${question.id}`,
      "### Question",
      question.question,
      "### Creator Answer",
      answer(question)
    ])
  ].join("\n");
}

function corpusFixture(): string {
  return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    "Identify the material constraint, make one justified choice, and return a complete usable result.",
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "Compile the confirmed method into one bounded behavior.",
    "# Requirements traceability",
    "- Creator evidence and answers -> system / instructions/system.md.",
    "# Preservation audit",
    "## Retained",
    "- system / instructions/system.md and every accepted behavior.",
    "## Added or changed",
    "- The supported tradeoff rule is explicit.",
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

function passingEvaluation(): string {
  return [
    "## Verdict",
    "PASS",
    "## Diagnosis",
    "The result is complete and aligned.",
    "## Few-shot candidate",
    "None.",
    "## Corpus reflection",
    "No change."
  ].join("\n");
}

async function directorySnapshot(root: string): Promise<Array<[string, string]>> {
  const rows: Array<[string, string]> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        rows.push([`${path.relative(root, absolute)}/`, "<directory>"]);
        await visit(absolute);
      }
      else if (entry.isFile()) rows.push([path.relative(root, absolute), await readFile(absolute, "utf8")]);
    }
  };
  await visit(root);
  return rows;
}
