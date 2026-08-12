import assert from "node:assert/strict";
import test from "node:test";
import {
  CORPUS_ASSET_BEGIN_MARKER,
  CORPUS_ASSET_CONTENT_MARKER,
  CORPUS_ASSET_END_MARKER,
  CORPUS_COMPILATION_END_MARKER,
  extractCorpus,
  parseCorpusCompilation,
  parseCreatorAnswers,
  parseQaSet,
  parseQuestions,
  renderQaSet,
  validatePreservationAudit
} from "./creatorLearning/markdown.js";
import {
  corpusCompletenessPrompt,
  corpusPrompt,
  evaluationPrompt,
  evidencePrompt,
  questionPrompt
} from "./creatorLearning/prompts.js";

test("layered Corpus parser returns multiple typed Skills, references, and knowledge without consuming nested headings", () => {
  const system = [
    "# Creator operating system",
    "## Role",
    "Choose one material tradeoff.",
    "# Change rationale",
    "This is legitimate runtime content, not the compiler envelope."
  ].join("\n");
  const skillOne = "# Position an offer\n## Steps\n1. Find the decisive promise.";
  const skillTwo = "# Research a market\n## Stop condition\nStop when evidence is sufficient.";
  const referenceOne = "# Decision grid\n## Axis A\nSpecificity\n# Compilation complete\nA valid nested heading.";
  const referenceTwo = "# Voice examples\n## Strong\nConcrete before clever.";
  const knowledgeOne = "# Market cases\n## Narrow category\nA purified case and its applicability.";
  const knowledgeTwo = "# Objection patterns\n## Risk reversal\nA searchable, synthesized pattern.";
  const markdown = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], system),
    corpusAsset([
      "layer: skill",
      "id: offer-positioning",
      "name: Offer positioning",
      "when_to_use: Use when a promise must be narrowed.",
      "allowed_tool_ids: hatch.web_search"
    ], skillOne),
    corpusAsset([
      "layer: skill",
      "id: market-research",
      "name: Market research",
      "when_to_use: Use when current external facts are material.",
      "allowed_tool_ids: hatch.web_search, creator.crm_lookup"
    ], skillTwo),
    corpusAsset([
      "layer: reference",
      "id: decision-grid",
      "parent_skill_id: offer-positioning",
      "reference_kind: method"
    ], referenceOne),
    corpusAsset([
      "layer: reference",
      "id: voice-examples",
      "parent_skill_id: offer-positioning",
      "reference_kind: example"
    ], referenceTwo),
    corpusAsset([
      "layer: knowledge",
      "id: market-cases",
      "source_summary: Purified Creator-authorized market cases.",
      "retrieval_only: true"
    ], knowledgeOne),
    corpusAsset([
      "layer: knowledge",
      "id: objection-patterns",
      "source_summary: Synthesized objection patterns from authorized material.",
      "retrieval_only: true"
    ], knowledgeTwo)
  ]);

  const options = { availableToolIds: ["hatch.web_search", "creator.crm_lookup"] };
  const parsed = parseCorpusCompilation(markdown, options);
  assert.equal(parsed.format, "layered-assets");
  assert.equal(parsed.systemInstructions, system);
  assert.equal(extractCorpus(markdown, options), system);
  assert.deepEqual(parsed.skills, [{
    id: "offer-positioning",
    path: "skills/offer-positioning/SKILL.md",
    name: "Offer positioning",
    whenToUse: "Use when a promise must be narrowed.",
    allowedToolIds: ["hatch.web_search"],
    content: skillOne
  }, {
    id: "market-research",
    path: "skills/market-research/SKILL.md",
    name: "Market research",
    whenToUse: "Use when current external facts are material.",
    allowedToolIds: ["hatch.web_search", "creator.crm_lookup"],
    content: skillTwo
  }]);
  assert.deepEqual(parsed.references.map(({ id, path, parentSkillId, kind, content }) => ({ id, path, parentSkillId, kind, content })), [{
    id: "decision-grid",
    path: "skills/offer-positioning/references/decision-grid.md",
    parentSkillId: "offer-positioning",
    kind: "method",
    content: referenceOne
  }, {
    id: "voice-examples",
    path: "skills/offer-positioning/references/voice-examples.md",
    parentSkillId: "offer-positioning",
    kind: "example",
    content: referenceTwo
  }]);
  assert.deepEqual(parsed.knowledge, [{
    id: "market-cases",
    path: "knowledge/market-cases.md",
    sourceSummary: "Purified Creator-authorized market cases.",
    retrievalOnly: true,
    content: knowledgeOne
  }, {
    id: "objection-patterns",
    path: "knowledge/objection-patterns.md",
    sourceSummary: "Synthesized objection patterns from authorized material.",
    retrievalOnly: true,
    content: knowledgeTwo
  }]);
  assert.match(parsed.requirementsTraceability, /instructions\/system\.md/);
});

test("layered Corpus permits empty optional layers and rejects legacy production output", () => {
  const markdown = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "# Role\nDeliver the finished work.")
  ]);
  const parsed = parseCorpusCompilation(markdown);
  assert.deepEqual(parsed.skills, []);
  assert.deepEqual(parsed.references, []);
  assert.deepEqual(parsed.knowledge, []);

  assert.throws(() => parseCorpusCompilation([
    "# Corpus",
    "Legacy System-only output.",
    "# Change rationale",
    "Legacy."
  ].join("\n")), /must contain asset blocks/i);
});

test("layered Corpus rejects malformed blocks, invalid identifiers, empty content, and undeclared tools", () => {
  const valid = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "Complete instructions.")
  ]);
  assert.throws(
    () => parseCorpusCompilation(valid.replace(CORPUS_ASSET_END_MARKER, "")),
    /incomplete asset marker block/i
  );
  assert.throws(
    () => parseCorpusCompilation(corpusCompilation([corpusAsset(["layer: system", "id: System"], "Content.")])),
    /lowercase Agent Corpus identifier/i
  );
  assert.throws(
    () => parseCorpusCompilation(corpusCompilation([corpusAsset(["layer: system", "id: system"], "   ")])),
    /empty content/i
  );
  assert.throws(
    () => parseCorpusCompilation(corpusCompilation([corpusAsset([
      "layer: system",
      "id: system",
      "path: overwrite.md"
    ], "Content.")])),
    /unknown field: path/i
  );

  const undeclaredTool = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "System."),
    corpusAsset([
      "layer: skill",
      "id: lookup",
      "name: Lookup",
      "when_to_use: When facts are missing.",
      "allowed_tool_ids: creator.secret_tool"
    ], "# Lookup\nUse only the allowed tool.")
  ]);
  assert.throws(
    () => parseCorpusCompilation(undeclaredTool, { availableToolIds: ["hatch.web_search"] }),
    /unavailable tool id: creator\.secret_tool/i
  );
});

test("layered Corpus rejects duplicate assets, unknown reference parents, and invalid reference kinds", () => {
  const duplicate = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "System."),
    corpusAsset([
      "layer: skill",
      "id: review",
      "name: Review",
      "when_to_use: When reviewing.",
      "allowed_tool_ids: []"
    ], "Review once."),
    corpusAsset([
      "layer: knowledge",
      "id: review",
      "source_summary: Purified review cases.",
      "retrieval_only: true"
    ], "# Cases\nOne case.")
  ]);
  assert.throws(() => parseCorpusCompilation(duplicate), /repeats asset id: review/i);

  const reference = (parent: string, kind: string) => corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "System."),
    corpusAsset([
      "layer: skill",
      "id: review",
      "name: Review",
      "when_to_use: When reviewing.",
      "allowed_tool_ids: []"
    ], "Review once."),
    corpusAsset([
      "layer: reference",
      "id: rubric",
      `parent_skill_id: ${parent}`,
      `reference_kind: ${kind}`
    ], "# Rubric\nApply it.")
  ]);
  assert.throws(() => parseCorpusCompilation(reference("missing", "method")), /unknown parent skill: missing/i);
  assert.throws(() => parseCorpusCompilation(reference("review", "raw_evidence")), /invalid reference kind: raw_evidence/i);
});

test("layered Corpus requires the complete final marker and complete preservation audit", () => {
  const valid = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "Complete instructions.")
  ]);
  assert.throws(
    () => parseCorpusCompilation(valid.replace(CORPUS_COMPILATION_END_MARKER, "HATCH_CORPUS_COMPILATION")),
    /compilation is incomplete/i
  );
  assert.throws(
    () => parseCorpusCompilation(`${valid}\ntrailing partial output`),
    /compilation is incomplete/i
  );

  const missingMergedDisposition = [
    "## Retained\n- None — initial compilation.",
    "## Added or changed\n- R1 added.",
    "## Removed\n- None.",
    "## Conflict resolutions\n- None.",
    "## Asset identity, path, or layer changes\n- None."
  ].join("\n");
  assert.throws(() => validatePreservationAudit(missingMergedDisposition), /## Merged/);
});

test("Corpus prompt compiles lossless full-layer replacements with concrete destinations", () => {
  const previousCompilation = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "PREVIOUS_SYSTEM_BOUNDARY"),
    corpusAsset([
      "layer: knowledge",
      "id: prior-cases",
      "source_summary: Purified prior cases.",
      "retrieval_only: true"
    ], "PREVIOUS_KNOWLEDGE_ITEM")
  ]);
  const call = corpusPrompt({
    creatorName: "Creator",
    taskName: "Task",
    taskBrief: "Produce a decisive deliverable.",
    productContract: "Promise: a directly usable review. Boundary: no guaranteed revenue. Offer: Creator explicitly set USD 99.",
    evidence: "Explicit decision rule [S1:L1].",
    developmentQa: [{ id: "D.Q1", question: "Choose.", answer: "Choose A." }],
    evaluationFeedback: "Route the global decision rule to System.",
    regression: [],
    availableToolIds: ["hatch.web_search", "creator.crm_lookup"],
    previousCompilation,
    reason: "development_failure"
  });

  assert.match(call.systemPrompt, /complete set of supported cognitive assets/i);
  assert.match(call.systemPrompt, /full, self-contained replacement of ALL layers and ALL assets/i);
  assert.match(call.systemPrompt, /Re-emit every retained System, Skill, reference, and knowledge asset in full/i);
  assert.match(call.systemPrompt, /long-term product editor-in-chief and system designer/i);
  assert.match(call.systemPrompt, /when brevity conflicts with retained capability, preserve the capability/i);
  assert.match(call.systemPrompt, /Every supported runtime requirement must have a real destination in an asset emitted/i);
  assert.match(call.systemPrompt, /routing suggestion without the destination asset's complete content.*failure/i);
  assert.match(call.systemPrompt, /Knowledge is not an archive of inputs/i);
  assert.match(call.systemPrompt, /purified, self-contained, searchable long-tail content/i);
  assert.match(call.systemPrompt, /Never generate an `agent\.json`, manifest, SHA\/digest/i);
  assert.match(call.systemPrompt, /only tool-related output permitted is a Skill's `allowed_tool_ids`/i);
  assert.match(call.systemPrompt, /must exactly match one of the externally supplied Available tool IDs/i);
  assert.match(call.systemPrompt, /price\/offer fields remain explicit Creator-owned metadata/i);
  assert.match(call.systemPrompt, /active sealed held-out set[—-].*never visible/is);
  assert.match(call.systemPrompt, /old and new asset ID\/path\/layer/i);
  assert.match(call.systemPrompt, /use only the available local submission tools/i);
  assert.match(call.systemPrompt, /submit exactly one complete System instruction asset/i);
  assert.match(call.systemPrompt, /Change rationale, Requirements traceability, and Preservation audit/i);
  assert.match(call.systemPrompt, /Never submit a path: the host derives every canonical path/i);
  assert.match(call.systemPrompt, /entire complete corrected Corpus.*never only an affected asset\/section/is);
  assert.match(call.prompt, /Previous accepted complete compilation/);
  assert.match(call.prompt, /PREVIOUS_SYSTEM_BOUNDARY/);
  assert.match(call.prompt, /PREVIOUS_KNOWLEDGE_ITEM/);
  assert.match(call.prompt, /hatch\.web_search/);
  assert.match(call.prompt, /Creator explicitly set USD 99/);

  assert.throws(() => corpusPrompt({
    creatorName: "Creator",
    taskName: "Task",
    taskBrief: "Brief",
    evidence: "Evidence",
    developmentQa: [],
    evaluationFeedback: "",
    regression: [],
    previousCorpus: "Only old System.",
    reason: "development_failure"
  }), /complete accepted baseline or a complete rejected repair target/i);

  const repair = corpusPrompt({
    creatorName: "Creator",
    taskName: "Task",
    taskBrief: "Brief",
    evidence: "Evidence",
    developmentQa: [],
    evaluationFeedback: "[raw_source_overlap] instructions/system.md",
    regression: [],
    rejectedRepairCompilation: "REJECTED_COMPLETE_DRAFT",
    rejectedRepairFailure: "[raw_source_overlap] instructions/system.md",
    reason: "completeness_failure"
  });
  assert.match(repair.prompt, /Rejected compilation repair target[\s\S]*REJECTED_COMPLETE_DRAFT/);
  assert.match(repair.prompt, /Deterministic failure report[\s\S]*raw_source_overlap/);
  assert.match(repair.prompt, /Previous accepted complete compilation[\s\S]*None — initial compilation/);
  assert.match(repair.systemPrompt, /never treat its additions, deletions, wording, or audit claims as accepted authority/i);

  assert.throws(() => corpusPrompt({
    creatorName: "Creator",
    taskName: "Task",
    taskBrief: "Brief",
    evidence: "Evidence",
    developmentQa: [],
    evaluationFeedback: "",
    regression: [],
    rejectedRepairCompilation: "UNPAIRED_DRAFT",
    reason: "completeness_failure"
  }), /requires both the complete compilation and its deterministic failure report/i);
});

test("Corpus completeness prompt audits all candidate assets, metadata, paths, and layers", () => {
  const previousCompilation = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "OLD_SYSTEM"),
    corpusAsset([
      "layer: skill",
      "id: review",
      "name: Review",
      "when_to_use: When reviewing.",
      "allowed_tool_ids: []"
    ], "OLD_SKILL")
  ]);
  const candidateCompilation = corpusCompilation([
    corpusAsset(["layer: system", "id: system"], "NEW_SYSTEM"),
    corpusAsset([
      "layer: skill",
      "id: review",
      "name: Review",
      "when_to_use: When reviewing.",
      "allowed_tool_ids: hatch.web_search"
    ], "NEW_SKILL"),
    corpusAsset([
      "layer: reference",
      "id: rubric",
      "parent_skill_id: review",
      "reference_kind: method"
    ], "CANDIDATE_REFERENCE"),
    corpusAsset([
      "layer: knowledge",
      "id: cases",
      "source_summary: Purified cases.",
      "retrieval_only: true"
    ], "CANDIDATE_KNOWLEDGE")
  ]);
  const call = corpusCompletenessPrompt({
    creatorName: "Creator",
    taskName: "Task",
    taskBrief: "Produce the deliverable.",
    productContract: "Boundary: never guarantee outcomes.",
    evidence: "Supported rules.",
    developmentQa: [],
    regression: [],
    availableToolIds: ["hatch.web_search"],
    previousCompilation,
    candidateCompilation
  });

  assert.match(call.systemPrompt, /whole cognitive asset set: System, optional Skills, Skill-local references, and retrieval-only knowledge/i);
  assert.match(call.systemPrompt, /Audit every candidate asset block and its metadata, not only System/i);
  assert.match(call.systemPrompt, /required item with only a routing recommendation and no complete destination asset is a failure/i);
  assert.match(call.systemPrompt, /complete replacement of every retained layer and asset/i);
  assert.match(call.systemPrompt, /every old\/new asset ID, derived path, and layer/i);
  assert.match(call.systemPrompt, /Knowledge must be purified, self-contained, searchable long-tail content—not raw evidence/i);
  assert.match(call.prompt, /OLD_SKILL/);
  assert.match(call.prompt, /CANDIDATE_REFERENCE/);
  assert.match(call.prompt, /CANDIDATE_KNOWLEDGE/);
  assert.match(call.prompt, /never guarantee outcomes/);
});

test("Evidence and evaluation prompts make layer routing directional and keep eval artifacts out of prompts", () => {
  const evidence = evidencePrompt({
    creator: { id: "creator-1", name: "Creator" },
    taskName: "Task",
    taskBrief: "Brief"
  }, "S1: source");
  assert.match(evidence.systemPrompt, /Factory worldview, values, and vision are operational conflict rules/i);
  assert.match(evidence.systemPrompt, /rigorous researcher accountable for what the Creator actually meant/i);
  assert.match(evidence.systemPrompt, /when sources conflict, respect and expose the contradiction/i);
  assert.match(evidence.systemPrompt, /always-on System, optional Skill, Skill-local reference, retrieval-only knowledge, or evaluation-only/i);
  assert.match(evidence.systemPrompt, /Raw source material.*must never enter the published Agent Corpus or bundle/is);

  const question = questionPrompt({
    creatorName: "Creator",
    taskName: "Task",
    taskBrief: "Brief",
    evidence: "Evidence",
    count: 1
  });
  assert.match(question.systemPrompt, /faithfully preserve the Creator's actual judgment/i);
  assert.match(question.systemPrompt, /mark unknowns and uncertainty instead of fabricating/i);
  assert.match(question.systemPrompt, /finished, paid-worthy result that an end customer could directly use, publish, sell, or reasonably pay for/i);
  assert.match(question.systemPrompt, /prefer completeness and durable capability over being shorter or faster/i);
  assert.match(question.systemPrompt, /demanding editor-in-chief accountable to the paying end customer/i);

  const evaluation = evaluationPrompt({
    creatorName: "Creator",
    taskName: "Task",
    qa: { id: "D.Q1", question: "Generated question", answer: "Human reference" },
    hatchResult: "Candidate"
  });
  assert.match(evaluation.systemPrompt, /demanding editor-in-chief accountable to the paying end customer/i);
  assert.match(evaluation.systemPrompt, /actively search for omissions/i);
  assert.match(evaluation.systemPrompt, /generic fluency.*never counts as success/i);
  assert.match(evaluation.systemPrompt, /Synthetic.*task\/question was generated/is);
  assert.match(evaluation.systemPrompt, /Creator answer is the human behavioral reference/i);
  assert.match(evaluation.systemPrompt, /evaluation-only artifacts, not live prompt text/i);
  assert.match(evaluation.systemPrompt, /System, optional Skill, Skill-local reference, retrieval-only knowledge, or evaluation-only/i);
  assert.match(evaluation.prompt, /Creator answer \(human reference\)/);
});

test("Creator answers preserve publishable Markdown headings", () => {
  const questions = [{ id: "I.Q1", question: "Write the finished launch plan.", leakageGroup: "launch-plan" }];
  const answer = [
    "## I.Q1",
    "### Question",
    "Write the finished launch plan.",
    "### Creator Answer",
    "# Launch plan",
    "## Final post",
    "Ship the focused offer today."
  ].join("\n");

  assert.equal(parseCreatorAnswers(answer, questions)[0]?.answer, [
    "# Launch plan",
    "## Final post",
    "Ship the focused offer today."
  ].join("\n"));
});

test("QA Markdown round-trips answers and generated tasks with nested headings", () => {
  const qa = [{
    id: "I.Q1",
    question: "Review this draft:\n## Draft\nA generic offer.",
    intent: "Reveal the decisive tradeoff.",
    leakageGroup: "offer-review",
    answer: "# Final copy\n## Promise\nOne sharp outcome."
  }];
  const markdown = renderQaSet("Development QA", qa);

  assert.deepEqual(parseQaSet(markdown), qa);
  assert.equal(parseQuestions(markdown)[0]?.question, qa[0]?.question);
});

function completePreservationAudit(): string {
  return [
    "## Retained",
    "- None — initial compilation.",
    "## Added or changed",
    "- R1 added.",
    "## Removed",
    "- None.",
    "## Merged",
    "- None.",
    "## Conflict resolutions",
    "- None.",
    "## Asset identity, path, or layer changes",
    "- None."
  ].join("\n");
}

function corpusAsset(metadata: string[], content: string): string {
  return [
    CORPUS_ASSET_BEGIN_MARKER,
    ...metadata,
    CORPUS_ASSET_CONTENT_MARKER,
    content,
    CORPUS_ASSET_END_MARKER
  ].join("\n");
}

function corpusCompilation(assets: string[]): string {
  return [
    "# Compiled cognitive assets",
    ...assets,
    "# Change rationale",
    "- Every supported requirement has a concrete emitted destination.",
    "# Requirements traceability",
    "- R1 [Task brief] -> system -> instructions/system.md (system).",
    "# Preservation audit",
    completePreservationAudit(),
    "# Compilation complete",
    CORPUS_COMPILATION_END_MARKER
  ].join("\n");
}
