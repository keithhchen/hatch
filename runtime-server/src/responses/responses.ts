import { randomUUID } from "node:crypto";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import type { AuthIdentityResolver } from "../entitlements.js";
import { submitUserMessage, type ChatEdge } from "../chat/turnSubmission.js";
import type { RuntimeStore } from "../store.js";
import type { ApiCaller } from "./auth.js";
import type { InlineAttachments } from "./attachments.js";
import type { ConversationsApi } from "./conversations.js";
import { invalidRequest, notFound, unsupported } from "./errors.js";
import { isTerminal, runIdOf, type Json } from "./mapping.js";
import { modelIdOf, productIdOf, type ModelCatalog } from "./models.js";
import { parseCreateResponse, type ApprovalAnswer, type CreateResponseRequest } from "./request.js";
import type { RunViews } from "./runs.js";

/** How long a plain request waits for its response to finish before answering `in_progress` (under the proxy's 100 s). */
export const HOLD_MS = 90_000;

/** What to send back: a JSON body, or the stream of a Run. The transport writes it. */
export type Delivery =
  | { kind: "json"; status: number; body: Json }
  | { kind: "stream"; conversation: ConversationRecord; run: ConversationRunRecord; includeToolCalls: boolean; afterCursor: number; startingAfter?: number };

const MAX_KEY = 256;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The OpenAI Responses API over the chat domain. A response is a Run of a conversation; every rule of what a Run may do is the domain's. */
export class ResponsesApi {
  constructor(private readonly deps: {
    repository: ConversationRepository;
    store: RuntimeStore;
    edge: ChatEdge;
    catalog: ModelCatalog;
    conversations: ConversationsApi;
    attachments: InlineAttachments;
    views: RunViews;
    /** Verifies a session; the cached one, so a burst of turns asks the Registry once. */
    identities?: AuthIdentityResolver;
    holdMs?: number;
  }) {}

  async create(caller: ApiCaller, body: Record<string, unknown>, idempotencyKey: string | undefined, signal?: AbortSignal): Promise<Delivery> {
    const { repository, edge, catalog } = this.deps;
    const request = parseCreateResponse(body);
    if (idempotencyKey && idempotencyKey.length > MAX_KEY) throw invalidRequest("invalid_request", "Idempotency-Key is limited to 256 characters.");
    const conversation = await this.conversationOf(caller, request, idempotencyKey, signal);
    const binding = await catalog.bind(caller, modelIdOf(conversation.productId), signal);
    const cursor = (await repository.recoverySnapshot(conversation.id, [])).cursor;
    const run = request.approvals.length
      ? await this.answer(conversation, request.approvals)
      : await this.submit(caller, request, conversation, binding, idempotencyKey, signal);
    return this.deliver(conversation, run, request, cursor, signal);
  }

  async get(caller: ApiCaller, responseId: string, query: URLSearchParams): Promise<Delivery> {
    const { conversation, run } = await this.find(caller, responseId);
    const includeToolCalls = [...query.getAll("include[]"), ...query.getAll("include")].includes("hatch.tool_calls");
    if (query.get("stream") === "true") {
      const startingAfter = query.get("starting_after");
      return {
        kind: "stream", conversation, run, includeToolCalls,
        afterCursor: (await this.deps.repository.recoverySnapshot(conversation.id, [])).cursor,
        ...(startingAfter !== null && Number.isInteger(Number(startingAfter)) ? { startingAfter: Number(startingAfter) } : {})
      };
    }
    return { kind: "json", status: 200, body: await this.deps.views.response(conversation, run, includeToolCalls) };
  }

  /** Stops the Run. One that has already ended is simply returned as it is. */
  async cancel(caller: ApiCaller, responseId: string): Promise<Json> {
    const { conversation, run } = await this.find(caller, responseId);
    if (!isTerminal(run.status)) await this.deps.edge.chat.cancel(conversation.id, run.id, "Cancelled by the API caller");
    const latest = await this.deps.repository.getRun(conversation.id, run.id) ?? run;
    return this.deps.views.response(conversation, latest, false);
  }

  async inputItems(caller: ApiCaller, responseId: string): Promise<Json> {
    const { conversation, run } = await this.find(caller, responseId);
    const item = await this.deps.views.userItems(conversation);
    const data = (await this.deps.store.readVisibleConversation(conversation.id))
      .filter((message) => message.role === "user" && message.run_id === run.id).map(item);
    return { object: "list", data, first_id: (data[0]?.id as string | undefined) ?? null, last_id: (data.at(-1)?.id as string | undefined) ?? null, has_more: false };
  }

  /** The response's Run and its conversation, for the account that owns them: any other id is not found. */
  private async find(caller: ApiCaller, responseId: string): Promise<{ conversation: ConversationRecord; run: ConversationRunRecord }> {
    const missing = () => notFound("response_not_found", `No response with id \`${responseId.slice(0, 80)}\`.`);
    const runId = runIdOf(responseId);
    const run = runId ? await this.deps.repository.findRun(runId) : undefined;
    const conversation = run ? await this.deps.repository.getConversation(run.conversationId) : undefined;
    if (!run || !conversation || conversation.ownerAccountId !== caller.accountId || conversation.creatorId !== caller.accountId) throw missing();
    return { conversation, run };
  }

  /** Where the request goes: the conversation it names, the one `previous_response_id` belongs to, or a new one for `model`. */
  private async conversationOf(caller: ApiCaller, request: CreateResponseRequest, idempotencyKey: string | undefined, signal?: AbortSignal): Promise<ConversationRecord> {
    const { repository, conversations } = this.deps;
    let conversation: ConversationRecord | undefined;
    if (request.previousResponseId) {
      const found = await this.find(caller, request.previousResponseId);
      conversation = found.conversation;
      // Conversations are linear: only the latest response may be continued, except by a retry of the request that made it.
      const retry = idempotencyKey ? await repository.getRunByClientMessageId(conversation.id, idempotencyKey) : undefined;
      if (!retry && (await repository.listRuns(conversation.id)).at(-1)?.id !== found.run.id) {
        throw invalidRequest("invalid_request", "previous_response_id must be the latest response of its conversation: conversations are linear.", "previous_response_id");
      }
    } else if (request.conversationId) {
      conversation = await conversations.resolve(caller, request.conversationId);
    }
    if (!conversation) {
      if (!request.model) throw invalidRequest("invalid_request", "model is required when no conversation is given.", "model");
      return conversations.start(caller, request.model, request.taskBrief, undefined, idempotencyKey, signal);
    }
    if (request.model) {
      const product = productIdOf(request.model);
      if (!product) throw notFound("model_not_found", `The model \`${request.model.slice(0, 80)}\` does not exist or you do not have access to it.`);
      if (product !== conversation.productId) throw invalidRequest("model_conversation_mismatch", "model is not the model of this conversation.", "model");
    }
    if (request.taskBrief !== undefined) throw unsupported("task_brief", "task_brief is given when the conversation is created.");
    return conversation;
  }

  /** The input as a message of the conversation: it starts a Run or is refused as busy, never joins one. */
  private async submit(
    caller: ApiCaller, request: CreateResponseRequest, conversation: ConversationRecord,
    binding: Awaited<ReturnType<ModelCatalog["bind"]>>, idempotencyKey: string | undefined, signal?: AbortSignal
  ): Promise<ConversationRunRecord> {
    const { repository, edge } = this.deps;
    // An empty input starts the task from its Brief, once: the conversation has one and nothing has run in it.
    const taskStart = request.parts.length === 0;
    if (taskStart && !(conversation.briefSnapshot && (await repository.listRuns(conversation.id)).length === 0)) {
      throw invalidRequest("empty_input", "input is empty. Send a message, or start a conversation that has a Task Brief with an empty input.", "input");
    }
    const clientMessageId = idempotencyKey ?? `msg_${randomUUID().replaceAll("-", "")}`;
    const prepared = taskStart ? undefined
      : await edge.parts.prepare(await this.deps.attachments.contentParts(request.parts, conversation, signal), conversation, clientMessageId);
    const { submission } = await submitUserMessage(
      { ...edge, ...(this.deps.identities ? { authIdentityResolver: this.deps.identities } : {}) },
      { authToken: caller.token, binding, conversation },
      {
        runId: `run_${randomUUID().replaceAll("-", "")}`, clientMessageId,
        ...(prepared ? { prepared } : {}), message: { role: "user", content: "" },
        taskStart, client: { client: "mcp" }, mode: "start_only"
      },
      signal
    );
    return submission.run;
  }

  /** The caller's answers to the tools that asked for approval. Approving needs a machine to run the tool on; this API has none. */
  private async answer(conversation: ConversationRecord, answers: readonly ApprovalAnswer[]): Promise<ConversationRunRecord> {
    const { edge, repository } = this.deps;
    const pending = await edge.chat.pendingToolRequests(conversation.id);
    let runId: string | undefined;
    for (const answer of answers) {
      const request = pending.find((entry) => entry.tool_call_id === answer.requestId);
      if (!request) throw invalidRequest("invalid_request", `No approval is pending for \`${answer.requestId.slice(0, 80)}\`.`, `${answer.param}.approval_request_id`);
      if (answer.approve) throw unsupported(`${answer.param}.approve`, "A tool that needs approval runs on the caller's machine, which this API does not have: only denying is supported.");
      const outcome = await edge.chat.answerTool(conversation.id, {
        type: "tool_call.result", run_id: request.run_id, tool_call_id: request.tool_call_id, status: "error",
        error: { code: "approval_denied", message: answer.reason ?? "The caller denied this tool call." }
      }, "mcp");
      if (outcome.outcome !== "accepted") throw invalidRequest(outcome.error.code, outcome.error.message, `${answer.param}.approval_request_id`);
      runId = request.run_id;
    }
    return (await repository.getRun(conversation.id, runId!))!;
  }

  private async deliver(conversation: ConversationRecord, run: ConversationRunRecord, request: CreateResponseRequest, afterCursor: number, signal?: AbortSignal): Promise<Delivery> {
    const { repository, views } = this.deps;
    if (request.stream) return { kind: "stream", conversation, run, includeToolCalls: request.includeToolCalls, afterCursor };
    const hold = request.background ? 0 : this.deps.holdMs ?? HOLD_MS;
    const deadline = Date.now() + hold;
    let latest = run;
    // Wait for the Run to end, or to ask for approval, but never past the hold: then it is answered as in progress.
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      latest = await repository.getRun(conversation.id, run.id) ?? latest;
      if (isTerminal(latest.status) || (latest.status === "waiting_for_tool" && (await views.view(conversation, latest, false)).approvals.length)) break;
      await sleep(100);
    }
    return { kind: "json", status: 200, body: await views.response(conversation, latest, request.includeToolCalls) };
  }
}
