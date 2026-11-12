import { randomUUID } from "node:crypto";
import { conversationBinding, durableConversationId } from "../chat/sessionBinding.js";
import { listCursorAfter, type ConversationRecord, type ConversationRepository } from "../conversationRepository.js";
import type { RuntimeStore } from "../store.js";
import type { ApiCaller } from "./auth.js";
import { invalidRequest, notFound, unsupported } from "./errors.js";
import { conversationItems, conversationObject, type Json } from "./mapping.js";
import { ModelCatalog, productIdOf } from "./models.js";
import type { RunViews } from "./runs.js";
import { taskBriefSnapshot } from "./taskBrief.js";

const MAX_KEY = 256;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A page size: 1 to `max`, else `fallback`. */
export function pageSize(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) throw invalidRequest("invalid_request", `limit must be an integer between 1 and ${max}.`, "limit");
  return value;
}

/** `metadata` carries the conversation's title and nothing else: the domain keeps no other metadata. */
function titleOf(metadata: unknown): string | null | undefined {
  if (metadata === undefined) return undefined;
  if (!isRecord(metadata)) throw invalidRequest("invalid_request", "metadata must be an object.", "metadata");
  for (const key of Object.keys(metadata)) if (key !== "title") throw unsupported(`metadata.${key}`, "Only metadata.title is supported: it names the conversation.");
  if (metadata.title === undefined) return undefined;
  if (metadata.title === null || metadata.title === "") return null;
  if (typeof metadata.title !== "string" || metadata.title.length > 500) throw invalidRequest("invalid_request", "metadata.title must be a string of at most 500 characters.", "metadata.title");
  return metadata.title;
}

/** The OpenAI Conversations API over the chat domain: a conversation is the domain's, scoped to the account that owns it. */
export class ConversationsApi {
  constructor(private readonly deps: { repository: ConversationRepository; store: RuntimeStore; catalog: ModelCatalog; views: RunViews }) {}

  /** The caller's conversation by the id its client holds; no Product needs to be named. */
  async resolve(caller: ApiCaller, publicId: string): Promise<ConversationRecord> {
    const conversation = await this.deps.repository.findOwnedConversation({ ownerAccountId: caller.accountId, creatorId: caller.accountId }, publicId);
    if (!conversation) throw notFound("conversation_not_found", `No conversation with id \`${publicId.slice(0, 80)}\`.`);
    return conversation;
  }

  async create(caller: ApiCaller, body: Record<string, unknown>, idempotencyKey: string | undefined, signal?: AbortSignal): Promise<Json> {
    for (const key of Object.keys(body)) if (!["model", "metadata", "task_brief", "items"].includes(key)) throw invalidRequest("unknown_parameter", `Unknown parameter: '${key}'.`, key);
    if (Array.isArray(body.items) ? body.items.length > 0 : body.items !== undefined && body.items !== null) throw unsupported("items", "Initial items are not supported: start the conversation with a response.");
    if (typeof body.model !== "string") throw invalidRequest("invalid_request", "model is required.", "model");
    const title = titleOf(body.metadata);
    const conversation = await this.start(caller, body.model, body.task_brief, title ?? undefined, idempotencyKey, signal);
    return conversationObject(conversation);
  }

  /** A new conversation with one of the caller's Products. The same `idempotencyKey` is the same conversation. */
  async start(caller: ApiCaller, model: string, taskBrief: unknown, title: string | undefined, idempotencyKey: string | undefined, signal?: AbortSignal): Promise<ConversationRecord> {
    if (idempotencyKey && idempotencyKey.length > MAX_KEY - 4) throw invalidRequest("invalid_request", "Idempotency-Key is limited to 252 characters.");
    const binding = await this.deps.catalog.bind(caller, model, signal);
    const briefSnapshot = taskBriefSnapshot(binding.briefSpec, taskBrief);
    const publicId = `conv_${randomUUID().replaceAll("-", "")}`;
    const created = await this.deps.repository.createConversation({
      ...conversationBinding(binding),
      id: durableConversationId(binding, publicId), publicId,
      ...(title ? { title } : {}),
      ...(idempotencyKey ? { clientRequestId: `api:${idempotencyKey}` } : {}),
      ...(briefSnapshot ? { briefSnapshot } : {})
    });
    return created.conversation;
  }

  async get(caller: ApiCaller, publicId: string): Promise<Json> {
    return conversationObject(await this.resolve(caller, publicId));
  }

  async update(caller: ApiCaller, publicId: string, body: Record<string, unknown>): Promise<Json> {
    for (const key of Object.keys(body)) if (key !== "metadata") throw invalidRequest("unknown_parameter", `Unknown parameter: '${key}'.`, key);
    const title = titleOf(body.metadata);
    if (title === undefined) throw invalidRequest("invalid_request", "metadata.title is required.", "metadata");
    const conversation = await this.resolve(caller, publicId);
    return conversationObject(await this.deps.repository.updateConversation(conversation.id, { title }));
  }

  /** Deleting archives: the conversation leaves the list and takes no more responses, its record stays. */
  async archive(caller: ApiCaller, publicId: string): Promise<Json> {
    const conversation = await this.resolve(caller, publicId);
    await this.deps.repository.updateConversation(conversation.id, { status: "archived" });
    return { id: conversation.publicId, object: "conversation.deleted", deleted: true };
  }

  async list(caller: ApiCaller, query: URLSearchParams): Promise<Json> {
    const model = query.get("model");
    const productId = model ? productIdOf(model) : undefined;
    if (model && !productId) throw notFound("model_not_found", `The model \`${model.slice(0, 80)}\` does not exist or you do not have access to it.`);
    const limit = pageSize(query.get("limit"), 20, 100);
    const after = query.get("after");
    const cursor = after ? listCursorAfter(await this.resolve(caller, after)) : undefined;
    const page = await this.deps.repository.listConversations(
      { ownerAccountId: caller.accountId, creatorId: caller.accountId, ...(productId ? { agentId: productId } : {}) },
      { status: "active", limit, ...(cursor ? { cursor } : {}) }
    );
    const data = page.conversations.map(conversationObject);
    return { object: "list", data, first_id: page.conversations[0]?.publicId ?? null, last_id: page.conversations.at(-1)?.publicId ?? null, has_more: page.nextCursor !== undefined };
  }

  async items(caller: ApiCaller, publicId: string, query: URLSearchParams): Promise<Json> {
    const conversation = await this.resolve(caller, publicId);
    const limit = pageSize(query.get("limit"), 20, 100);
    const order = query.get("order") ?? "desc";
    if (order !== "asc" && order !== "desc") throw invalidRequest("invalid_request", "order must be asc or desc.", "order");
    const include = query.getAll("include[]").concat(query.getAll("include"));
    for (const [index, value] of include.entries()) if (value !== "hatch.tool_calls") throw unsupported(`include[${index}]`, `include value ${JSON.stringify(value)} is not supported.`);
    const all = conversationItems(await this.deps.store.readVisibleConversation(conversation.id), include.length > 0, await this.deps.views.userItems(conversation));
    const ordered = order === "asc" ? all : [...all].reverse();
    const after = query.get("after");
    const start = after ? ordered.findIndex((item) => item.id === after) + 1 : 0;
    if (after && start === 0) throw invalidRequest("invalid_request", `No item with id \`${after.slice(0, 80)}\` in this conversation.`, "after");
    const data = ordered.slice(start, start + limit);
    return { object: "list", data, first_id: (data[0]?.id as string | undefined) ?? null, last_id: (data.at(-1)?.id as string | undefined) ?? null, has_more: start + limit < ordered.length };
  }
}
