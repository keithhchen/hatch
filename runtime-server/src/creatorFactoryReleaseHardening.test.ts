import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
import type {
  CreatorQuestion,
  FactoryPromptCall,
  FactoryRunState,
  FactoryStartInput
} from "./creatorLearning/types.js";

test("continuity uses the accepted per-path high-water mark and never a completeness-FAIL predecessor", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-high-water-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const highWater = "H".repeat(100);
  const failedAttempt = "F".repeat(70);
  const compoundedShrink = "T".repeat(49);
  const corpusOutputs = [
    corpusWithOptionalSkill(highWater),
    corpusWithOptionalSkill(failedAttempt),
    corpusWithOptionalSkill(compoundedShrink)
  ];
  const corpusCalls: FactoryPromptCall[] = [];
  let completenessCalls = 0;
  const run = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") return "# Task evidence\nUse the Creator's complete decision method [S1:L1].";
    if (call.purpose === "eval.generate_questions") return [
      question("Q1", "Case one", "group-one"),
      question("Q2", "Case two", "group-two"),
      question("Q3", "Case three", "group-three")
    ].join("\n\n");
    if (call.purpose === "corpus.compile") {
      corpusCalls.push(call);
      return corpusOutputs[corpusCalls.length - 1]!;
    }
    if (call.purpose === "eval.audit_corpus") {
      completenessCalls += 1;
      return evaluation(completenessCalls === 1);
    }
    if (call.purpose === "eval.judge_result") return evaluation(true);
    throw new Error(`Unexpected prompt purpose: ${call.purpose}`);
  };
  const input = sampleInput("run-high-water");
  input.config = { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 };
  const factory = new CreatorFactory(root, run, async (execution) => `Finished ${execution.question}`);
  const waiting = await factory.start(input);
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const failed = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );

  assert.equal(failed.stage, "needs_attention");
  assert.equal(corpusCalls.length, 3);
  assert.deepEqual(failed.artifacts.corpusCandidates.map((candidate) => candidate.completeness), ["PASS", "FAIL"]);
  assert.equal(corpusCalls[2]!.prompt.includes(highWater), true, "retry must receive the last accepted predecessor");
  assert.equal(corpusCalls[2]!.prompt.includes(failedAttempt), false, "failed candidate must not become previousCompilation");
  const reports = await Promise.all(failed.artifacts.evaluationRounds.map((reference) => store.readArtifact(reference)));
  assert.equal(reports.some((report) => (
    report.includes("[asset_materially_shortened]")
    && report.includes("skills/offer-audit/SKILL.md")
    && report.includes("49/100")
    && report.includes("high-water baseline")
  )), true);
});

test("a sealed LLM exception is persistently redacted and its timing is failed in the sealed namespace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-sealed-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = "HELDOUT_SENTINEL_PROVIDER_ERROR_72f9";
  const run = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") return "# Task evidence\nVisible evidence.";
    if (call.purpose === "eval.generate_questions") throw new Error(`provider echoed ${sentinel}`);
    throw new Error(`Unexpected prompt purpose: ${call.purpose}`);
  };
  const factory = new CreatorFactory(root, run, async () => "unused");
  const failed = await factory.start(sampleInput("run-sealed-error"));
  const store = new FactoryFileStore(root, failed.runId);

  assert.equal(failed.stage, "needs_attention");
  assert.equal(failed.lastError, "Sealed Factory operation failed; sensitive diagnostics were not persisted");
  const timings = await store.listExecutionTimings();
  const questionTiming = timings.find((row) => row.metadata.boundary === "factory_llm"
    && row.metadata.purpose === "eval.generate_questions");
  assert.equal(questionTiming?.sealed, true);
  assert.equal(questionTiming?.status, "failed");
  assert.equal(typeof questionTiming?.elapsedMs, "number");

  for (const file of await filesUnder(store.directory)) {
    const content = await readFile(file, "utf8");
    assert.equal(content.includes(sentinel), false, `sealed exception escaped into ${path.relative(store.directory, file)}`);
  }
});

test("an inconclusive overlap audit pauses and retries the same durable draft without another Corpus LLM call", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-guard-inconclusive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repeated = "a".repeat(79);
  const rawSource = "a".repeat(6_000);
  let corpusCalls = 0;
  let completenessCalls = 0;
  const run = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") return "# Task evidence\nUse the authorized method without copying it [S1:L1].";
    if (call.purpose === "eval.generate_questions") return [
      question("Q1", "Case one", "group-one"),
      question("Q2", "Case two", "group-two"),
      question("Q3", "Case three", "group-three")
    ].join("\n\n");
    if (call.purpose === "corpus.compile") {
      corpusCalls += 1;
      return corpusWithOptionalSkill(repeated, repeated);
    }
    if (call.purpose === "eval.audit_corpus") completenessCalls += 1;
    return evaluation(true);
  };
  const input = sampleInput("run-guard-inconclusive");
  input.sources = [{
    id: "S1",
    authority: "private_material",
    title: "Adversarial periodic source",
    content: rawSource
  }];
  input.config = { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 };
  const factory = new CreatorFactory(root, run, async () => "must not execute");
  const waiting = await factory.start(input);
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const paused = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );

  assert.equal(paused.stage, "needs_attention");
  assert.equal(paused.retryStage, "compiling_corpus");
  assert.equal(corpusCalls, 1);
  assert.equal(completenessCalls, 0);
  assert.equal(paused.artifacts.rejectedCorpusRepairTarget, undefined);
  assert.equal(paused.artifacts.corpusCandidates.length, 0);
  const firstPending = paused.artifacts.pendingGuardCandidate!;
  assert.equal(await store.readArtifact(firstPending.compilation), corpusWithOptionalSkill(repeated, repeated));
  const firstReport = await store.readArtifact(firstPending.guardReport!);
  assert.match(firstReport, /## Verdict\s+INCONCLUSIVE/);
  assert.match(firstReport, /\[raw_source_overlap_inconclusive\]/);
  assert.equal(firstReport.includes(rawSource), false);

  const pausedAgain = await factory.retry(paused.runId);
  assert.equal(pausedAgain.stage, "needs_attention");
  assert.equal(pausedAgain.retryStage, "compiling_corpus");
  assert.equal(corpusCalls, 1, "retry must not ask the Corpus LLM for a replacement");
  assert.equal(completenessCalls, 0);
  assert.equal(pausedAgain.corpusRevisionCount, 0);
  assert.equal(pausedAgain.artifacts.rejectedCorpusRepairTarget, undefined);
  assert.deepEqual(pausedAgain.artifacts.pendingGuardCandidate?.compilation, firstPending.compilation);
});

test("a completeness provider failure resumes the one guarded candidate without recompiling or changing its version", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-completeness-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let corpusCalls = 0;
  let completenessCalls = 0;
  const rawCorpus = corpusWithOptionalSkill(
    "Choose one evidence-backed direction, identify the material tradeoff, and return a complete result."
  );
  const run = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") return "# Task evidence\nUse a bounded decision method [S1:L1].";
    if (call.purpose === "eval.generate_questions") return [
      question("Q1", "Case one", "group-one"),
      question("Q2", "Case two", "group-two"),
      question("Q3", "Case three", "group-three")
    ].join("\n\n");
    if (call.purpose === "corpus.compile") {
      corpusCalls += 1;
      return rawCorpus;
    }
    if (call.purpose === "eval.audit_corpus") {
      completenessCalls += 1;
      if (completenessCalls === 1) throw new Error("temporary completeness provider failure");
      return evaluation(true);
    }
    if (call.purpose === "eval.judge_result") return evaluation(true);
    throw new Error(`Unexpected prompt purpose: ${call.purpose}`);
  };
  const input = sampleInput("run-completeness-resume");
  input.config = { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 };
  const factory = new CreatorFactory(root, run, async () => {
    throw new Error("fixture stop after completeness recovery");
  });
  const waiting = await factory.start(input);
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const failedAudit = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );

  assert.equal(failedAudit.stage, "needs_attention");
  assert.equal(failedAudit.retryStage, "compiling_corpus");
  assert.equal(corpusCalls, 1);
  assert.equal(completenessCalls, 1);
  assert.equal(failedAudit.artifacts.corpusCandidates.length, 1);
  assert.equal(failedAudit.artifacts.corpusCandidates[0]!.version, 1);
  assert.equal(failedAudit.artifacts.corpusCandidates[0]!.completeness, undefined);
  const compileRecord = failedAudit.artifacts.corpusCandidates[0]!.compileRecord;
  assert.equal(await store.readArtifact(compileRecord), rawCorpus);

  const resumed = await factory.retry(failedAudit.runId);
  assert.equal(resumed.stage, "needs_attention", "fixture stops at Development after completeness succeeds");
  assert.equal(resumed.retryStage, "evaluating_development");
  assert.equal(corpusCalls, 1, "retry must never call corpus.compile for the guarded candidate");
  assert.equal(completenessCalls, 2);
  assert.equal(resumed.artifacts.corpusCandidates.length, 1);
  assert.equal(resumed.artifacts.corpusCandidates[0]!.version, 1);
  assert.equal(resumed.artifacts.corpusCandidates[0]!.completeness, "PASS");
  assert.deepEqual(resumed.artifacts.corpusCandidates[0]!.compileRecord, compileRecord);
});

test("a legacy mixed overlap report restores its exact draft and trusts only the current full re-audit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-guard-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let corpusCalls = 0;
  let completenessCalls = 0;
  const run = async (call: FactoryPromptCall): Promise<string> => {
    if (call.purpose === "evidence.extract") return "# Task evidence\nSynthesize the authorized method [S1:L1].";
    if (call.purpose === "eval.generate_questions") return [
      question("Q1", "Case one", "group-one"),
      question("Q2", "Case two", "group-two"),
      question("Q3", "Case three", "group-three")
    ].join("\n\n");
    if (call.purpose === "corpus.compile") {
      corpusCalls += 1;
      throw new Error("fixture checkpoint before compilation");
    }
    if (call.purpose === "eval.audit_corpus") {
      completenessCalls += 1;
      throw new Error("fixture stop after recovered draft passed the current guard");
    }
    return evaluation(true);
  };
  const input = sampleInput("run-guard-legacy-migration");
  input.sources = [{
    id: "S1",
    authority: "public_context",
    title: "Large same-topic archive",
    content: "a".repeat(6_000)
  }];
  input.config = { developmentQuestions: 2, heldoutQuestions: 1, maxCorpusRevisions: 2 };
  const factory = new CreatorFactory(root, run, async () => "unused");
  const waiting = await factory.start(input);
  const store = new FactoryFileStore(root, waiting.runId);
  const questions = parseQuestions(await store.readArtifact(waiting.artifacts.currentQuestionBatch!));
  const stopped = await factory.submitCreatorAnswers(
    waiting.runId,
    answerMarkdown(questions),
    waiting.artifacts.currentQuestionBatch!.batchId
  );
  assert.equal(stopped.stage, "needs_attention");
  assert.equal(corpusCalls, 1);

  const recoveredRaw = corpusWithOptionalSkill(
    "Choose a supported direction, state uncertainty, and return a complete usable result."
  );
  const recoveredCompilation = await store.writeArtifact(
    "rejected-corpus/attempt-3-candidate-v1-legacy.md",
    recoveredRaw
  );
  const legacyReports = await Promise.all(["one", "two", "three"].map((label, index) => (
    store.writeArtifact(
      `evaluations/corpus-release-guard-v1-legacy-${label}.md`,
      [
        "# Deterministic Corpus release guard",
        "",
        "## Verdict",
        "FAIL",
        "",
        "## Diagnosis",
        `- [raw_source_overlap] paths: instructions/system.md; source_id: OLD-FALSE-PROVEN-${index + 1}`,
        `- [raw_source_overlap] paths: instructions/system.md; source_id: OLD-BUDGET-${index + 1}; analysis: inconclusive (match span budget exceeded); release rejected`,
        ""
      ].join("\n")
    )
  )));
  const legacyReport = legacyReports.at(-1)!;
  const legacyState = await store.loadState();
  legacyState.stage = "needs_attention";
  legacyState.retryStage = "compiling_corpus";
  legacyState.compileReason = "completeness_failure";
  legacyState.corpusRevisionCount = 2;
  legacyState.artifacts.pendingGuardCandidate = undefined;
  legacyState.artifacts.evaluationRounds.push(...legacyReports);
  legacyState.artifacts.rejectedCorpusRepairTarget = {
    attempt: 3,
    candidateVersion: 1,
    compilation: recoveredCompilation,
    failureReport: legacyReport,
    reason: "release_guard"
  };
  await store.saveState(legacyState);

  const reaudited = await factory.retry(stopped.runId);
  assert.equal(corpusCalls, 1, "legacy recovery must not call the Corpus LLM");
  assert.equal(completenessCalls, 1, "the recovered bytes reached completeness only after the current guard passed");
  assert.equal(reaudited.corpusRevisionCount, 2, "legacy revision accounting must not be consumed twice");
  assert.equal(reaudited.artifacts.pendingGuardCandidate, undefined);
  assert.equal(reaudited.artifacts.rejectedCorpusRepairTarget, undefined);
  assert.equal(reaudited.artifacts.corpusCandidates.length, 1);
  assert.equal(legacyReports.some((legacy) => (
    reaudited.artifacts.evaluationRounds.some((active) => active.sha256 === legacy.sha256)
  )), false, "all superseded same-version budget findings must leave active Corpus feedback");
  assert.equal(
    await store.readArtifact(reaudited.artifacts.corpusCandidates[0]!.compileRecord),
    recoveredRaw
  );
  assert.match(
    await readFile(path.join(store.directory, "events.jsonl"), "utf8"),
    /"event":"legacy_guard_reports_invalidated"/
  );
  for (const legacy of legacyReports) {
    assert.match(await store.readArtifact(legacy), /OLD-FALSE-PROVEN/,
      "each invalidated immutable report remains available for audit");
  }
});

test("post-call sealed question validation keeps a sensitive leakage group behind the sealed error boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-sealed-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sentinel = "HELDOUT_SENTINEL_LEAKAGE_GROUP_d10a";
  const run = async (call: FactoryPromptCall): Promise<string> => {
    assert.equal(call.purpose, "eval.generate_questions");
    return question("Q1", "A fresh case", sentinel);
  };
  const factory = new CreatorFactory(root, run, async () => "unused");
  const store = new FactoryFileStore(root, "run-sealed-validation");
  await store.initialize();
  const taskBrief = await store.writeArtifact("input/task-brief.md", "Produce a complete result.");
  const evidence = await store.writeArtifact("evidence/evidence.md", "# Task evidence\nVisible evidence.");
  const state = {
    creator: { id: "creator-one", name: "Creator One" },
    taskName: "One task",
    artifacts: { taskBrief, evidence }
  } as Pick<FactoryRunState, "creator" | "taskName" | "artifacts">;
  const internal = factory as unknown as {
    generateQuestions: (
      store: FactoryFileStore,
      state: Pick<FactoryRunState, "creator" | "taskName" | "artifacts">,
      count: number,
      prefix: string,
      excluded: CreatorQuestion[]
    ) => Promise<CreatorQuestion[]>;
  };

  await assert.rejects(
    internal.generateQuestions(store, state, 1, "H2", [{
      id: "H1.Q1",
      question: "An earlier hidden case",
      leakageGroup: sentinel
    }]),
    (error: unknown) => {
      assert.equal(error instanceof Error ? error.message : String(error),
        "Sealed Factory operation failed; sensitive diagnostics were not persisted");
      return true;
    }
  );
  const timings = await store.listExecutionTimings();
  assert.equal(timings.length, 1);
  assert.equal(timings[0]!.sealed, true);
  assert.equal(timings[0]!.status, "completed", "the LLM completed; host validation failed afterward");
  for (const file of await filesUnder(store.directory)) {
    const relative = path.relative(store.directory, file);
    const content = await readFile(file, "utf8");
    if (content.includes(sentinel)) assert.match(relative, /^sealed\//);
  }
});

function sampleInput(runId: string): FactoryStartInput {
  return {
    runId,
    creator: { id: "creator-one", name: "Creator One" },
    taskName: "Publishable offer critique",
    taskBrief: "Choose one material change and return usable copy.",
    sources: [{
      id: "S1",
      authority: "creator_current",
      title: "Creator workshop",
      content: "Use a bounded decision method and complete the deliverable."
    }]
  };
}

function corpusWithOptionalSkill(
  skillContent: string,
  systemContent = "Make one evidence-backed tradeoff and return a complete, publishable result."
): string {
  return [
    "# Compiled cognitive assets",
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: system",
    "id: system",
    CORPUS_ASSET_CONTENT_MARKER,
    systemContent,
    CORPUS_ASSET_END_MARKER,
    CORPUS_ASSET_BEGIN_MARKER,
    "layer: skill",
    "id: offer-audit",
    "name: Offer audit",
    "when_to_use: Audit an offer",
    "allowed_tool_ids: []",
    CORPUS_ASSET_CONTENT_MARKER,
    skillContent,
    CORPUS_ASSET_END_MARKER,
    "# Change rationale",
    "Preserve the complete Creator method.",
    "# Requirements traceability",
    "- R1 -> skill / skills/offer-audit/SKILL.md.",
    "# Preservation audit",
    "## Retained",
    "- system and offer-audit.",
    "## Added or changed",
    "- offer-audit wording.",
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

function question(id: string, body: string, leakageGroup: string): string {
  return `## ${id}\n### Question\n${body}\n### Why this question\nTests judgment.\n### Leakage group\n${leakageGroup}`;
}

function evaluation(pass: boolean): string {
  return [
    "## Verdict",
    pass ? "PASS" : "FAIL",
    "## Diagnosis",
    pass ? "Complete." : "The second candidate is incomplete.",
    "## Few-shot candidate",
    "None.",
    "## Corpus reflection",
    pass ? "No change." : "Restore the accepted method."
  ].join("\n");
}

function answerMarkdown(questions: CreatorQuestion[]): string {
  return [
    "# Creator answers",
    ...questions.flatMap((item) => [
      `## ${item.id}`,
      "### Question",
      item.question,
      "### Creator Answer",
      `Creator answer for ${item.id}`
    ])
  ].join("\n");
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
