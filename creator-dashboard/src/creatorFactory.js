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

// Product is the only public owner. A version is a read projection of a
// Product-scoped run; callers should not need a global Factory listing to
// render the Product workflow.
export function listProductVersions(token, productId) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/versions`, { token });
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

export function listProducts(token) {
  return dashboardRequest("/v1/creator/products", { token });
}

export function createProduct(token, input) {
  return dashboardRequest("/v1/creator/products", {
    method: "POST",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ name: input.name, promise: input.promise })
  });
}

export function getProduct(token, productId) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}`, { token });
}

export function updateProductPromise(token, product, promise) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(product.id ?? product.product_id)}`, {
    method: "PATCH",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ promise, expected_updated_at: product.updated_at })
  });
}

export function saveProductBriefSpec(token, product, briefSpec) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(product.id ?? product.product_id)}/brief-spec`, {
    method: "PUT",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ brief_spec: briefSpec, expected_updated_at: product.updated_at })
  });
}

export function listProductFiles(token, productId) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/files`, { token });
}

export function deleteProductFile(token, productId, fileId) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    token
  });
}

export function uploadProductFile(token, productId, file) {
  return file.arrayBuffer().then((bytes) => {
    return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/files`, {
      method: "POST",
      token,
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
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

export function startFactoryRunFromSources(token, product, documentIds) {
  const productId = product.id ?? product.product_id;
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/runs`, {
    method: "POST",
    token,
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      file_ids: documentIds
    })
  });
}

export function startAboutYouNode(token, productId, fileIds, executionId, idempotencyKey = crypto.randomUUID()) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/nodes/about-you/executions`, {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      file_ids: fileIds,
      ...(executionId ? { execution_id: executionId } : {})
    })
  });
}

export function getNodeExecution(token, productId, node, executionId) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/nodes/${encodeURIComponent(node)}/executions/${encodeURIComponent(executionId)}`, { token });
}

export function getLatestNodeExecution(token, productId, node) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/nodes/${encodeURIComponent(node)}/executions`, { token });
}

export function saveAboutYouNodeAnswers(token, productId, executionId, answers, idempotencyKey = crypto.randomUUID()) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/nodes/about-you/executions/${encodeURIComponent(executionId)}/answers`, {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({ answers })
  });
}

export function startCorpusNode(token, productId, fileIds, aboutYouRef, executionId, idempotencyKey = crypto.randomUUID()) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/nodes/corpus/executions`, {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify({
      file_ids: fileIds,
      about_you_ref: aboutYouRef,
      ...(executionId ? { execution_id: executionId } : {})
    })
  });
}

export function publishCorpusToRegistry(token, productId, input, idempotencyKey = crypto.randomUUID()) {
  return dashboardRequest(`/v1/creator/products/${encodeURIComponent(productId)}/registry`, {
    method: "POST",
    token,
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(input)
  });
}
