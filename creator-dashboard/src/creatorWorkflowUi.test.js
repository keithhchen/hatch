import assert from "node:assert/strict";
import test from "node:test";
import { deriveCreatorWorkflow, isValidBriefSpec } from "./creatorWorkflowUi.js";

const brief = { contract_version: "1", fields: [{ id: "goal", label: "What is your goal?", required: true }] };

test("initial Files generation keeps every other step disabled", () => {
  const workflow = deriveCreatorWorkflow({ run: { status: "running", workflow_step: "files", stage: "extracting_evidence" } });
  assert.equal(workflow.current, "files");
  assert.equal(workflow.working, true);
  assert.equal(workflow.steps.files.loading, true);
  for (const step of ["about-you", "review", "brief", "complete"]) assert.equal(workflow.steps[step].enabled, false);
});

test("local command busy state never overrides the last durable run", () => {
  const workflow = deriveCreatorWorkflow({
    busy: "start",
    run: { status: "ready", workflow_step: "review", stage: "ready", candidate: {} },
    review: { release_ready: true }
  });
  assert.equal(workflow.current, "brief");
  assert.equal(workflow.working, false);
  assert.equal(workflow.steps.files.loading, false);
  assert.equal(workflow.steps.brief.enabled, true);
  assert.equal(workflow.steps.complete.enabled, false);
});

test("the returned queued run becomes the persistent generation checkpoint", () => {
  const workflow = deriveCreatorWorkflow({
    run: { status: "queued", workflow_step: "files", stage: "extracting_evidence" },
    review: { release_ready: true }
  });
  assert.equal(workflow.current, "files");
  assert.equal(workflow.working, true);
  assert.equal(workflow.steps.files.loading, true);
  for (const step of ["about-you", "review", "brief", "complete"]) assert.equal(workflow.steps[step].enabled, false);
});

test("persisted About You questions unlock only About You", () => {
  const workflow = deriveCreatorWorkflow({
    run: { status: "waiting_for_creator", workflow_step: "about-you", stage: "awaiting_creator_answers", pending_questions: [{ id: "q1" }] }
  });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.steps.files.enabled, true);
  assert.equal(workflow.steps["about-you"].enabled, true);
  for (const step of ["review", "brief", "complete"]) assert.equal(workflow.steps[step].enabled, false);
});

test("answer submission remains on About You while Review is generated", () => {
  const workflow = deriveCreatorWorkflow({
    run: { status: "queued", workflow_step: "about-you", stage: "awaiting_creator_answers", pending_answers: { answers: [] } }
  });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.steps["about-you"].loading, true);
  assert.equal(workflow.steps.review.enabled, false);
});

test("Review rerun keeps Review loading and locks Brief and Complete", () => {
  const workflow = deriveCreatorWorkflow({
    run: { status: "running", workflow_step: "review", stage: "compiling_corpus", parent_revision_id: "revision-1" },
    review: { release_ready: false, rerun_ready: true }
  });
  assert.equal(workflow.current, "review");
  assert.equal(workflow.steps.review.loading, true);
  assert.equal(workflow.steps.brief.enabled, false);
  assert.equal(workflow.steps.complete.enabled, false);
});

test("Review release unlocks Brief, then a valid Brief unlocks Complete", () => {
  const briefWorkflow = deriveCreatorWorkflow({
    run: { status: "ready", workflow_step: "review", stage: "ready", candidate: {} },
    review: { release_ready: true },
    briefSpec: null
  });
  assert.equal(briefWorkflow.current, "brief");
  assert.equal(briefWorkflow.steps.brief.enabled, true);
  assert.equal(briefWorkflow.steps.complete.enabled, false);

  const completeWorkflow = deriveCreatorWorkflow({
    run: { status: "ready", workflow_step: "review", stage: "ready", candidate: {} },
    review: { release_ready: true },
    briefSpec: brief
  });
  assert.equal(completeWorkflow.current, "complete");
  assert.equal(completeWorkflow.steps.complete.enabled, true);
});

test("server failure keeps the current step visible and future steps disabled", () => {
  const workflow = deriveCreatorWorkflow({
    run: {
      status: "needs_attention",
      stage: "needs_attention",
      retry_stage: "evaluating_heldout",
      workflow_step: "about-you",
      last_error: "Provider quota unavailable",
      retryable: true
    }
  });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.failed, true);
  assert.equal(workflow.steps["about-you"].failed, true);
  assert.equal(workflow.steps.review.enabled, false);
});

test("brief validity is deterministic and rejects empty or duplicate fields", () => {
  assert.equal(isValidBriefSpec(brief), true);
  assert.equal(isValidBriefSpec({ fields: [] }), false);
  assert.equal(isValidBriefSpec({ fields: [
    { id: "goal", label: "One", required: true },
    { id: "goal", label: "Two", required: false }
  ] }), false);
});
