import assert from "node:assert/strict";
import test from "node:test";
import { deriveCreatorWorkflow, isExecutionError, isValidBriefSpec } from "./creatorWorkflowUi.js";

const files = [{ id: "file-1", status: "ready" }];
const brief = { contract_version: "1", fields: [{ id: "goal", label: "What is your goal?", required: true }] };

test("Files is the only enabled step before source material exists", () => {
  const workflow = deriveCreatorWorkflow({});
  assert.equal(workflow.current, "files");
  assert.equal(workflow.steps.files.enabled, true);
  assert.equal(workflow.steps["about-you"].enabled, false);
});

test("About You stays active while its async Node execution is running", () => {
  const workflow = deriveCreatorWorkflow({ documents: files, aboutYou: { status: "running", round: 1 } });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.steps["about-you"].loading, true);
  assert.equal(workflow.steps.corpus.enabled, false);
});

test("Creator answers unlock Corpus and no longer expose Review", () => {
  const workflow = deriveCreatorWorkflow({
    documents: files,
    aboutYou: { status: "handoff_saved", handoff_ref: "product/about-you/execution/creator-answers.json" }
  });
  assert.equal(workflow.current, "corpus");
  assert.equal(workflow.steps.corpus.enabled, true);
  assert.equal(Object.hasOwn(workflow.steps, "review"), false);
});

test("A completed Corpus unlocks Brief, then a valid Brief unlocks Complete", () => {
  const corpus = { status: "completed", output_ref: "product/corpus/execution/output.json" };
  const beforeBrief = deriveCreatorWorkflow({ documents: files, aboutYou: { status: "handoff_saved", handoff_ref: "answers" }, corpus });
  assert.equal(beforeBrief.current, "brief");
  assert.equal(beforeBrief.steps.complete.enabled, false);
  const afterBrief = deriveCreatorWorkflow({ documents: files, aboutYou: { status: "handoff_saved", handoff_ref: "answers" }, corpus, briefSpec: brief });
  assert.equal(afterBrief.current, "complete");
  assert.equal(afterBrief.steps.complete.enabled, true);
});

test("Node failures remain visible and actionable", () => {
  const workflow = deriveCreatorWorkflow({ documents: files, aboutYou: { status: "failed", last_error: "provider unavailable" } });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.failed, true);
  assert.equal(workflow.steps["about-you"].failed, true);
  assert.equal(isExecutionError({ status: "max_rounds" }), true);
});

test("Brief validity is deterministic", () => {
  assert.equal(isValidBriefSpec(brief), true);
  assert.equal(isValidBriefSpec({ fields: [] }), false);
  assert.equal(isValidBriefSpec({ fields: [{ id: "goal", label: "One", required: true }, { id: "goal", label: "Two", required: false }] }), false);
});
