import assert from "node:assert/strict";
import test from "node:test";
import { deriveCreatorWorkflow, isReviewForRun, isValidBriefSpec } from "./creatorWorkflowUi.js";

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
    run: { id: "run-1", status: "ready", workflow_step: "review", stage: "ready", candidate: { system_digest: "sha256:candidate-1" } },
    review: { run_id: "run-1", candidate_digest: "sha256:candidate-1", release_ready: true }
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

test("Product Brief remains editable while Review generation continues", () => {
  const workflow = deriveCreatorWorkflow({
    product: { status: "draft" },
    run: { status: "running", workflow_step: "review", stage: "compiling_corpus", parent_revision_id: "revision-1" },
    review: { release_ready: false, rerun_ready: true },
    briefSpec: brief
  });
  assert.equal(workflow.current, "review");
  assert.equal(workflow.steps.review.loading, true);
  assert.equal(workflow.steps.brief.enabled, true);
  assert.equal(workflow.steps.brief.loading, false);
  assert.equal(workflow.steps.complete.enabled, false);
});

test("stage-only generation checkpoints restore the matching loading step", () => {
  const aboutYou = deriveCreatorWorkflow({ run: { status: "running", stage: "about_you_generation" } });
  assert.equal(aboutYou.current, "about-you");
  assert.equal(aboutYou.steps["about-you"].loading, true);
  for (const step of ["review", "brief", "complete"]) assert.equal(aboutYou.steps[step].enabled, false);

  const review = deriveCreatorWorkflow({ run: { status: "running", stage: "review-generation", parent_revision_id: "revision-1" } });
  assert.equal(review.current, "review");
  assert.equal(review.steps.review.loading, true);
  assert.equal(review.steps.brief.enabled, false);
  assert.equal(review.steps.complete.enabled, false);
});

test("unknown server workflow steps fall back to the durable Factory stage", () => {
  const workflow = deriveCreatorWorkflow({
    run: { status: "running", workflow_step: "future-step", stage: "evaluating_heldout" }
  });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.steps["about-you"].loading, true);
  for (const step of ["review", "brief", "complete"]) assert.equal(workflow.steps[step].enabled, false);
});

test("Review release unlocks Brief, then a valid Brief unlocks Complete", () => {
  const briefWorkflow = deriveCreatorWorkflow({
    run: { id: "run-1", status: "ready", workflow_step: "review", stage: "ready", candidate: { system_digest: "sha256:candidate-1" } },
    review: { run_id: "run-1", candidate_digest: "sha256:candidate-1", release_ready: true },
    briefSpec: null
  });
  assert.equal(briefWorkflow.current, "brief");
  assert.equal(briefWorkflow.steps.brief.enabled, true);
  assert.equal(briefWorkflow.steps.complete.enabled, false);

  const completeWorkflow = deriveCreatorWorkflow({
    run: { id: "run-1", status: "ready", workflow_step: "review", stage: "ready", candidate: { system_digest: "sha256:candidate-1" } },
    review: { run_id: "run-1", candidate_digest: "sha256:candidate-1", release_ready: true },
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

test("a stale review projection cannot unlock Brief or Complete for another run", () => {
  const workflow = deriveCreatorWorkflow({
    run: { id: "run-2", status: "ready", workflow_step: "review", stage: "ready", candidate: { system_digest: "sha256:new" } },
    review: { run_id: "run-1", candidate_digest: "sha256:old", release_ready: true },
    briefSpec: brief
  });
  assert.equal(workflow.reviewMatchesRun, false);
  assert.equal(workflow.current, "review");
  assert.equal(workflow.steps.brief.enabled, false);
  assert.equal(workflow.steps.complete.enabled, false);
});

test("a changed candidate digest invalidates the old review projection", () => {
  const run = { id: "run-1", status: "ready", workflow_step: "review", stage: "ready", candidate: { system_digest: "sha256:new" } };
  const oldReview = { run_id: "run-1", candidate_digest: "sha256:old", release_ready: true };
  assert.equal(isReviewForRun(run, oldReview), false);
  assert.equal(isReviewForRun(run, { ...oldReview, candidate_digest: "sha256:new" }), true);
});

test("a waiting About You run wins over a stale terminal review in the UI state machine", () => {
  const workflow = deriveCreatorWorkflow({
    run: {
      id: "run-1",
      status: "waiting_for_creator",
      stage: "awaiting_creator_answers",
      workflow_step: "about-you",
      pending_questions: [{ id: "q1" }],
      candidate: { system_digest: "sha256:old" }
    },
    review: { run_id: "run-1", candidate_digest: "sha256:old", release_ready: true },
    briefSpec: brief
  });
  assert.equal(workflow.current, "about-you");
  assert.equal(workflow.steps.review.enabled, false);
  assert.equal(workflow.steps.complete.enabled, false);
});

test("a durable publishing intent keeps Complete loading after refresh and locks the authoring tabs", () => {
  const workflow = deriveCreatorWorkflow({
    product: { status: "publishing" },
    run: { id: "run-1", status: "ready", workflow_step: "review", stage: "ready" }
  });
  assert.equal(workflow.current, "complete");
  assert.equal(workflow.publishing, true);
  assert.equal(workflow.steps.complete.loading, true);
  assert.equal(workflow.steps.complete.locked, true);
  assert.equal(workflow.steps.complete.enabled, true);
  for (const step of ["files", "about-you", "review", "brief"]) {
    assert.equal(workflow.steps[step].enabled, false);
    assert.equal(workflow.steps[step].loading, false);
  }
});

test("published Product status is a durable Complete checkpoint even without a selected run", () => {
  const workflow = deriveCreatorWorkflow({ product: { status: "published" } });
  assert.equal(workflow.current, "complete");
  assert.equal(workflow.published, true);
  assert.equal(workflow.steps.complete.loading, false);
  assert.equal(workflow.steps.complete.enabled, true);
  assert.equal(workflow.steps.files.enabled, true);
});

test("an explicit publish failure keeps Complete actionable without pretending it is still loading", () => {
  const workflow = deriveCreatorWorkflow({ product: { status: "publish_failed" } });
  assert.equal(workflow.current, "complete");
  assert.equal(workflow.publishFailed, true);
  assert.equal(workflow.steps.complete.loading, false);
  assert.equal(workflow.steps.complete.failed, true);
  assert.equal(workflow.steps.complete.enabled, true);
});

test("a newly running version still wins over an older published Product projection", () => {
  const workflow = deriveCreatorWorkflow({
    product: { status: "published" },
    run: { id: "run-2", status: "running", workflow_step: "files", stage: "extracting_evidence" }
  });
  assert.equal(workflow.current, "files");
  assert.equal(workflow.steps.files.loading, true);
  assert.equal(workflow.steps.complete.enabled, false);
});
