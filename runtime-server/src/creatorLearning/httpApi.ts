import type { Account } from "../registryAuth.js";
import { CreatorFactoryRepositoryError } from "./repository.js";
import { CreatorFactoryInputTooLargeError, type CreateFactoryRunRequest, type CreatorFactoryRunView, type CreatorFactoryService } from "./service.js";

export type CreatorFactoryHttpRequest = {
  method: string;
  pathname: string;
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
  if (!request.pathname.startsWith("/v1/creator/factory-runs")) return undefined;
  try {
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
  const sources = Array.isArray(body.sources) ? body.sources.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each source must be an object");
    const source = item as Record<string, unknown>;
    return {
      id: String(source.id ?? ""),
      authority: String(source.authority ?? "") as CreateFactoryRunRequest["sources"][number]["authority"],
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
  const tools = body.tools === undefined
    ? undefined
    : toolRequests(body.tools);
  return {
    ...(typeof body.agent_id === "string" ? { agentId: body.agent_id } : {}),
    ...(product === undefined ? {} : { product }),
    ...(tools === undefined ? {} : { tools }),
    taskName: String(body.task_name ?? ""),
    taskBrief: String(body.task_brief ?? ""),
    sources,
    ...(config ? { config: {
      ...(numberField(config.development_questions) === undefined ? {} : { developmentQuestions: numberField(config.development_questions)! }),
      ...(numberField(config.heldout_questions) === undefined ? {} : { heldoutQuestions: numberField(config.heldout_questions)! }),
      ...(numberField(config.max_corpus_revisions) === undefined ? {} : { maxCorpusRevisions: numberField(config.max_corpus_revisions)! })
    } } : {})
  };
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
    ...(view.agentId ? { agent_id: view.agentId } : {}),
    ...(view.product ? { product: view.product } : {}),
    ...(view.declaredToolIds ? { declared_tool_ids: view.declaredToolIds } : {}),
    task_name: view.taskName,
    status: view.status,
    ...(view.stage ? { stage: view.stage } : {}),
    version: view.version,
    pending_questions: view.pendingQuestions.map((item) => ({ id: item.id, question: item.question })),
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
