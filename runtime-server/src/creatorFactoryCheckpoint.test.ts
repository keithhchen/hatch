import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  parseQuestions
} from "./creatorLearning/markdown.js";
import type { CreatorQuestion, FactoryPromptCall, FactoryStartInput } from "./creatorLearning/types.js";

test("retry after the fourth Hatch failure reuses the first three completed Hatch+Eval pairs", async (t) => {
  const root = await temporaryRoot(t, "fourth-hatch");
  const script = new CheckpointScript({ failHatchAt: 4, failSecondCorpus: true });
  const factory = script.factory(root);
  const waiting = await factory.start(sampleInput("checkpoint-fourth-hatch", 4, 1));
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));

  const failed = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(failed.stage, "needs_attention");
  assert.equal(failed.retryStage, "evaluating_development");
  assert.equal(failed.activeQaEvaluation?.cases.filter((row) => row.evaluation).length, 3);
  const firstThree = script.hatchCalls.slice(0, 3);
  const fourth = script.hatchCalls[3]!;

  const stoppedAfterDevelopment = await factory.retry(waiting.runId);
  assert.equal(stoppedAfterDevelopment.stage, "needs_attention");
  assert.equal(stoppedAfterDevelopment.retryStage, "compiling_corpus");
  for (const marker of firstThree) {
    assert.equal(count(script.hatchCalls, marker), 1, `Hatch replayed ${marker}`);
    assert.equal(count(script.evalCalls, marker), 1, `Eval replayed ${marker}`);
  }
  assert.equal(count(script.hatchCalls, fourth), 2);
  assert.equal(count(script.evalCalls, fourth), 1);
  assert.equal(stoppedAfterDevelopment.activeQaEvaluation, undefined);
});

test("retry after Eval failure reuses Hatch and executes only the missing Eval phase", async (t) => {
  const root = await temporaryRoot(t, "eval-only");
  const script = new CheckpointScript({ failEvalAt: 1, failSecondCorpus: true });
  const factory = script.factory(root);
  const waiting = await factory.start(sampleInput("checkpoint-eval-only", 2, 1));
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));

  const failed = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(failed.stage, "needs_attention");
  const marker = script.hatchCalls[0]!;
  assert.equal(failed.activeQaEvaluation?.cases[0]?.hatchResult !== undefined, true);
  assert.equal(failed.activeQaEvaluation?.cases[0]?.evaluation, undefined);

  await factory.retry(waiting.runId);
  assert.equal(count(script.hatchCalls, marker), 1);
  assert.equal(count(script.evalCalls, marker), 2);
});

test("cross-Corpus scope binding is never reused", async (t) => {
  const root = await temporaryRoot(t, "cross-corpus");
  const script = new CheckpointScript({ failHatchAt: 2, failSecondCorpus: true });
  const factory = script.factory(root);
  const waiting = await factory.start(sampleInput("checkpoint-cross-corpus", 2, 1));
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const failed = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(failed.stage, "needs_attention");
  const completedMarker = script.hatchCalls[0]!;

  const tampered = await store.loadState();
  assert.ok(tampered.activeQaEvaluation);
  tampered.activeQaEvaluation.corpusVersion += 100;
  tampered.activeQaEvaluation.corpusDigest = `sha256:${"0".repeat(64)}`;
  await store.saveState(tampered);

  await factory.retry(waiting.runId);
  assert.equal(count(script.hatchCalls, completedMarker), 2, "old-Corpus Hatch result was reused");
  assert.equal(count(script.evalCalls, completedMarker), 2, "old-Corpus Eval result was reused");
});

test("a physically tampered referenced checkpoint fails closed", async (t) => {
  const root = await temporaryRoot(t, "tamper");
  const script = new CheckpointScript({ failEvalAt: 1 });
  const factory = script.factory(root);
  const waiting = await factory.start(sampleInput("checkpoint-tamper", 2, 1));
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const failed = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  const hatchReference = failed.activeQaEvaluation?.cases[0]?.hatchResult;
  assert.ok(hatchReference);
  const hatchCallsBeforeRetry = script.hatchCalls.length;
  const evalCallsBeforeRetry = script.evalCalls.length;

  await writeFile(path.join(store.directory, ...hatchReference.path.split("/")), "tampered\n", "utf8");
  const rejected = await factory.retry(waiting.runId);
  assert.equal(rejected.stage, "needs_attention");
  assert.match(rejected.lastError ?? "", /Artifact digest mismatch/);
  assert.equal(script.hatchCalls.length, hatchCallsBeforeRetry);
  assert.equal(script.evalCalls.length, evalCallsBeforeRetry);
});

test("held-out Hatch and Eval checkpoints remain sealed while state contains no held-out content", async (t) => {
  const root = await temporaryRoot(t, "heldout-seal");
  const heldoutSentinel = "HELDOUT_REFERENCE_9d609b3f_MUST_REMAIN_SEALED";
  const script = new CheckpointScript({ heldoutEvalSentinel: heldoutSentinel });
  const factory = script.factory(root);
  const runId = "checkpoint-heldout-seal";
  const waiting = await factory.start(sampleInput(runId, 2, 1));
  const store = new FactoryFileStore(root, runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const heldoutId = expectedHeldoutId(questions, runId, 2);

  const paused = await factory.submitCreatorAnswers(
    runId,
    answerMarkdown(questions, (question) => question.id === heldoutId ? heldoutSentinel : `DEV_ANSWER_${question.id}`),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(paused.stage, "needs_attention");
  assert.equal(paused.retryStage, "evaluating_heldout");
  assert.equal(paused.activeQaEvaluation?.sealed, true);
  assert.equal(JSON.stringify(paused.activeQaEvaluation).includes(heldoutSentinel), false);
  assert.equal((await readFile(store.statePath, "utf8")).includes(heldoutSentinel), false);
  const activeHatch = paused.activeQaEvaluation?.cases[0]?.hatchResult;
  assert.ok(activeHatch?.sealed);
  assert.match(activeHatch.path, /^sealed\/checkpoints\/heldout-1\//);

  script.pauseHeldoutEval = false;
  const ready = await factory.retry(runId);
  assert.equal(ready.stage, "ready", ready.lastError);
  assert.equal(ready.activeQaEvaluation, undefined);
  assert.equal((await readFile(store.statePath, "utf8")).includes(heldoutSentinel), false);

  const sealedFiles = (await filesUnder(path.join(store.directory, "sealed", "checkpoints", "heldout-1")))
    .filter((file) => file.endsWith(".json"));
  assert.equal(sealedFiles.length, 2);
  const kinds = new Set(await Promise.all(sealedFiles.map(async (file) => (
    JSON.parse(await readFile(file, "utf8")) as { kind: string }
  ).kind)));
  assert.deepEqual(kinds, new Set(["hatch_candidate_result", "eval_result"]));
  const unsealedHeldoutDirectory = path.join(store.directory, "artifacts", "checkpoints", "heldout-1");
  await assert.rejects(readdir(unsealedHeldoutDirectory), /ENOENT/);
  assert.equal(count(script.hatchCalls, markerForQuestion(questions.find((row) => row.id === heldoutId)!.question)), 1);
  assert.equal(script.evalCalls.filter((marker) => marker === markerForQuestion(
    questions.find((row) => row.id === heldoutId)!.question
  )).length, 2);
});

test("an orphan Hatch artifact without a committed state reference is ignored", async (t) => {
  const root = await temporaryRoot(t, "orphan");
  const script = new CheckpointScript({ failEvalAt: 1, failSecondCorpus: true });
  const factory = script.factory(root);
  const waiting = await factory.start(sampleInput("checkpoint-orphan", 2, 1));
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const failed = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  const marker = script.hatchCalls[0]!;
  const persisted = await store.loadState();
  const orphan = persisted.activeQaEvaluation?.cases[0]?.hatchResult;
  assert.ok(orphan);

  // This is the durable shape of a crash after artifact rename but before the
  // following state.json commit: the immutable file exists, but no state ref.
  persisted.activeQaEvaluation!.cases[0]!.hatchResult = undefined;
  persisted.activeQaEvaluation!.cases[0]!.evaluation = undefined;
  await store.saveState(persisted);
  assert.equal((await readFile(path.join(store.directory, ...orphan.path.split("/")), "utf8")).length > 0, true);

  await factory.retry(waiting.runId);
  assert.equal(count(script.hatchCalls, marker), 2, "orphan artifact was discovered or reused");
  assert.equal(count(script.evalCalls, marker), 2);
});

type ScriptOptions = {
  failHatchAt?: number;
  failEvalAt?: number;
  failSecondCorpus?: boolean;
  heldoutEvalSentinel?: string;
};

class CheckpointScript {
  readonly hatchCalls: string[] = [];
  readonly evalCalls: string[] = [];
  pauseHeldoutEval = true;
  private corpusCalls = 0;
  private hatchFailureEmitted = false;
  private evalFailureEmitted = false;

  constructor(private readonly options: ScriptOptions) {}

  factory(root: string): CreatorFactory {
    return new CreatorFactory(root, this.runPrompt, this.executeCandidate, {
      model: { provider: "test", model: "checkpoint-script" }
    });
  }

  readonly runPrompt = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") {
      return "# Evidence\nMake one bounded decision from supported facts [S1:L1].";
    }
    if (call.purpose === "eval.generate_questions") {
      const total = Number(/Question count:\s*(\d+)/.exec(call.prompt)?.[1]);
      return questionSet(total);
    }
    if (call.purpose === "corpus.compile") {
      this.corpusCalls += 1;
      if (this.options.failSecondCorpus && this.corpusCalls === 2) {
        throw new Error("intentional stop after QA checkpoint assertions");
      }
      return corpusFixture();
    }
    if (call.purpose === "eval.audit_corpus") return passingEvaluation();
    if (call.purpose === "eval.judge_result") {
      const marker = markerForPrompt(call.prompt);
      this.evalCalls.push(marker);
      if (
        this.options.failEvalAt === this.evalCalls.length
        && !this.evalFailureEmitted
      ) {
        this.evalFailureEmitted = true;
        throw new Error("intentional Eval outage");
      }
      if (
        this.options.heldoutEvalSentinel
        && call.prompt.includes(this.options.heldoutEvalSentinel)
        && this.pauseHeldoutEval
      ) {
        throw new Error(`intentional held-out Eval pause echoed ${this.options.heldoutEvalSentinel}`);
      }
      return passingEvaluation();
    }
    throw new Error(`Unexpected Factory call: ${call.purpose}`);
  };

  readonly executeCandidate = async (execution: { question: string }): Promise<string> => {
    const marker = markerForQuestion(execution.question);
    this.hatchCalls.push(marker);
    if (
      this.options.failHatchAt === this.hatchCalls.length
      && !this.hatchFailureEmitted
    ) {
      this.hatchFailureEmitted = true;
      throw new Error("intentional Hatch outage");
    }
    return `HATCH_OUTPUT_${marker}`;
  };
}

function sampleInput(runId: string, developmentQuestions: number, heldoutQuestions: number): FactoryStartInput {
  return {
    runId,
    creator: { id: "11111111-1111-4111-8111-111111111111", name: "Creator Checkpoint" },
    taskName: "Checkpointed bounded deliverable",
    taskBrief: "Choose the material tradeoff and return a finished result.",
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Creator decision rule",
      content: "Use supported facts, choose one material tradeoff, and finish the deliverable."
    }],
    config: { developmentQuestions, heldoutQuestions, maxCorpusRevisions: 3 }
  };
}

function questionSet(count: number): string {
  return Array.from({ length: count }, (_, index) => [
    `## Q${index + 1}`,
    "### Question",
    `Produce the bounded deliverable for CASE_${index + 1}.`,
    "### Why this question",
    "It requires one consequential tradeoff.",
    "### Leakage group",
    `checkpoint-scenario-${index + 1}`
  ].join("\n")).join("\n\n");
}

function corpusFixture(): string {
  return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    "Identify the material decision from supported facts, expose the consequential tradeoff, choose one direction, and return a complete usable deliverable with a practical next step.",
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "Compile the confirmed bounded decision method.",
    "# Requirements traceability",
    "- Creator evidence and QA -> system / instructions/system.md: decisive finished output.",
    "# Preservation audit",
    "## Retained",
    "- system / instructions/system.md and all accepted behavior.",
    "## Added or changed",
    "- The bounded decision method is explicit.",
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
    "The result follows the confirmed method.",
    "## Few-shot candidate",
    "None.",
    "## Corpus reflection",
    "No change required."
  ].join("\n");
}

function answerMarkdown(
  questions: CreatorQuestion[],
  answer: (question: CreatorQuestion) => string = (question) => `CREATOR_ANSWER_${question.id}`
): string {
  return [
    "# Creator answers",
    "",
    ...questions.flatMap((question) => [
      `## ${question.id}`,
      "",
      "### Question",
      question.question,
      "",
      "### Creator Answer",
      answer(question),
      ""
    ])
  ].join("\n");
}

function markerForPrompt(prompt: string): string {
  const match = /CASE_(\d+)/.exec(prompt);
  if (!match) throw new Error("Eval prompt has no case marker");
  return `CASE_${match[1]}`;
}

function markerForQuestion(question: string): string {
  const match = /CASE_(\d+)/.exec(question);
  if (!match) throw new Error("Question has no case marker");
  return `CASE_${match[1]}`;
}

function count(rows: string[], value: string): number {
  return rows.filter((row) => row === value).length;
}

function expectedHeldoutId(questions: CreatorQuestion[], runId: string, developmentCount: number): string {
  return [...questions]
    .sort((left, right) => stableKey(runId, left.leakageGroup ?? left.id).localeCompare(
      stableKey(runId, right.leakageGroup ?? right.id)
    ))
    .slice(developmentCount)[0]!.id;
}

function stableKey(seed: string, value: string): string {
  return createHash("sha256").update(`${seed}:${value}`).digest("hex");
}

async function temporaryRoot(t: TestContext, label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `hatch-checkpoint-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(absolute));
    else if (entry.isFile()) output.push(absolute);
  }
  return output;
}
