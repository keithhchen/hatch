import type { Account } from "../registryAuth.js";
import { CreatorFactoryRepositoryError } from "./repository.js";
import { CreatorFactoryInputTooLargeError, type CreatorFactoryRunView, type CreatorFactoryService } from "./service.js";

export type CreatorFactoryHttpRequest = {
  method: string;
  pathname: string;
  query?: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body?: Record<string, unknown>;
  creator: Pick<Account, "id" | "display_name">;
};

export type CreatorFactoryHttpResponse = {
  status: number;
  body: unknown;
};

export async function handleCreatorFactoryHttp(
  request: CreatorFactoryHttpRequest,
  service: CreatorFactoryService
): Promise<CreatorFactoryHttpResponse | undefined> {
  // Product is the only user-facing authoring boundary. The former global
  // Source Library routes are deliberately not aliases for Product Files:
  // keeping them reachable would let callers create an unowned, generic file
  // authority beside the Product-scoped store.
  if (request.pathname.startsWith("/v1/creator/source-documents")
    || request.pathname.startsWith("/v1/creator/source-snapshots")) {
    return {
      status: 404,
      body: { detail: "Product-scoped Files and Snapshots must be addressed below /v1/creator/products/:product_id." }
    };
  }
  // A run is a Product Version execution, not a user-owned global resource.
  // Keep the existing child action transport (answers/review/retry) for the
  // current workspace, but do not expose a global list/create entry point.
  if (request.pathname === "/v1/creator/factory-runs") {
    return {
      status: 404,
      body: { detail: "Factory Versions must be created and listed below /v1/creator/products/:product_id." }
    };
  }
  if (!request.pathname.startsWith("/v1/creator/factory-runs")
    && !request.pathname.startsWith("/v1/creator/products")) return undefined;
  try {
    if (request.pathname === "/v1/creator/products" && request.method === "GET") {
      return { status: 200, body: { products: (await service.listProducts(request.creator.id)).map(productView) } };
    }
    if (request.pathname === "/v1/creator/products" && request.method === "POST") {
      const body = request.body ?? {};
      const product = await service.createProduct(request.creator.id, {
        name: String(body.name ?? body.product_name ?? ""),
        promise: String(body.promise ?? body.product_promise ?? body.description ?? ""),
        idempotencyKey: request.headers["idempotency-key"]
      });
      return { status: 201, body: productView(product) };
    }
    const productMatch = request.pathname.match(/^\/v1\/creator\/products\/([^/]+)$/);
    const productGraphMatch = request.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/graph$/);
    if (productGraphMatch && request.method === "GET") {
      return { status: 200, body: { graph: await service.getProductGraph(request.creator.id, decodeURIComponent(productGraphMatch[1]!)) } };
    }
    if (productMatch && request.method === "GET") {
      return { status: 200, body: productView(await service.getProduct(request.creator.id, decodeURIComponent(productMatch[1]!))) };
    }
    if (productMatch && (request.method === "PATCH" || request.method === "PUT")) {
      const body = request.body ?? {};
      const promise = typeof body.promise === "string" ? body.promise : body.product_promise;
      if (typeof promise !== "string" || !promise.trim()) throw new Error("promise is required");
      return { status: 200, body: productView(await service.updateProductPromise(
        request.creator.id,
        decodeURIComponent(productMatch[1]!),
        promise,
        typeof body.expected_updated_at === "string" ? body.expected_updated_at : undefined
      )) };
    }
    if (productMatch && request.method === "DELETE") {
      return { status: 200, body: productView(await service.deleteProduct(request.creator.id, decodeURIComponent(productMatch[1]!))) };
    }
    const answerDraftMatch = request.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/answer-draft$/);
    if (answerDraftMatch && (request.method === "PUT" || request.method === "PATCH")) {
      const body = request.body ?? {};
      if (typeof body.question_batch_id !== "string" || !body.question_batch_id.trim()) {
        throw new Error("question_batch_id is required for Creator answer drafts");
      }
      const answers = Array.isArray(body.answers) ? body.answers.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each Creator answer draft must be an object");
        const row = item as Record<string, unknown>;
        return { questionId: String(row.question_id ?? ""), answer: String(row.answer ?? "") };
      }) : [];
      const view = await service.saveAnswerDraft(request.creator.id, decodeURIComponent(answerDraftMatch[1]!), {
        answers: { answers, questionBatchId: body.question_batch_id },
        ...(numberField(body.expected_version) === undefined ? {} : { expectedVersion: numberField(body.expected_version)! })
      });
      return { status: 200, body: publicView(view) };
    }

    const answersMatch = request.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/answers$/);
    if (answersMatch && (request.method === "PUT" || request.method === "POST")) {
      const body = request.body ?? {};
      if (typeof body.question_batch_id !== "string" || !body.question_batch_id.trim()) {
        throw new Error("question_batch_id is required for Creator answers");
      }
      const answers = Array.isArray(body.answers) ? body.answers.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each Creator answer must be an object");
        const row = item as Record<string, unknown>;
        return { questionId: String(row.question_id ?? ""), answer: String(row.answer ?? "") };
      }) : [];
      const view = await service.submitAnswers(request.creator.id, decodeURIComponent(answersMatch[1]!), {
        answers,
        ...(numberField(body.expected_version) === undefined ? {} : { expectedVersion: numberField(body.expected_version)! }),
        ...(typeof body.submission_id === "string" ? { submissionId: body.submission_id } : {}),
        questionBatchId: body.question_batch_id
      });
      return { status: 202, body: publicView(view) };
    }

    const retryMatch = request.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/retry$/);
    if (retryMatch && request.method === "POST") {
      const body = request.body ?? {};
      const view = await service.retry(
        request.creator.id,
        decodeURIComponent(retryMatch[1]!),
        numberField(body.expected_version)
      );
      return { status: 202, body: publicView(view) };
    }

    const reviewMatch = request.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/review$/);
    if (reviewMatch && request.method === "GET") {
      return { status: 200, body: reviewView(await service.getReview(request.creator.id, decodeURIComponent(reviewMatch[1]!))) };
    }
    if (reviewMatch && (request.method === "POST" || request.method === "PUT")) {
      const body = request.body ?? {};
      const action = typeof body.action === "string" ? body.action : "";
      if (!action) throw new Error("action is required for Creator Review");
      const idempotencyKey = request.headers["idempotency-key"] ?? "";
      const result = await service.review(
        request.creator.id,
        decodeURIComponent(reviewMatch[1]!),
        {
          action: action as import("./service.js").CreatorReviewAction,
          ...(typeof body.case_id === "string" ? { caseId: body.case_id } : {}),
          candidateDigest: typeof body.candidate_digest === "string" ? body.candidate_digest : "",
          ...(typeof body.case_digest === "string" ? { caseDigest: body.case_digest } : {}),
          ...(numberField(body.expected_version) === undefined ? {} : { expectedVersion: numberField(body.expected_version)! }),
          ...(typeof body.correction === "string" ? { correction: body.correction } : {}),
          ...(typeof body.why === "string" ? { why: body.why } : {})
        },
        idempotencyKey
      );
      return { status: result.nextRun ? 202 : 200, body: {
        review: reviewView(result.review),
        ...(result.nextRun ? { next_run: publicView(result.nextRun) } : {})
      } };
    }

    const releaseMatch = request.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)\/release$/);
    if (releaseMatch && request.method === "POST") {
      const body = request.body ?? {};
      const productId = typeof body.product_id === "string" ? body.product_id.trim() : "";
      if (!productId) throw new Error("product_id is required for Release");
      const release = await service.recordRelease(
        request.creator.id,
        decodeURIComponent(releaseMatch[1]!),
        productId
      );
      return { status: 201, body: { release } };
    }

    const runMatch = request.pathname.match(/^\/v1\/creator\/factory-runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      return {
        status: 200,
        body: publicView(await service.get(request.creator.id, decodeURIComponent(runMatch[1]!)))
      };
    }
    return { status: 404, body: { detail: "Creator Factory route not found." } };
  } catch (error) {
    return factoryHttpError(error);
  }
}

function productView(product: Awaited<ReturnType<CreatorFactoryService["getProduct"]>>): Record<string, unknown> {
  return {
    id: product.id,
    product_id: product.id,
    name: product.name,
    promise: product.promise,
    ...(product.briefSpec ? { brief_spec: product.briefSpec } : {}),
    status: product.status,
    ...(product.runId ? { run_id: product.runId } : {}),
    ...(product.latestRevisionId ? { latest_revision_id: product.latestRevisionId } : {}),
    created_at: product.createdAt,
    updated_at: product.updatedAt,
    ...(product.deletedAt ? { deleted_at: product.deletedAt } : {})
  };
}

function publicView(view: CreatorFactoryRunView): Record<string, unknown> {
  // Product.id is the sole public identity. `agentId` remains an internal
  // runtime alias for old runs, so choose it only when the canonical field is
  // absent and emit one stable product_id key at the HTTP boundary.
  const productId = view.productId ?? view.agentId;
  return {
    id: view.id,
    ...(productId ? { product_id: productId } : {}),
    ...(view.product ? { product: view.product } : {}),
    ...(view.distillationRunId ? { distillation_run_id: view.distillationRunId } : {}),
    ...(view.revisionId ? { revision_id: view.revisionId } : {}),
    ...(view.revisionNumber === undefined ? {} : { revision_number: view.revisionNumber }),
    ...(view.parentRevisionId ? { parent_revision_id: view.parentRevisionId } : {}),
    ...(view.sourceSnapshotId ? { source_snapshot_id: view.sourceSnapshotId } : {}),
    ...(view.derivedStatus ? { derived_status: view.derivedStatus } : {}),
    ...(view.qualityGates ? { quality_gates: view.qualityGates } : {}),
    ...(view.declaredToolIds ? { declared_tool_ids: view.declaredToolIds } : {}),
    product_name: view.productName,
    product_promise: view.productPromise,
    status: view.status,
    ...(view.stage ? { stage: view.stage } : {}),
    workflow_step: view.workflowStep,
    version: view.version,
    pending_questions: view.pendingQuestions.map((item) => ({
      id: item.id,
      question: item.question,
      ...(item.intent ? { intent: item.intent } : {}),
      ...(item.kind ? { kind: item.kind } : {})
    })),
      ...(view.questionBatchId ? { question_batch_id: view.questionBatchId } : {}),
    ...(view.answerDrafts ? { answer_drafts: view.answerDrafts.map((item) => ({ question_id: item.questionId, answer: item.answer })) } : {}),
    retryable: view.retryable,
    ...(view.retryStage ? { retry_stage: view.retryStage } : {}),
    ...(view.candidate ? { candidate: {
      version: view.candidate.version,
      reason: view.candidate.reason,
      system_digest: view.candidate.systemDigest,
      ...(view.candidate.corpusDigest ? { corpus_digest: view.candidate.corpusDigest } : {}),
      corpus_verified: view.candidate.corpusVerified,
      factory_version: view.candidate.factoryVersion,
      ...(view.candidate.reportDigest ? { report_digest: view.candidate.reportDigest } : {}),
      ...(view.candidate.regressionDigest ? { regression_digest: view.candidate.regressionDigest } : {}),
      ...(view.candidate.heldOutDigest ? { held_out_digest: view.candidate.heldOutDigest } : {}),
      ...(view.candidate.heldOutSampleCount === undefined ? {} : { held_out_sample_count: view.candidate.heldOutSampleCount }),
      ...(view.candidate.failedCriticalCases === undefined ? {} : { failed_critical_cases: view.candidate.failedCriticalCases }),
      ...(view.candidate.builtAt ? { built_at: view.candidate.builtAt } : {})
    } } : {}),
    ...(view.lastError ? { last_error: view.lastError } : {}),
    created_at: view.createdAt,
    updated_at: view.updatedAt
  };
}

function reviewView(value: Awaited<ReturnType<CreatorFactoryService["getReview"]>>): Record<string, unknown> {
  return {
    run_id: value.runId,
    revision_id: value.revisionId,
    version: value.version,
    candidate_digest: value.candidateDigest,
    candidate_version: value.candidateVersion,
    corpus: {
      available: value.corpus.available,
      version: value.corpus.version,
      ...(value.corpus.digest ? { digest: value.corpus.digest } : {}),
      ...(value.corpus.verifiedAt ? { verified_at: value.corpus.verifiedAt } : {}),
      assets: value.corpus.assets.map((asset) => ({
        id: asset.id,
        layer: asset.layer,
        path: asset.path,
        sha256: asset.sha256,
        content: asset.content,
        ...(asset.parentSkillId ? { parent_skill_id: asset.parentSkillId } : {}),
        ...(asset.kind ? { kind: asset.kind } : {})
      })),
      evaluation_assets: {
        included: value.corpus.evaluationAssets.included,
        sealed: value.corpus.evaluationAssets.sealed,
        note: value.corpus.evaluationAssets.note
      },
      ...(value.corpus.reason ? { reason: value.corpus.reason } : {})
    },
    cases: value.cases.map((item) => ({
      id: item.id,
      set: item.set,
      question: item.question,
      creator_reference: item.creatorReference,
      candidate_output: item.candidateOutput,
      verdict: item.verdict,
      diagnosis: item.diagnosis,
      case_digest: item.caseDigest,
      candidate_digest: item.candidateDigest,
      status: item.status,
      ...(item.reviewAction ? { review_action: item.reviewAction } : {})
    })),
    blind: {
      sealed: true,
      total: value.blind.total,
      passed: value.blind.passed,
      failed: value.blind.failed,
      needs_creator_action: value.blind.needsCreatorAction
    },
    unresolved_count: value.unresolvedCount,
    correction_count: value.correctionCount,
    rerun_ready: value.rerunReady,
    release_ready: value.releaseReady
  };
}

function factoryHttpError(error: unknown): CreatorFactoryHttpResponse {
  if (error instanceof CreatorFactoryInputTooLargeError) {
    return { status: 413, body: { detail: error.message, code: "factory_input_too_large" } };
  }
  if (error instanceof CreatorFactoryRepositoryError) {
    const status = error.code === "run_not_found" ? 404
      : error.code === "creator_mismatch" ? 403
        : ["idempotency_conflict", "version_conflict", "invalid_status", "invalid_stage"].includes(error.code) ? 409
          : 422;
    return { status, body: { detail: error.message, code: error.code } };
  }
  return { status: 422, body: { detail: error instanceof Error ? error.message : String(error) } };
}

function numberField(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("Expected an integer field");
  return value;
}
