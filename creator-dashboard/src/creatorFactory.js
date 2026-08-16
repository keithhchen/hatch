import { dashboardRequest } from "./data.js";

export const FACTORY_STAGE_LABELS = {
  extracting_evidence: "Extracting evidence",
  awaiting_creator_answers: "Waiting for your answers",
  compiling_corpus: "Compiling the Corpus",
  evaluating_development: "Checking development cases",
  evaluating_regression: "Running regression",
  evaluating_heldout: "Running sealed held-out cases",
  review_required: "Needs your correction",
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
  if (run?.stage === "review_required") return undefined;
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

export function saveFactoryAnswerDraft(token, run, answers) {
  return dashboardRequest(`/v1/creator/factory-runs/${encodeURIComponent(run.id)}/answer-draft`, {
    method: "PUT",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      expected_version: run.version,
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

export function getFactoryReview(token, runId, request = dashboardRequest) {
  return request(`/v1/creator/factory-runs/${encodeURIComponent(runId)}/review`, { token });
}

export function submitFactoryReview(token, run, input, idempotencyKey = crypto.randomUUID(), request = dashboardRequest) {
  return request(`/v1/creator/factory-runs/${encodeURIComponent(run.id)}/review`, {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      action: input.action,
      candidate_digest: input.candidateDigest,
      ...(input.caseId ? { case_id: input.caseId } : {}),
      ...(input.caseDigest ? { case_digest: input.caseDigest } : {}),
      ...(run.version === undefined ? {} : { expected_version: run.version }),
      ...(input.correction ? { correction: input.correction } : {}),
      ...(input.why ? { why: input.why } : {})
    })
  });
}

export function listDistillationTasks(token) {
  return dashboardRequest("/v1/creator/tasks", { token });
}

export function createDistillationTask(token, input) {
  return dashboardRequest("/v1/creator/tasks", {
    method: "POST",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ name: input.name, brief: input.brief })
  });
}

export function getDistillationTask(token, taskId) {
  return dashboardRequest(`/v1/creator/tasks/${encodeURIComponent(taskId)}`, { token });
}

export function updateTaskBrief(token, task, brief) {
  return dashboardRequest(`/v1/creator/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ brief, expected_updated_at: task.updated_at })
  });
}

export function listSourceDocuments(token, taskId) {
  const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : "";
  return dashboardRequest(`/v1/creator/source-documents${query}`, { token });
}

export function uploadSourceDocument(token, taskId, file) {
  return file.arrayBuffer().then((bytes) => {
    return dashboardRequest("/v1/creator/source-documents", {
      method: "POST",
      token,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        task_id: taskId,
        display_name: file.name,
        media_type: file.type || undefined,
        content_base64: bytesToBase64(bytes)
      })
    });
  });
}

function bytesToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function startFactoryRunFromSources(token, task, documentIds) {
  return dashboardRequest("/v1/creator/factory-runs", {
    method: "POST",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      task_id: task.id,
      task_name: task.name,
      task_brief: task.brief,
      // Carry the Task promise into the Product contract and make the
      // default safety boundary explicit. Presentation and voice
      // configuration stay out of this workflow; a Creator can still provide
      // a richer Product contract through the provider-neutral Factory API.
      product: {
        name: task.name,
        description: task.brief,
        promise: task.brief,
        boundaries: ["Stay within the Task promise and the files attached to this Task; do not invent unsupported facts."]
      },
      source_document_ids: documentIds
    })
  });
}
