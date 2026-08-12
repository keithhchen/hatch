import assert from "node:assert/strict";
import test from "node:test";
import { factoryPollInterval, factoryShouldPoll, factoryStageLabel, reconcileFactoryQuestionBatch } from "./creatorFactory.js";

test("Factory stage labels expose the real workflow without inventing reviewer nodes", () => {
  assert.equal(factoryStageLabel({ stage: "extracting_evidence" }), "Extracting evidence");
  assert.equal(factoryStageLabel({ stage: "awaiting_creator_answers" }), "Waiting for your answers");
  assert.equal(factoryStageLabel({ stage: "evaluating_regression" }), "Running regression");
  assert.equal(factoryStageLabel({ stage: "evaluating_heldout" }), "Running sealed held-out cases");
  assert.equal(factoryStageLabel({ stage: "ready" }), "Candidate ready");
});

test("queued and running control status takes precedence over a stale persisted graph stage", () => {
  assert.equal(factoryStageLabel({ status: "queued", stage: "awaiting_creator_answers" }), "Queued");
  assert.equal(factoryStageLabel({ status: "running", stage: "needs_attention" }), "Working");
  assert.equal(
    factoryStageLabel({ status: "waiting_for_creator", stage: "awaiting_creator_answers" }),
    "Waiting for your answers"
  );
});

test("Dashboard polls only queued or running control-plane work", () => {
  assert.equal(factoryShouldPoll({ status: "queued" }), true);
  assert.equal(factoryShouldPoll({ status: "running" }), true);
  assert.equal(factoryShouldPoll({ status: "waiting_for_creator" }), false);
  assert.equal(factoryShouldPoll({ status: "ready" }), false);
  assert.equal(factoryShouldPoll({ status: "needs_attention" }), false);
});

test("waiting question batches refresh slowly enough to preserve drafts and detect replacement", () => {
  assert.equal(factoryPollInterval({ status: "queued" }), 3000);
  assert.equal(factoryPollInterval({ status: "waiting_for_creator" }), 5000);
  assert.equal(factoryPollInterval({ status: "ready" }), undefined);
});

test("a new question batch never replays old answers but keeps them available for explicit recovery", () => {
  const previous = {
    runId: "run_1",
    batchId: "batch_1",
    questions: [
      { id: "q_1", question: "Old question one?" },
      { id: "q_2", question: "Old question two?" }
    ],
    answers: { q_1: "A useful answer", q_2: "   " },
    recovery: null
  };
  const next = reconcileFactoryQuestionBatch(previous, {
    id: "run_1",
    question_batch_id: "batch_2",
    pending_questions: [{ id: "q_1", question: "A revised question?" }]
  });

  assert.deepEqual(next.answers, { q_1: "" });
  assert.deepEqual(next.recovery, {
    from_batch_id: "batch_1",
    to_batch_id: "batch_2",
    entries: [{ question_id: "q_1", question: "Old question one?", answer: "A useful answer" }]
  });
});

test("refreshing the same question batch preserves in-progress answers and recovery", () => {
  const recovery = { from_batch_id: "old", to_batch_id: "batch_1", entries: [] };
  const next = reconcileFactoryQuestionBatch({
    runId: "run_1",
    batchId: "batch_1",
    questions: [{ id: "q_1", question: "Question?" }],
    answers: { q_1: "Draft answer" },
    recovery
  }, {
    id: "run_1",
    question_batch_id: "batch_1",
    pending_questions: [{ id: "q_1", question: "Question?" }, { id: "q_2", question: "New question?" }]
  });

  assert.deepEqual(next.answers, { q_1: "Draft answer", q_2: "" });
  assert.equal(next.recovery, recovery);
});

test("opening a different run never leaks another run's answers", () => {
  const next = reconcileFactoryQuestionBatch({
    runId: "run_1",
    batchId: "batch_1",
    questions: [{ id: "q_1", question: "Private question?" }],
    answers: { q_1: "Private answer" }
  }, {
    id: "run_2",
    question_batch_id: "batch_1",
    pending_questions: [{ id: "q_1", question: "Other question?" }]
  });

  assert.deepEqual(next.answers, { q_1: "" });
  assert.equal(next.recovery, null);
});
