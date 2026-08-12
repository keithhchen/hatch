import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCreatorFactoryCli } from "./creatorFactoryCli.js";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  parseQaSet,
  parseQuestions
} from "./creatorLearning/markdown.js";
import type { CreatorFactoryRepository, FactoryRunRecord } from "./creatorLearning/repository.js";
import { CreatorFactoryService } from "./creatorLearning/service.js";
import type { CreatorQuestion, FactoryPromptCall, FactoryStartInput } from "./creatorLearning/types.js";

test("active held-out stays sealed behind an empty host placeholder until PASS rematerializes the final Corpus", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-provisional-heldout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "provisional-heldout-isolation";
  const answerSentinel = "ACTIVE_HELDOUT_ANSWER_SENTINEL_8c449d";
  let pauseHeldoutOnce = true;

  const runner = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") {
      return "# Task evidence\nChoose one supported tradeoff and finish the deliverable [S1:L1].";
    }
    if (call.purpose === "eval.generate_questions") return questionSet(2);
    if (call.purpose === "corpus.compile") return corpusFixture();
    if (call.purpose === "eval.judge_result" && call.prompt.includes(answerSentinel) && pauseHeldoutOnce) {
      pauseHeldoutOnce = false;
      throw new Error(`provider echoed ${answerSentinel}`);
    }
    return passingEvaluation();
  };

  const observedHeldoutAssets: string[] = [];
  const factory = new CreatorFactory(
    root,
    runner,
    async (execution) => {
      observedHeldoutAssets.push(await readFile(path.join(execution.agentCorpusRoot, "evals/held-out.json"), "utf8"));
      return `Complete candidate result for ${execution.question}`;
    },
    { model: { provider: "test", model: "provisional-heldout" } }
  );
  const input = sampleInput(runId);
  const waiting = await factory.start(input);
  const store = new FactoryFileStore(root, runId);
  const waitingCli = await captureCliStatus(root, runId);
  assert.equal(typeof waitingCli.answerTemplate, "string");
  assert.equal(waitingCli.questionBatchId, waiting.artifacts.currentQuestionBatch?.batchId);
  assert.notEqual(waitingCli.questionBatchId, waiting.artifacts.currentQuestionBatch?.sha256);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const heldoutId = expectedHeldoutId(questions, runId, 1);

  const paused = await factory.submitCreatorAnswers(
    runId,
    answerMarkdown(questions, (question) => question.id === heldoutId ? answerSentinel : "VISIBLE_DEVELOPMENT_ANSWER"),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(paused.stage, "needs_attention");
  assert.equal(paused.retryStage, "evaluating_heldout");
  const activeHeldoutRef = paused.artifacts.heldoutRounds.at(-1)!;
  const activeHeldout = parseQaSet(await store.readArtifact(activeHeldoutRef));
  assert.equal(activeHeldout.length, 1);
  assert.equal(activeHeldout[0]!.answer, answerSentinel);

  const provisional = paused.artifacts.corpusCandidates.at(-1)!.agentCorpus!;
  const provisionalHeldoutText = await store.readArtifact(provisional.heldOut);
  const provisionalHeldout = JSON.parse(provisionalHeldoutText) as Record<string, unknown>;
  assert.deepEqual(provisionalHeldout, {
    contract_version: "1",
    evaluation_type: "held_out",
    lifecycle: "factory_host_placeholder",
    live_context_policy: "eval_only",
    cases: []
  });
  assert.notEqual(provisional.heldOut.sha256, activeHeldoutRef.sha256);
  assert.equal(observedHeldoutAssets.length > 0, true);
  for (const text of observedHeldoutAssets) assert.equal(text, provisionalHeldoutText);

  const candidateFiles = await filesUnder(path.join(store.directory, ...provisional.rootPath.split("/")));
  for (const file of candidateFiles) {
    const text = await readFile(file, "utf8");
    assert.equal(text.includes(activeHeldout[0]!.question), false, `active Question leaked to ${file}`);
    assert.equal(text.includes(answerSentinel), false, `active Creator answer leaked to ${file}`);
    assert.equal(text.includes(activeHeldoutRef.sha256), false, `active held-out digest leaked to ${file}`);
  }
  for (const file of await unsealedFilesUnder(store.directory)) {
    assert.equal((await readFile(file, "utf8")).includes(answerSentinel), false, `held-out sentinel leaked to ${file}`);
  }

  const record: FactoryRunRecord = {
    id: runId,
    creatorId: input.creator.id,
    idempotencyKey: "projection-test",
    input,
    status: "needs_attention",
    factoryStage: paused.stage,
    state: paused,
    version: 1,
    attempts: 1,
    createdAt: paused.createdAt,
    updatedAt: paused.updatedAt
  };
  const projectionRepository = {
    getForCreator: async (creatorId: string, requestedRunId: string) => (
      creatorId === record.creatorId && requestedRunId === record.id ? structuredClone(record) : undefined
    )
  } as unknown as CreatorFactoryRepository;
  const service = new CreatorFactoryService(projectionRepository, root);
  const pausedView = await service.get(input.creator.id, runId);
  assert.equal(pausedView.candidate?.corpusVerified, false);
  assert.equal(pausedView.candidate?.corpusDigest, undefined);
  assert.equal(pausedView.candidate?.reportDigest, undefined);
  assert.equal(pausedView.candidate?.regressionDigest, undefined);
  assert.equal(pausedView.candidate?.heldOutDigest, undefined);
  await assert.rejects(
    service.publishableCorpus(input.creator.id, runId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_status"
  );

  // Even internally inconsistent control-plane state must not promote the
  // host-owned provisional placeholder into a publishable release.
  const placeholderReady = structuredClone(paused);
  placeholderReady.stage = "ready";
  placeholderReady.artifacts.latestHeldoutEvaluation = {
    ...provisional.heldOut,
    sealed: true
  };
  record.status = "ready";
  record.factoryStage = "ready";
  record.state = placeholderReady;
  await assert.rejects(
    service.publishableCorpus(input.creator.id, runId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_status"
  );
  record.status = "needs_attention";
  record.factoryStage = paused.stage;
  record.state = paused;

  const pausedCli = await captureCliStatus(root, runId);
  assert.equal(Object.hasOwn(pausedCli, "corpusDigest"), false);
  assert.equal(Object.hasOwn(pausedCli, "agentCorpusRoot"), false);
  assert.equal(Object.hasOwn(pausedCli, "answerTemplate"), false);

  const ready = await factory.retry(runId);
  assert.equal(ready.stage, "ready", ready.lastError);
  const finalCorpus = ready.artifacts.corpusCandidates.at(-1)!.agentCorpus!;
  const finalHeldoutText = await store.readArtifact(finalCorpus.heldOut);
  const canonicalHeldoutText = await store.readArtifact(ready.artifacts.latestHeldoutEvaluation!);
  assert.equal(finalHeldoutText, canonicalHeldoutText);
  assert.notEqual(finalCorpus.heldOut.sha256, provisional.heldOut.sha256);
  const finalHeldout = JSON.parse(finalHeldoutText) as {
    evaluation_type: string;
    cases: Array<{
      question: string;
      creator_reference_answer: string;
      hatch_result: string;
      verdict: string;
    }>;
  };
  assert.equal(finalHeldout.evaluation_type, "held_out");
  assert.equal(finalHeldout.cases.length, 1);
  assert.equal(finalHeldout.cases[0]!.question, activeHeldout[0]!.question);
  assert.equal(finalHeldout.cases[0]!.creator_reference_answer, answerSentinel);
  assert.match(finalHeldout.cases[0]!.hatch_result, /Complete candidate result/);
  assert.equal(finalHeldout.cases[0]!.verdict, "PASS");

  record.status = "ready";
  record.factoryStage = "ready";
  record.state = ready;
  record.updatedAt = ready.updatedAt;
  const readyView = await service.get(input.creator.id, runId);
  assert.equal(readyView.candidate?.corpusVerified, true);
  assert.equal(readyView.candidate?.corpusDigest, finalCorpus.digest);
  assert.equal(readyView.candidate?.heldOutDigest, finalCorpus.heldOut.sha256);
  assert.equal(readyView.candidate?.heldOutSampleCount, 1);
  const publishable = await service.publishableCorpus(input.creator.id, runId);
  assert.equal(publishable.corpusDigest, finalCorpus.digest);
  assert.equal(
    publishable.corpusRoot,
    path.join(store.directory, ...finalCorpus.rootPath.split("/"))
  );

  const mismatchedProof = structuredClone(ready);
  mismatchedProof.artifacts.latestHeldoutEvaluation = {
    ...mismatchedProof.artifacts.latestHeldoutEvaluation!,
    sha256: `sha256:${"0".repeat(64)}`
  };
  record.state = mismatchedProof;
  await assert.rejects(
    service.publishableCorpus(input.creator.id, runId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_status"
  );
  record.state = ready;

  const failedHeldout = JSON.parse(finalHeldoutText) as { cases: Array<Record<string, unknown>> };
  failedHeldout.cases[0]!.verdict = "FAIL";
  const failedHeldoutRef = await store.writeArtifact(
    "evaluations/forged-failed-heldout.json",
    `${JSON.stringify(failedHeldout, null, 2)}\n`,
    true
  );
  const failedReady = structuredClone(ready);
  failedReady.artifacts.latestHeldoutEvaluation = failedHeldoutRef;
  failedReady.artifacts.corpusCandidates.at(-1)!.agentCorpus!.heldOut = failedHeldoutRef;
  record.state = failedReady;
  await assert.rejects(
    service.publishableCorpus(input.creator.id, runId),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_status"
  );
  record.state = ready;

  const readyCli = await captureCliStatus(root, runId);
  assert.equal(readyCli.corpusDigest, finalCorpus.digest);
  assert.equal(
    readyCli.agentCorpusRoot,
    path.join(store.directory, ...finalCorpus.rootPath.split("/"))
  );
  assert.equal(Object.hasOwn(readyCli, "answerTemplate"), false);
});

function sampleInput(runId: string): FactoryStartInput {
  return {
    runId,
    creator: { id: "creator-provisional", name: "Creator Provisional" },
    taskName: "One publishable decision",
    taskBrief: "Make one supported tradeoff and return a complete usable result.",
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Creator rule",
      content: "Choose the material constraint, make one decision, and complete the output."
    }],
    config: { developmentQuestions: 1, heldoutQuestions: 1, maxCorpusRevisions: 3 }
  };
}

function questionSet(count: number): string {
  return Array.from({ length: count }, (_, index) => [
    `## Q${index + 1}`,
    "### Question",
    `UNIQUE_ACTIVE_CASE_${index + 1}: produce the bounded deliverable.`,
    "### Why this question",
    "It tests a material tradeoff.",
    "### Leakage group",
    `provisional-scenario-${index + 1}`
  ].join("\n")).join("\n\n");
}

function corpusFixture(): string {
  return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    "Identify the material constraint, choose one supported tradeoff, and return a complete usable result.",
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "Compile the confirmed method into one bounded behavior.",
    "# Requirements traceability",
    "- Creator evidence and answers -> system / instructions/system.md: decisive finished output.",
    "# Preservation audit",
    "## Retained",
    "- system / instructions/system.md and all accepted behavior.",
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

function answerMarkdown(questions: CreatorQuestion[], answer: (question: CreatorQuestion) => string): string {
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

function expectedHeldoutId(questions: CreatorQuestion[], runId: string, developmentCount: number): string {
  return [...questions]
    .sort((left, right) => stableKey(runId, left.leakageGroup ?? left.id).localeCompare(stableKey(runId, right.leakageGroup ?? right.id)))
    .slice(developmentCount)[0]!.id;
}

function stableKey(seed: string, value: string): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

async function captureCliStatus(root: string, runId: string): Promise<Record<string, unknown>> {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCreatorFactoryCli(["status", "--run-id", runId, "--root", root]);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output) as Record<string, unknown>;
}

async function unsealedFilesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (absolute === path.join(root, "sealed")) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await walk(root);
  return output;
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  await walk(root);
  return output;
}
