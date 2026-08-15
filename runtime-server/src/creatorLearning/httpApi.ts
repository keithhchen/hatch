import type { Account } from "../registryAuth.js";
import { CreatorFactoryRepositoryError } from "./repository.js";
import { CreatorSourceLibraryError, SOURCE_DOCUMENT_MAX_BYTES } from "./sourceLibrary.js";
import { CreatorFactoryInputTooLargeError, type CreateFactoryRunRequest, type CreatorFactoryRunView, type CreatorFactoryService } from "./service.js";

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
  if (!request.pathname.startsWith("/v1/creator/factory-runs")
    && !request.pathname.startsWith("/v1/creator/tasks")
    && !request.pathname.startsWith("/v1/creator/source-documents")
    && !request.pathname.startsWith("/v1/creator/source-snapshots")) return undefined;
  try {
    if (request.pathname === "/v1/creator/tasks" && request.method === "GET") {
      return { status: 200, body: { tasks: (await service.listTasks(request.creator.id)).map(taskView) } };
    }
    if (request.pathname === "/v1/creator/tasks" && request.method === "POST") {
      const body = request.body ?? {};
      const task = await service.createTask(request.creator.id, {
        name: String(body.name ?? body.task_name ?? ""),
        brief: String(body.brief ?? body.task_brief ?? "")
      });
      return { status: 201, body: taskView(task) };
    }
    const taskMatch = request.pathname.match(/^\/v1\/creator\/tasks\/([^/]+)$/);
    const taskGraphMatch = request.pathname.match(/^\/v1\/creator\/tasks\/([^/]+)\/graph$/);
    if (taskGraphMatch && request.method === "GET") {
      return { status: 200, body: { graph: await service.getTaskGraph(request.creator.id, decodeURIComponent(taskGraphMatch[1]!)) } };
    }
    if (taskMatch && request.method === "GET") {
      return { status: 200, body: taskView(await service.getTask(request.creator.id, decodeURIComponent(taskMatch[1]!))) };
    }
    if (taskMatch && request.method === "DELETE") {
      return { status: 200, body: taskView(await service.deleteTask(request.creator.id, decodeURIComponent(taskMatch[1]!))) };
    }
    if (request.pathname === "/v1/creator/source-documents" && request.method === "GET") {
      const taskId = typeof request.query?.task_id === "string" ? request.query.task_id : undefined;
      return { status: 200, body: { documents: (await service.listSourceDocuments(request.creator.id, taskId)).map((document) => sourceDocumentView(document)) } };
    }
    if (request.pathname === "/v1/creator/source-documents" && request.method === "POST") {
      const body = request.body ?? {};
      const encoded = typeof body.content_base64 === "string" ? body.content_base64 : "";
      if (!encoded) throw new Error("content_base64 is required for local uploads");
      if (typeof body.task_id !== "string" || !body.task_id.trim()) {
        throw new CreatorSourceLibraryError("invalid_source", "task_id is required for Source Library uploads");
      }
      const bytes = decodeBase64(encoded);
      const document = await service.createSourceDocument(request.creator.id, {
        displayName: String(body.display_name ?? body.file_name ?? ""),
        taskId: body.task_id,
        mediaType: typeof body.media_type === "string" ? body.media_type : undefined,
        bytes
      });
      return { status: 201, body: sourceDocumentView(document, true) };
    }
    const sourceDocumentMatch = request.pathname.match(/^\/v1\/creator\/source-documents\/([^/]+)$/);
    if (sourceDocumentMatch && request.method === "GET") {
      return { status: 200, body: sourceDocumentView(await service.getSourceDocument(request.creator.id, decodeURIComponent(sourceDocumentMatch[1]!)), true) };
    }
    if (request.pathname === "/v1/creator/source-snapshots" && request.method === "POST") {
      const body = request.body ?? {};
      const documentIds = Array.isArray(body.document_ids) ? body.document_ids.map((id) => String(id)) : [];
      if (typeof body.task_id !== "string" || !body.task_id.trim()) {
        throw new CreatorSourceLibraryError("invalid_snapshot", "task_id is required to lock a Source Snapshot");
      }
      const snapshot = await service.createSourceSnapshot(request.creator.id, {
        documentIds,
        taskId: body.task_id
      });
      return { status: 201, body: sourceSnapshotView(snapshot) };
    }
    const sourceSnapshotMatch = request.pathname.match(/^\/v1\/creator\/source-snapshots\/([^/]+)$/);
    if (sourceSnapshotMatch && request.method === "GET") {
      return { status: 200, body: sourceSnapshotView(await service.getSourceSnapshot(request.creator.id, decodeURIComponent(sourceSnapshotMatch[1]!))) };
    }
    if (request.pathname === "/v1/creator/factory-runs" && request.method === "GET") {
      return { status: 200, body: { runs: (await service.list(request.creator.id)).map(publicView) } };
    }
    if (request.pathname === "/v1/creator/factory-runs" && request.method === "POST") {
      const body = request.body ?? {};
      const result = await service.create(
        { id: request.creator.id, name: request.creator.display_name },
        createRequest(body),
        request.headers["idempotency-key"] ?? ""
      );
      return { status: result.created ? 202 : 200, body: publicView(result.run) };
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

function createRequest(body: Record<string, unknown>): CreateFactoryRunRequest {
  const hasSources = Object.prototype.hasOwnProperty.call(body, "sources");
  const sources = Array.isArray(body.sources) ? body.sources.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each source must be an object");
    const source = item as Record<string, unknown>;
    return {
      id: String(source.id ?? ""),
      authority: String(source.authority ?? "") as NonNullable<CreateFactoryRunRequest["sources"]>[number]["authority"],
      title: String(source.title ?? ""),
      content: String(source.content ?? "")
    };
  }) : [];
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config)
    ? body.config as Record<string, unknown>
    : undefined;
  const product = body.product === undefined
    ? undefined
    : productRequest(requireObject(body.product, "product"));
  const productId = typeof body.product_id === "string" ? body.product_id : undefined;
  const tools = body.tools === undefined
    ? undefined
    : toolRequests(body.tools);
  return {
    ...(typeof body.task_id === "string" ? { taskId: body.task_id } : {}),
    ...(productId ? { agentId: productId } : {}),
    ...(product === undefined && !productId ? {} : {
      product: product ?? { id: productId }
    }),
    ...(tools === undefined ? {} : { tools }),
    taskName: String(body.task_name ?? ""),
    taskBrief: String(body.task_brief ?? ""),
    ...(body.source_snapshot_id === undefined
      ? (hasSources ? { sources } : {})
      : { sourceSnapshotId: String(body.source_snapshot_id) }),
    ...(body.source_document_ids === undefined ? {} : {
      sourceDocumentIds: Array.isArray(body.source_document_ids) ? body.source_document_ids.map((id) => String(id)) : []
    }),
    ...(config ? { config: {
      ...(numberField(config.development_questions) === undefined ? {} : { developmentQuestions: numberField(config.development_questions)! }),
      ...(numberField(config.heldout_questions) === undefined ? {} : { heldoutQuestions: numberField(config.heldout_questions)! }),
      ...(numberField(config.max_corpus_revisions) === undefined ? {} : { maxCorpusRevisions: numberField(config.max_corpus_revisions)! })
    } } : {})
  };
}

function sourceDocumentView(document: Awaited<ReturnType<CreatorFactoryService["getSourceDocument"]>>, includeProjection = false): Record<string, unknown> {
  return {
    id: document.id,
    task_id: document.taskId,
    display_name: document.displayName,
    media_type: document.mediaType,
    projection: {
      kind: document.projection.kind,
      media_type: document.projection.mediaType,
      content_ref: document.projection.contentRef,
      sha256: document.projection.sha256,
      bytes: document.projection.bytes,
      ...(includeProjection && document.projectionContent !== undefined ? { content: document.projectionContent } : {}),
      ...(includeProjection && document.projectionBase64 !== undefined ? { base64: document.projectionBase64 } : {})
    },
    created_at: document.createdAt,
    updated_at: document.updatedAt
  };
}

function sourceSnapshotView(snapshot: Awaited<ReturnType<CreatorFactoryService["getSourceSnapshot"]>>): Record<string, unknown> {
  return {
    id: snapshot.id,
    task_id: snapshot.taskId,
    version: snapshot.version,
    document_ids: snapshot.documentIds,
    manifest_sha256: snapshot.manifestSha256,
    locked_at: snapshot.lockedAt,
    created_at: snapshot.createdAt,
    documents: snapshot.documents.map((document) => sourceDocumentView(document))
  };
}

function taskView(task: Awaited<ReturnType<CreatorFactoryService["getTask"]>>): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    brief: task.brief,
    status: task.status,
    ...(task.productId ? { product_id: task.productId } : {}),
    ...(task.runId ? { run_id: task.runId } : {}),
    ...(task.latestRevisionId ? { latest_revision_id: task.latestRevisionId } : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    ...(task.deletedAt ? { deleted_at: task.deletedAt } : {})
  };
}

function decodeBase64(value: string): Buffer {
  if (value.length > Math.ceil(SOURCE_DOCUMENT_MAX_BYTES * 4 / 3) + 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("content_base64 is invalid or too large");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > SOURCE_DOCUMENT_MAX_BYTES) throw new Error("Uploaded source is empty or too large");
  return bytes;
}

function productRequest(body: Record<string, unknown>): NonNullable<CreateFactoryRunRequest["product"]> {
  // Preserve every supplied key so the strict service validator can reject
  // unknown release metadata instead of silently dropping it at the HTTP seam.
  return { ...body } as NonNullable<CreateFactoryRunRequest["product"]>;
}

function toolRequests(value: unknown): NonNullable<CreateFactoryRunRequest["tools"]> {
  if (!Array.isArray(value)) throw new Error("tools must be an array");
  return value.map((item, index) => ({
    ...requireObject(item, `tools[${index}]`)
  }) as NonNullable<CreateFactoryRunRequest["tools"]>[number]);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function publicView(view: CreatorFactoryRunView): Record<string, unknown> {
  return {
    id: view.id,
    ...(view.agentId ? { product_id: view.agentId } : {}),
    ...(view.product ? { product: view.product } : {}),
    ...(view.taskId ? { task_id: view.taskId } : {}),
    ...(view.distillationRunId ? { distillation_run_id: view.distillationRunId } : {}),
    ...(view.revisionId ? { revision_id: view.revisionId } : {}),
    ...(view.revisionNumber === undefined ? {} : { revision_number: view.revisionNumber }),
    ...(view.parentRevisionId ? { parent_revision_id: view.parentRevisionId } : {}),
    ...(view.sourceSnapshotId ? { source_snapshot_id: view.sourceSnapshotId } : {}),
    ...(view.derivedStatus ? { derived_status: view.derivedStatus } : {}),
    ...(view.qualityGates ? { quality_gates: view.qualityGates } : {}),
    ...(view.declaredToolIds ? { declared_tool_ids: view.declaredToolIds } : {}),
    task_name: view.taskName,
    status: view.status,
    ...(view.stage ? { stage: view.stage } : {}),
    version: view.version,
    pending_questions: view.pendingQuestions.map((item) => ({
      id: item.id,
      question: item.question,
      ...(item.intent ? { intent: item.intent } : {}),
      ...(item.kind ? { kind: item.kind } : {})
    })),
    ...(view.questionBatchId ? { question_batch_id: view.questionBatchId } : {}),
    retryable: view.retryable,
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
  if (error instanceof CreatorSourceLibraryError) {
    const status = error.code === "source_not_found" || error.code === "snapshot_not_found" ? 404
      : error.code === "creator_mismatch" ? 403
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
