import type http from "node:http";
import { awaitTurn } from "./awaitTurn.js";
import { AssistantConversation, type AssistantHost } from "./assistantConversation.js";
import { ConversationError, type Conversation } from "./conversation.js";
import { WorkerDirectory, type WorkerWorkspace } from "./workerConversation.js";

export const MAX_WAIT_SECONDS = 120;

export type ConversationRouteDeps = {
  /** The signed-in account, or nothing. */
  authenticate(request: http.IncomingMessage): Promise<{ id: string } | undefined>;
  token(request: http.IncomingMessage): string | undefined;
  /** The Product when this account owns it. */
  product(accountId: string, productId: string): Promise<{ brief_spec?: unknown } | undefined>;
  workspace(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string): Promise<WorkerWorkspace>;
  assistant(): AssistantHost | undefined;
  json(response: http.ServerResponse, status: number, payload: unknown): void;
  readJson(request: http.IncomingMessage): Promise<Record<string, unknown>>;
  /** Pacing of `wait`, replaceable in tests. */
  pace?: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
};

type Target = { conversation: Conversation; maxContent: number };
type Action = "messages" | "events" | "stop";

const WORKERS_ROUTE = /^\/v1\/creator\/products\/([^/]+)\/workers(?:\/([^/]+)\/(messages|events|stop))?$/;
const ASSISTANT_ROUTE = /^\/v1\/creator\/assistant\/conversation\/(messages|events|stop)$/;
const NOT_FOUND = (code: string, message: string) => new ConversationError(404, code, message);

/**
 * Conversation API: Product workers and the account's Assistant behind one set of verbs.
 * Only knows the Conversation port; how a turn runs is the adapters' business.
 */
export class ConversationRoutes {
  constructor(private deps: ConversationRouteDeps) {}

  /** Handles the request when the path is a conversation path; false when it is not. */
  async handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<boolean> {
    const workers = url.pathname.match(WORKERS_ROUTE);
    const assistant = url.pathname.match(ASSISTANT_ROUTE);
    if (!workers && !assistant) return false;
    const account = await this.deps.authenticate(request);
    if (!account) { this.deps.json(response, 401, { detail: "A valid account token is required." }); return true; }
    try {
      if (workers && !workers[2]) {
        if (request.method !== "GET") throw new ConversationError(405, "method_not_allowed", "Method not allowed.");
        this.deps.json(response, 200, { workers: await (await this.directory(request, account.id, decodeURIComponent(workers[1]!))).list() });
      } else {
        const target = workers
          ? await this.worker(request, account.id, decodeURIComponent(workers[1]!), decodeURIComponent(workers[2]!))
          : this.assistantTarget(account.id);
        await this.serve(target, (workers?.[3] ?? assistant![1]) as Action, request, response, url);
      }
    } catch (error) {
      if (!(error instanceof ConversationError)) throw error;
      this.deps.json(response, error.status, { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, detail: error.message });
    }
    return true;
  }

  private async directory(request: http.IncomingMessage, accountId: string, productId: string): Promise<WorkerDirectory> {
    const product = await this.deps.product(accountId, productId);
    if (!product) throw NOT_FOUND("product_not_found", "Product was not found.");
    return new WorkerDirectory(await this.deps.workspace({ creatorId: accountId, productId, briefSpec: product.brief_spec }, this.deps.token(request)!));
  }

  private async worker(request: http.IncomingMessage, accountId: string, productId: string, workerId: string): Promise<Target> {
    const directory = await this.directory(request, accountId, productId);
    const conversation = directory.conversation(workerId);
    if (!conversation) throw NOT_FOUND("worker_not_found", `No worker named ${workerId}.`);
    return { conversation, maxContent: 100_000 };
  }

  private assistantTarget(accountId: string): Target {
    const assistant = this.deps.assistant();
    if (!assistant) throw new ConversationError(503, "assistant_unavailable", "The Assistant requires the Registry database.");
    return { conversation: new AssistantConversation(accountId, assistant), maxContent: 20_000 };
  }

  private async serve({ conversation, maxContent }: Target, action: Action, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const allowed = action === "messages" ? ["GET", "POST"] : action === "events" ? ["GET"] : ["POST"];
    if (!allowed.includes(request.method ?? "")) throw new ConversationError(405, "method_not_allowed", "Method not allowed.");
    if (action === "stop") { await conversation.stop(); this.deps.json(response, 202, { requested: true }); return; }
    if (action === "events") { await this.stream(conversation, response); return; }
    if (request.method === "GET") {
      const limit = url.searchParams.get("limit");
      const { status, messages } = await conversation.messages(url.searchParams.get("after") || undefined, limit ? Number(limit) : undefined);
      this.deps.json(response, 200, { status: status.state, ...(status.error ? { error: status.error } : {}), messages });
      return;
    }
    await this.send(conversation, maxContent, request, response, url);
  }

  private async send(conversation: Conversation, maxContent: number, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const body = await this.deps.readJson(request);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > maxContent) throw new ConversationError(400, "invalid_message", `Message must contain 1–${maxContent} characters.`);
    const waitParam = url.searchParams.get("wait");
    const wait = waitParam === null ? 0 : Number(waitParam);
    if (!Number.isFinite(wait) || wait < 0) throw new ConversationError(400, "invalid_wait", "wait must be a number of seconds.");
    const after = wait ? (await conversation.messages(undefined, 1)).messages.at(-1)?.id : undefined;
    const sent = await conversation.send(content);
    const accepted = { conversation_id: sent.conversationId, message: sent.message, queued: sent.queued };
    if (!wait) { this.deps.json(response, 202, { ...accepted, status: "running" }); return; }
    const outcome = await awaitTurn(conversation, { sentId: sent.message.id, after, timeoutMs: Math.min(wait, MAX_WAIT_SECONDS) * 1000, ...this.deps.pace });
    this.deps.json(response, outcome.status.state === "running" ? 202 : 200, {
      ...accepted, status: outcome.status.state, ...(outcome.status.error ? { error: outcome.status.error } : {}), ...(outcome.reply ? { reply: outcome.reply } : {}),
    });
  }

  private async stream(conversation: Conversation, response: http.ServerResponse): Promise<void> {
    const write = (value: unknown) => { if (!response.writableEnded) response.write(`data: ${JSON.stringify(value)}\n\n`); };
    const unsubscribe = await conversation.events(write);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(": connected\n\n");
    const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(": heartbeat\n\n"); }, 15_000);
    await new Promise<void>(resolve => response.once("close", () => resolve()));
    clearInterval(heartbeat);
    unsubscribe();
  }
}
