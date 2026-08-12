import { dashboardRequest } from "./data.js";

export const FACTORY_STAGE_LABELS = {
  extracting_evidence: "Extracting evidence",
  awaiting_creator_answers: "Waiting for your answers",
  compiling_corpus: "Compiling the Corpus",
  evaluating_development: "Checking development cases",
  evaluating_regression: "Running regression",
  evaluating_heldout: "Running sealed held-out cases",
  ready: "Candidate ready",
  needs_attention: "Needs attention"
};

export function factoryStageLabel(run) {
  if (run?.status === "queued") return "Queued";
  if (run?.status === "running") return "Working";
  return FACTORY_STAGE_LABELS[run?.stage] ?? "Not started";
}

export function factoryShouldPoll(run) {
  return run?.status === "queued" || run?.status === "running";
}

export function factoryPollInterval(run) {
  if (factoryShouldPoll(run)) return 3000;
  if (run?.status === "waiting_for_creator") return 5000;
  return undefined;
}

export function reconcileFactoryQuestionBatch(previous = {}, run = {}) {
  const runId = run.id ?? "";
  const batchId = run.question_batch_id ?? "";
  const questions = run.pending_questions ?? [];
  const sameBatch = previous.runId === runId && previous.batchId === batchId;

  if (sameBatch) {
    return {
      runId,
      batchId,
      questions,
      answers: Object.fromEntries(questions.map((question) => [question.id, previous.answers?.[question.id] ?? ""])),
      recovery: previous.recovery ?? null
    };
  }

  const recoveryEntries = previous.runId === runId
    && previous.batchId
    && batchId
    && previous.batchId !== batchId
    ? (previous.questions ?? []).flatMap((question) => {
      const answer = previous.answers?.[question.id] ?? "";
      return answer.trim() ? [{ question_id: question.id, question: question.question, answer }] : [];
    })
    : [];

  return {
    runId,
    batchId,
    questions,
    answers: Object.fromEntries(questions.map((question) => [question.id, ""])),
    recovery: recoveryEntries.length ? {
      from_batch_id: previous.batchId,
      to_batch_id: batchId,
      entries: recoveryEntries
    } : null
  };
}

export function listFactoryRuns(token) {
  return dashboardRequest("/v1/creator/factory-runs", { token });
}

export function getFactoryRun(token, runId) {
  return dashboardRequest(`/v1/creator/factory-runs/${encodeURIComponent(runId)}`, { token });
}

export function createFactoryRun(token, input, idempotencyKey = crypto.randomUUID()) {
  return dashboardRequest("/v1/creator/factory-runs", {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input)
  });
}

export function submitFactoryAnswers(token, run, answers, submissionId = crypto.randomUUID()) {
  return dashboardRequest(`/v1/creator/factory-runs/${encodeURIComponent(run.id)}/answers`, {
    method: "PUT",
    token,
    body: JSON.stringify({
      expected_version: run.version,
      submission_id: submissionId,
      question_batch_id: run.question_batch_id,
      answers: run.pending_questions.map((question) => ({
        question_id: question.id,
        answer: answers[question.id] ?? ""
      }))
    })
  });
}

export function retryFactoryRun(token, run) {
  return dashboardRequest(`/v1/creator/factory-runs/${encodeURIComponent(run.id)}/retry`, {
    method: "POST",
    token,
    body: JSON.stringify({ expected_version: run.version })
  });
}
