import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCreatorFactoryCli, timingReport } from "./creatorFactoryCli.js";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  parseQuestions
} from "./creatorLearning/markdown.js";
import type {
  CreatorQuestion,
  FactoryPromptFailureTelemetry,
  FactoryPromptCall,
  FactoryStartInput
} from "./creatorLearning/types.js";

test("execution sidecars preserve running power-loss state and explicit aborted settlement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-timing-running-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const store = new FactoryFileStore(root, "timing-running", undefined, controller.signal);
  await store.initialize();

  const interrupted = await store.beginExecution({
    startedAt: "2030-01-01T00:00:00.000Z",
    sealed: false,
    metadata: factoryMetadata("evidence.extract")
  });
  let rows = await store.listExecutionTimings();
  assert.deepEqual(rows, [interrupted]);
  assert.equal(rows[0]!.completedAt, undefined);
  assert.equal(rows[0]!.elapsedMs, undefined);

  const cancelled = await store.beginExecution({
    startedAt: "2030-01-01T00:00:01.000Z",
    sealed: true,
    metadata: factoryMetadata("eval.judge_result")
  });
  controller.abort(new Error("operator cancelled"));
  await store.settleExecution(cancelled, {
    status: "aborted",
    completedAt: "2030-01-01T00:00:02.000Z",
    elapsedMs: 17.5
  });

  rows = await store.listExecutionTimings();
  assert.equal(rows.find((row) => row.executionId === interrupted.executionId)?.status, "running");
  assert.equal(rows.find((row) => row.executionId === cancelled.executionId)?.status, "aborted");
  assert.equal(rows.find((row) => row.executionId === cancelled.executionId)?.sealed, true);
});

test("CLI recovery marks process-loss timings abandoned without inventing elapsed time", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-timing-abandoned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FactoryFileStore(root, "timing-abandoned");
  await store.initialize();
  await store.beginExecution({
    startedAt: "2030-01-01T00:00:00.000Z",
    sealed: false,
    metadata: factoryMetadata("corpus.compile")
  });

  assert.equal(await store.abandonRunningExecutions("2030-01-01T00:01:00.000Z"), 1);
  assert.equal(await store.abandonRunningExecutions("2030-01-01T00:02:00.000Z"), 0);
  const [row] = await store.listExecutionTimings();
  assert.equal(row?.status, "abandoned");
  assert.equal(row?.completedAt, "2030-01-01T00:01:00.000Z");
  assert.equal(row?.elapsedMs, undefined);

  const report = timingReport(store.runId, store.directory, [row!]);
  assert.equal(report.summary.abandoned, 1);
  assert.equal(report.summary.running, 0);
  assert.equal(report.summary.settledElapsedMs, 0);
});

test("failed LLM retry gets a unique sidecar and elapsed uses monotonic time across wall-clock rollback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-timing-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rawErrorSentinel = "RAW_PROVIDER_ERROR_MUST_NOT_ENTER_TIMING";
  let evidenceAttempts = 0;
  const wallTimes = [
    "2030-01-01T00:00:10.000Z",
    "2030-01-01T00:00:05.000Z",
    "2030-01-01T00:00:20.000Z",
    "2030-01-01T00:00:15.000Z",
    "2030-01-01T00:00:30.000Z",
    "2030-01-01T00:00:25.000Z"
  ].map((value) => new Date(value));
  const monotonicTimes = [100, 125, 200, 260, 300, 390];
  const factory = new CreatorFactory(
    root,
    async (call) => {
      if (call.purpose === "evidence.extract") {
        evidenceAttempts += 1;
        if (evidenceAttempts === 1) {
          call.reportFailureTelemetry?.({
            contractVersion: "1",
            code: "provider_error",
            turnsObserved: 0,
            toolTurnsObserved: 0,
            toolCallsRequested: 0,
            toolResultsObserved: 0,
            toolErrorsObserved: 0
          });
          throw new Error(rawErrorSentinel);
        }
        return "# Evidence\nA bounded decision rule is supported by [S1:L1].";
      }
      if (call.purpose === "eval.generate_questions") return questionSet(2);
      throw new Error(`Unexpected call ${call.purpose}`);
    },
    async () => "unused",
    {
      model: { provider: "test", model: "clock-test" },
      timingClock: {
        wallNow: () => wallTimes.shift() ?? new Date("2030-01-01T00:01:00.000Z"),
        monotonicNow: () => monotonicTimes.shift() ?? 999
      }
    }
  );

  const failed = await factory.start(sampleInput("timing-retry"));
  assert.equal(failed.stage, "needs_attention");
  const waiting = await factory.retry(failed.runId);
  assert.equal(waiting.stage, "awaiting_creator_answers");

  const store = new FactoryFileStore(root, failed.runId);
  const rows = await store.listExecutionTimings();
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.executionId)).size, 3);
  const evidence = rows.filter((row) => row.metadata.purpose === "evidence.extract");
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((row) => row.status).sort(), ["completed", "failed"]);
  assert.equal(evidence.find((row) => row.status === "failed")?.failureTelemetry?.code, "provider_error");
  assert.equal(evidence.find((row) => row.status === "completed")?.failureTelemetry, undefined);
  assert.deepEqual(rows.map((row) => row.elapsedMs).sort((a, b) => a! - b!), [25, 60, 90]);
  for (const row of rows) {
    assert.ok(row.completedAt! < row.startedAt, "wall clock intentionally moved backwards");
  }
  const rawSidecars = await executionSidecarText(store.directory);
  assert.equal(rawSidecars.includes(rawErrorSentinel), false);
});

test("execution sidecars accept only bounded content-free failure telemetry", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-timing-telemetry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FactoryFileStore(root, "timing-telemetry");
  await store.initialize();
  const validTelemetry: FactoryPromptFailureTelemetry = {
    contractVersion: "1" as const,
    code: "exact_submission_cycle" as const,
    turnsObserved: 2,
    toolTurnsObserved: 2,
    toolCallsRequested: 4,
    toolResultsObserved: 4,
    toolErrorsObserved: 0,
    exactCycleKind: "repeated_final_validation" as const,
    lastToolTurn: {
      callsRequested: 2,
      results: 2,
      errors: 0,
      accepted: 1,
      idempotent: 0,
      rejected: 1,
      toolNames: ["submit_question", "finalize_questions"],
      finalizerOutcome: "rejected" as const,
      finalizerPosition: "last" as const,
      transaction: "cleared" as const
    }
  };

  const valid = await store.beginExecution({
    startedAt: "2030-01-01T00:00:00.000Z",
    sealed: false,
    metadata: factoryMetadata("evidence.extract")
  });
  await store.settleExecution(valid, {
    status: "failed",
    completedAt: "2030-01-01T00:00:01.000Z",
    elapsedMs: 1,
    failureTelemetry: validTelemetry
  });

  const extraField = await store.beginExecution({
    startedAt: "2030-01-01T00:00:02.000Z",
    sealed: false,
    metadata: factoryMetadata("evidence.extract")
  });
  await assert.rejects(() => store.settleExecution(extraField, {
    status: "failed",
    completedAt: "2030-01-01T00:00:03.000Z",
    elapsedMs: 1,
    failureTelemetry: { ...validTelemetry, rawError: "MUST_NOT_PERSIST" } as never
  }), /failure telemetry envelope/);

  const completed = await store.beginExecution({
    startedAt: "2030-01-01T00:00:04.000Z",
    sealed: false,
    metadata: factoryMetadata("evidence.extract")
  });
  await assert.rejects(() => store.settleExecution(completed, {
    status: "completed",
    completedAt: "2030-01-01T00:00:05.000Z",
    elapsedMs: 1,
    failureTelemetry: validTelemetry
  }), /only valid for failed\/aborted Factory LLM/);

  const hatch = await store.beginExecution({
    startedAt: "2030-01-01T00:00:06.000Z",
    sealed: false,
    metadata: {
      boundary: "hatch_product_runtime",
      purpose: "hatch.candidate",
      corpusVersion: 1,
      corpusDigest: "sha256:placeholder"
    }
  });
  await assert.rejects(() => store.settleExecution(hatch, {
    status: "failed",
    completedAt: "2030-01-01T00:00:07.000Z",
    elapsedMs: 1,
    failureTelemetry: validTelemetry
  }), /only valid for failed\/aborted Factory LLM/);

  const sidecars = await executionSidecarText(store.directory);
  assert.equal(sidecars.includes("MUST_NOT_PERSIST"), false);
  assert.match(sidecars, /"exactCycleKind": "repeated_final_validation"/);
});

test("every Factory LLM/Hatch call is timed and held-out sentinel stays out of sealed timing metadata and CLI JSON", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-timing-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "timing-heldout-e2e";
  const heldoutSentinel = "HELDOUT_SECRET_6d1ce818_DO_NOT_LEAK";
  const hatchErrorSentinel = "RAW_HATCH_ERROR_MUST_NOT_ENTER_TIMING";
  let hatchAttempts = 0;
  const runner = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") return "# Evidence\nChoose one material decision [S1:L1].";
    if (call.purpose === "eval.generate_questions") return questionSet(2);
    if (call.purpose === "corpus.compile") return corpusFixture();
    return passingEvaluation();
  };
  const factory = new CreatorFactory(
    root,
    runner,
    async (execution) => {
      hatchAttempts += 1;
      if (hatchAttempts === 1) throw new Error(hatchErrorSentinel);
      return `Finished candidate result for ${execution.question}`;
    },
    { model: { provider: "test", model: "timing-e2e" } }
  );
  const waiting = await factory.start(sampleInput(runId));
  const store = new FactoryFileStore(root, runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const heldoutId = expectedHeldoutId(questions, runId, 1);
  const firstAttempt = await factory.submitCreatorAnswers(
    runId,
    answerMarkdown(questions, (question) => question.id === heldoutId ? heldoutSentinel : "VISIBLE_DEVELOPMENT_ANSWER"),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(firstAttempt.stage, "needs_attention");
  assert.equal(firstAttempt.retryStage, "evaluating_development");
  const ready = await factory.retry(runId);
  assert.equal(ready.stage, "ready", ready.lastError);

  const rows = await store.listExecutionTimings();
  const purposes = new Set(rows.map((row) => row.metadata.purpose));
  assert.deepEqual(purposes, new Set([
    "evidence.extract",
    "eval.generate_questions",
    "corpus.compile",
    "eval.audit_corpus",
    "hatch.candidate",
    "eval.judge_result"
  ]));
  assert.equal(rows.filter((row) => row.status === "failed").length, 1);
  assert.equal(rows.every((row) => row.status === "completed" || row.status === "failed"), true);
  assert.equal(rows.every((row) => row.completedAt !== undefined && row.elapsedMs !== undefined), true);
  const hatchRows = rows.filter((row) => row.metadata.purpose === "hatch.candidate");
  assert.equal(hatchRows.filter((row) => row.status === "failed").length, 1);
  assert.equal(new Set(hatchRows.map((row) => row.executionId)).size, hatchRows.length);
  assert.equal(rows.some((row) => row.sealed && row.metadata.purpose === "hatch.candidate"), true);
  assert.equal(rows.some((row) => row.sealed && row.metadata.purpose === "eval.judge_result"), true);

  const rawSidecars = await executionSidecarText(store.directory);
  assert.equal(rawSidecars.includes(heldoutSentinel), false);
  assert.equal(rawSidecars.includes(hatchErrorSentinel), false);
  assert.equal(rawSidecars.includes("VISIBLE_DEVELOPMENT_ANSWER"), false);
  assert.equal(rawSidecars.includes("Finished candidate result"), false);

  let cliOutput = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    cliOutput += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await runCreatorFactoryCli(["timings", "--run-id", runId, "--root", root, "--json"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const report = JSON.parse(cliOutput) as {
    summary: { attempts: number; byNode: Array<{ node: string }> };
    executions: Array<{ executionId: string }>;
  };
  assert.equal(report.summary.attempts, rows.length);
  assert.equal(report.executions.length, rows.length);
  assert.equal(report.summary.byNode.some((row) => row.node === "hatch.candidate"), true);
  assert.equal(cliOutput.includes(heldoutSentinel), false);
});

function factoryMetadata(purpose: "evidence.extract" | "eval.judge_result" | "corpus.compile") {
  return {
    boundary: "factory_llm" as const,
    purpose,
    promptVersion: "test-v1",
    provider: "test",
    model: "test"
  };
}

function sampleInput(runId: string): FactoryStartInput {
  return {
    runId,
    creator: { id: "11111111-1111-4111-8111-111111111111", name: "Creator Timing" },
    taskName: "One bounded deliverable",
    taskBrief: "Make one material choice and return a usable result.",
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Creator rule",
      content: "Use supported facts to make one material decision."
    }],
    config: { developmentQuestions: 1, heldoutQuestions: 1, maxCorpusRevisions: 3 }
  };
}

function questionSet(count: number): string {
  return Array.from({ length: count }, (_, index) => [
    `## Q${index + 1}`,
    "### Question",
    `Produce the bounded deliverable for case ${index + 1}.`,
    "### Why this question",
    "It tests a material choice.",
    "### Leakage group",
    `timing-scenario-${index + 1}`
  ].join("\n")).join("\n\n");
}

function corpusFixture(): string {
  return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    "Identify the material decision from supported facts, make an explicit tradeoff, and return a complete usable result with a practical next step.",
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "Compile the confirmed decision method into the System asset.",
    "# Requirements traceability",
    "- Creator evidence and answers -> system / instructions/system.md: decisive finished output.",
    "# Preservation audit",
    "## Retained",
    "- system / instructions/system.md and all accepted behavior.",
    "## Added or changed",
    "- The confirmed decision method is explicit.",
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
    "The complete result follows the confirmed method.",
    "## Few-shot candidate",
    "None.",
    "## Corpus reflection",
    "No change required."
  ].join("\n");
}

function answerMarkdown(questions: CreatorQuestion[], answer: (question: CreatorQuestion) => string): string {
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

async function executionSidecarText(runDirectory: string): Promise<string> {
  const namespaces = ["artifacts", "sealed"];
  const contents: string[] = [];
  for (const namespace of namespaces) {
    const directory = path.join(runDirectory, namespace, "executions");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) contents.push(await readFile(path.join(directory, name), "utf8"));
  }
  return contents.join("\n");
}
