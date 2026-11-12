import type http from "node:http";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import type { ConversationRepository } from "../conversationRepository.js";
import type { AuthIdentityResolver } from "../entitlements.js";
import type { ChatEdge } from "../chat/turnSubmission.js";
import { log } from "../observability/log.js";
import { bindContext, currentContext } from "../observability/context.js";
import type { RuntimeStore } from "../store.js";
import { InlineAttachments, PublicHttpsFetcher, type UrlFetcher } from "./attachments.js";
import { ApiAuthenticator, cachingIdentityResolver, type ApiCaller } from "./auth.js";
import { ConversationsApi } from "./conversations.js";
import { ApiError, errorBody, invalidRequest, notFound, toApiError, unsupported } from "./errors.js";
import type { Json } from "./mapping.js";
import { ModelCatalog } from "./models.js";
import { ResponsesApi, type Delivery } from "./responses.js";
import { RunViews } from "./runs.js";
import { streamResponse } from "./stream.js";

export const RESPONSES_BASE = "/responses/v1";

/** A request carrying an inline file is bigger than any JSON body elsewhere: 50 MB of file is about 67 MB of base64. */
const MAX_BODY_BYTES = 72 * 1024 * 1024;

export type ResponsesHttpDeps = {
  repository: ConversationRepository;
  store: RuntimeStore;
  edge: ChatEdge;
  corpora: AgentCorpusResolverLike | undefined;
  identities: AuthIdentityResolver | undefined;
  urls?: UrlFetcher;
  /** Resolves once the repository can be used. */
  ready?: Promise<unknown>;
  /** Overrides for tests; production uses the defaults (a 90 s hold, a 15 s keep-alive). */
  holdMs?: number;
  keepAliveMs?: number;
};

/** The Responses API as an HTTP adapter: it authenticates, routes, and writes what the domain-facing services return, in the OpenAI shape. */
export class ResponsesHttpApi {
  private readonly authenticator: ApiAuthenticator;
  private readonly models: ModelCatalog;
  private readonly conversations: ConversationsApi;
  private readonly responses: ResponsesApi;
  private readonly views: RunViews;

  constructor(private readonly deps: ResponsesHttpDeps) {
    const identities = deps.identities ? cachingIdentityResolver(deps.identities) : undefined;
    this.authenticator = new ApiAuthenticator(identities);
    this.models = new ModelCatalog({ corpora: deps.corpora, identities });
    this.views = new RunViews({ repository: deps.repository, store: deps.store, chat: deps.edge.chat, ...(deps.edge.chatAssets ? { assets: deps.edge.chatAssets } : {}) });
    this.conversations = new ConversationsApi({ repository: deps.repository, store: deps.store, catalog: this.models, views: this.views });
    this.responses = new ResponsesApi({
      repository: deps.repository, store: deps.store, edge: deps.edge, catalog: this.models, conversations: this.conversations,
      attachments: new InlineAttachments({ assets: deps.edge.chatAssets, urls: deps.urls ?? new PublicHttpsFetcher() }),
      views: this.views, ...(identities ? { identities } : {}), ...(deps.holdMs ? { holdMs: deps.holdMs } : {})
    });
  }

  static handles(url: URL): boolean {
    return url.pathname === RESPONSES_BASE || url.pathname.startsWith(`${RESPONSES_BASE}/`);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, signal?: AbortSignal): Promise<void> {
    try {
      const caller = await this.authenticator.authenticate(req, signal);
      await this.deps.ready;
      bindContext({ account_id: caller.accountId });
      const delivery = await this.route(caller, req, url, signal);
      if (delivery.kind === "json") return json(res, delivery.status, delivery.body);
      await streamResponse({
        res, edge: this.deps.edge, repository: this.deps.repository, views: this.views, signal,
        conversation: delivery.conversation, run: delivery.run, includeToolCalls: delivery.includeToolCalls, afterCursor: delivery.afterCursor,
        ...(delivery.startingAfter !== undefined ? { startingAfter: delivery.startingAfter } : {}),
        ...(this.deps.keepAliveMs ? { keepAliveMs: this.deps.keepAliveMs } : {})
      });
    } catch (error) {
      this.fail(req, res, error);
    }
  }

  private fail(req: http.IncomingMessage, res: http.ServerResponse, error: unknown): void {
    const { error: apiError, internal } = toApiError(error);
    if (internal) log.error("responses_request_failed", { method: req.method, path: req.url?.split("?")[0], request_id: currentContext()?.request_id, error });
    if (res.headersSent || res.writableEnded) { res.destroy(); return; }
    json(res, apiError.status, errorBody(apiError), apiError.retryAfterSeconds ? { "retry-after": String(apiError.retryAfterSeconds) } : {});
  }

  private async route(caller: ApiCaller, req: http.IncomingMessage, url: URL, signal?: AbortSignal): Promise<Delivery> {
    const method = req.method ?? "GET";
    const path = url.pathname.slice(RESPONSES_BASE.length).replace(/\/+$/, "");
    const parts = path.split("/").slice(1).map(decodeURIComponent);
    const ok = (body: Json): Delivery => ({ kind: "json", status: 200, body });
    const only = (...allowed: string[]): void => { if (!allowed.includes(method)) throw new ApiError(405, "invalid_request_error", "method_not_allowed", `Use ${allowed.join(" or ")} for ${path}.`); };
    const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() || undefined : undefined;

    switch (parts[0]) {
      case "models":
        only("GET");
        if (parts.length === 1) return ok({ object: "list", data: await this.models.list(caller, signal) });
        if (parts.length === 2) return ok({ ...await this.models.get(caller, parts[1], signal) });
        break;
      case "conversations":
        if (parts.length === 1) {
          only("GET", "POST");
          return ok(method === "GET" ? await this.conversations.list(caller, url.searchParams) : await this.conversations.create(caller, await readBody(req), idempotencyKey, signal));
        }
        if (parts.length === 2) {
          only("GET", "POST", "DELETE");
          if (method === "GET") return ok(await this.conversations.get(caller, parts[1]!));
          if (method === "DELETE") return ok(await this.conversations.archive(caller, parts[1]!));
          return ok(await this.conversations.update(caller, parts[1]!, await readBody(req)));
        }
        if (parts.length === 3 && parts[2] === "items") { only("GET"); return ok(await this.conversations.items(caller, parts[1]!, url.searchParams)); }
        break;
      case "responses":
        if (parts.length === 1) { only("POST"); return this.responses.create(caller, await readBody(req), idempotencyKey, signal); }
        if (parts.length === 2) {
          only("GET", "DELETE");
          if (method === "DELETE") throw unsupported("response_id", "Responses are part of the conversation record and cannot be deleted: delete the conversation.");
          return this.responses.get(caller, parts[1]!, url.searchParams);
        }
        if (parts.length === 3 && parts[2] === "cancel") { only("POST"); return ok(await this.responses.cancel(caller, parts[1]!)); }
        if (parts.length === 3 && parts[2] === "input_items") { only("GET"); return ok(await this.responses.inputItems(caller, parts[1]!)); }
        break;
      case "files":
        throw notFound("not_found", "The Files API is not available yet: send files inline as data URLs or https URLs.");
      default:
    }
    throw notFound("not_found", `Unknown route: ${method} ${RESPONSES_BASE}${path}.`);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const serialized = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(serialized), ...headers });
  res.end(serialized);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, "invalid_request_error", "request_too_large", `The request body is limited to ${MAX_BODY_BYTES} bytes.`);
    chunks.push(value);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalidRequest("invalid_json", "The request body must be JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidRequest("invalid_json", "The request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}
