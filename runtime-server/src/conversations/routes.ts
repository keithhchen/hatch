import { randomUUID } from "node:crypto";
import type http from "node:http";
import { normalizeClientAttributes, type ClientAttributes } from "../surfaces/contract.js";
import { parseContent, resolveContent } from "./assets.js";
import { awaitTurn } from "./awaitTurn.js";
import { MAX_BYTES } from "../assets/pipeline.js";
import { ConversationError, type Conversation, type SendInput } from "./conversation.js";
import { messageKey } from "../chat/messageKey.js";
import { ChatError } from "../chat/principal.js";
import { toProblem } from "../errors/problem.js";
import { START } from "./eventLog.js";
import { follow, resumePoint } from "./follow.js";
import { EventStream } from "./sse.js";
import { snapshotOf, viewOf } from "./snapshot.js";
import { Studio, type StudioDeps, type Target, type TargetSpec } from "./studio.js";

export const MAX_WAIT_SECONDS = 120;
/** The most any kind of asset may weigh; the pipeline holds each kind to its own limit. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_BYTES));

export type ConversationRouteDeps = StudioDeps & {
  /** The signed-in account, or nothing. */
  authenticate(request: http.IncomingMessage): Promise<{ id: string } | undefined>;
  token(request: http.IncomingMessage): string | undefined;
  json(response: http.ServerResponse, status: number, payload: unknown): void;
  readJson(request: http.IncomingMessage): Promise<Record<string, unknown>>;
  /** The request body as it is, refusing more than `maxBytes`. */
  readBytes(request: http.IncomingMessage, maxBytes: number): Promise<Buffer>;
  /** Pacing of `wait`, replaceable in tests. */
  pace?: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
};

type Action = "messages" | "events" | "stop" | "snapshot" | "assets" | "retry" | "view" | "timezone" | "asset";

const WORKERS_ROUTE = /^\/v1\/creator\/products\/([^/]+)\/workers(?:\/([^/]+)\/(messages|events|stop|snapshot|assets))?$/;
const ASSISTANT_ROUTE = /^\/v1\/creator\/assistant\/conversation\/(messages|events|stop|snapshot|assets|retry|view|timezone)$/;
const ASSISTANT_ASSET_ROUTE = /^\/v1\/creator\/assistant\/conversation\/assets\/([^/]+)$/;
const METHODS: Record<Action, string[]> = { messages: ["GET", "POST"], events: ["GET"], stop: ["POST"], snapshot: ["GET"], assets: ["POST"], retry: ["POST"], view: ["GET"], timezone: ["PUT"], asset: ["GET"] };
/** The newest messages the Studio view holds, and the most it is asked for. */
const VIEW_PAGE = 200;

function clientOf(body: Record<string, unknown>): ClientAttributes {
  const raw = body.client;
  const spec = typeof raw === "string" ? { client: raw } : raw && typeof raw === "object" ? raw as { client: string } : { client: "web" };
  try { return normalizeClientAttributes(spec); } catch (error) { throw new ConversationError(400, "invalid_client", (error as Error).message); }
}

/** The public API's key is optional, as is usual: with one a retry replays; without one the request stands alone and a retry of it is new. */
export function keyOrNew(raw: unknown): string { return messageKey(raw) ?? randomUUID(); }

/** The client's key is the message's id: the same one the page and the Chat API mean by it. */
function keyOf(request: http.IncomingMessage, body: Record<string, unknown>): string {
  try { return keyOrNew(request.headers["idempotency-key"] ?? body.idempotency_key); }
  catch (error) { if (error instanceof ChatError) throw new ConversationError(error.status, error.code, error.message); throw error; }
}

/**
 * Conversation API over HTTP: Product workers and the account's Assistant behind one set of verbs.
 * Only knows the Conversation port, the event log and the Studio that finds conversations.
 */
export class ConversationRoutes {
  private studio: Studio;
  constructor(private deps: ConversationRouteDeps) { this.studio = new Studio(deps); }

  /** Handles the request when the path is a conversation path; false when it is not. */
  async handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<boolean> {
    const workers = url.pathname.match(WORKERS_ROUTE);
    const asset = url.pathname.match(ASSISTANT_ASSET_ROUTE);
    const assistant = asset ? undefined : url.pathname.match(ASSISTANT_ROUTE);
    if (!workers && !assistant && !asset) return false;
    const account = await this.deps.authenticate(request);
    if (!account) { this.deps.json(response, 401, { detail: "A valid account token is required." }); return true; }
    try {
      if (workers && !workers[2]) {
        if (request.method !== "GET") throw new ConversationError(405, "method_not_allowed", "Method not allowed.");
        this.deps.json(response, 200, { workers: await (await this.studio.directory(account.id, this.deps.token(request)!, decodeURIComponent(workers[1]!))).list() });
      } else {
        const spec: TargetSpec = workers ? { kind: "worker", productId: decodeURIComponent(workers[1]!), workerId: decodeURIComponent(workers[2]!) } : { kind: "assistant" };
        await this.serve(await this.studio.target(account.id, this.deps.token(request)!, spec), (workers?.[3] ?? assistant?.[1] ?? "asset") as Action, request, response, url, asset ? decodeURIComponent(asset[1]!) : undefined);
      }
    } catch (error) {
      if (!(error instanceof ConversationError)) throw error;
      const { status, code, message, details } = toProblem(error);
      this.deps.json(response, status, { error: { code, message, ...(details === undefined ? {} : { details }) }, detail: message });
    }
    return true;
  }

  private async serve(target: Target, action: Action, request: http.IncomingMessage, response: http.ServerResponse, url: URL, assetId?: string): Promise<void> {
    const { conversation } = target;
    if (!METHODS[action].includes(request.method ?? "")) throw new ConversationError(405, "method_not_allowed", "Method not allowed.");
    if (action === "stop") { await conversation.stop(); this.deps.json(response, 202, { requested: true }); return; }
    if (action === "retry") { await this.retry(conversation, request, response); return; }
    if (action === "assets") { await this.upload(target, request, response, url); return; }
    if (action === "asset") { await this.show(target, assetId!, response); return; }
    if (action === "view") { await this.view(target, url, response); return; }
    if (action === "timezone") { await this.timezone(target, request, response); return; }
    if (action === "snapshot") { this.deps.json(response, 200, await snapshotOf(conversation, this.studio.eventLog)); return; }
    if (action === "events") { await this.events(conversation, request, response, url); return; }
    if (request.method === "GET") {
      const limit = url.searchParams.get("limit");
      const before = url.searchParams.get("before");
      if (before) { await this.earlier(conversation, before, limit ? Number(limit) : undefined, url.searchParams.has("after"), response); return; }
      const { status, messages } = await conversation.messages(url.searchParams.get("after") || undefined, limit ? Number(limit) : undefined);
      this.deps.json(response, 200, { status: status.state, ...(status.error ? { error: status.error } : {}), messages });
      return;
    }
    await this.send(target, request, response, url);
  }

  /** The page of messages before `before`, a `before_cursor` an earlier page named. */
  private async earlier(conversation: Conversation, before: string, limit: number | undefined, withAfter: boolean, response: http.ServerResponse): Promise<void> {
    if (withAfter) throw new ConversationError(400, "invalid_cursor", "Use either after or before, not both.");
    if (!conversation.history) throw new ConversationError(501, "history_unavailable", "This conversation cannot be read backwards.");
    const [status, page] = await Promise.all([conversation.status(), conversation.history({ limit, before })]);
    this.deps.json(response, 200, { status: status.state, ...(status.error ? { error: status.error } : {}), ...page });
  }

  /** What Studio's Assistant page shows: the snapshot of the newest messages, with where earlier ones begin, and what waits on the Expert. */
  private async view(target: Target, url: URL, response: http.ServerResponse): Promise<void> {
    const { panel } = this.studio;
    const limit = Number(url.searchParams.get("limit"));
    const view = await viewOf(target.conversation, this.studio.eventLog, Number.isInteger(limit) && limit > 0 ? Math.min(limit, VIEW_PAGE) : VIEW_PAGE);
    const [tasks, channels] = await Promise.all([panel.tasks(target.accountId), panel.channels(target.accountId)]);
    this.deps.json(response, 200, { ...view, tasks, channels });
  }

  /** The Expert's timezone, set on purpose: reading the conversation changes nothing. */
  private async timezone(target: Target, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const { timezone } = await this.deps.readJson(request);
    if (typeof timezone !== "string" || !timezone) throw new ConversationError(400, "invalid_timezone", "timezone is an IANA name such as Asia/Shanghai.");
    await this.studio.panel.setTimezone(target.accountId, timezone);
    this.deps.json(response, 200, { timezone });
  }

  /** An uploaded picture, as the page shows it. */
  private async show(target: Target, assetId: string, response: http.ServerResponse): Promise<void> {
    if (!target.assets) throw new ConversationError(501, "attachments_unavailable", "This conversation cannot take attachments.");
    const image = await target.assets.desk.view(target.assets.scope, assetId);
    if (!image) throw new ConversationError(404, "asset_not_found", `No image ${assetId}.`);
    response.writeHead(200, { "content-type": image.mime, "content-length": image.bytes.length, "cache-control": "private, max-age=86400" });
    response.end(image.bytes);
  }

  /** Answers the conversation again after a failed Run: no new message; the Idempotency-Key makes a repeat the same Run. */
  private async retry(conversation: Conversation, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (!conversation.retry) throw new ConversationError(501, "retry_unavailable", "This conversation cannot answer again.");
    const body = await this.deps.readJson(request);
    const { runId, outcome } = await conversation.retry(keyOf(request, body), clientOf(body));
    this.deps.json(response, 202, { run_id: runId, outcome });
  }

  private async input(target: Target, request: http.IncomingMessage): Promise<SendInput> {
    const body = await this.deps.readJson(request);
    const { text, attachments } = await resolveContent(parseContent(body.content), target.assets);
    if ((!text && !attachments.length) || text.length > target.maxContent) throw new ConversationError(400, "invalid_message", `Message must contain 1–${target.maxContent} characters.`);
    return { id: keyOf(request, body), text, attachments, client: clientOf(body) };
  }

  /** The file is the request body and its name is `?name=`; it is a ready asset, or refused with the reason, before any message is sent. */
  private async upload(target: Target, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    if (!target.assets) throw new ConversationError(501, "attachments_unavailable", "This conversation cannot take attachments.");
    const name = url.searchParams.get("name")?.trim();
    if (!name) throw new ConversationError(400, "invalid_upload", "name is the file's name.");
    const bytes = await this.deps.readBytes(request, MAX_UPLOAD_BYTES);
    if (!bytes.length) throw new ConversationError(400, "invalid_upload", "The file is empty.");
    this.deps.json(response, 201, await target.assets.desk.upload(target.assets.scope, { name, bytes }));
  }

  private async send(target: Target, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const { conversation } = target;
    const input = await this.input(target, request);
    const waitParam = url.searchParams.get("wait");
    const wait = waitParam === null ? 0 : Number(waitParam);
    if (!Number.isFinite(wait) || wait < 0) throw new ConversationError(400, "invalid_wait", "wait must be a number of seconds.");
    const feed = await conversation.feedKey();
    const cursor = feed ? await this.studio.eventLog.head(feed) : START;
    const after = wait ? (await conversation.messages(undefined, 1)).messages.at(-1)?.id : undefined;
    const sent = await conversation.send(input);
    const accepted = { conversation_id: sent.conversationId, ...(sent.runId ? { run_id: sent.runId } : {}), message: sent.message, queued: sent.queued };
    if (String(request.headers.accept).includes("text/event-stream")) { await this.streamTurn(conversation, sent.message.id, accepted, cursor, response); return; }
    if (!wait) { this.deps.json(response, 202, { ...accepted, status: "running" }); return; }
    const outcome = await awaitTurn(conversation, { sentId: sent.message.id, after, timeoutMs: Math.min(wait, MAX_WAIT_SECONDS) * 1000, ...this.deps.pace });
    const running = outcome.status.state === "running";
    this.deps.json(response, running ? 202 : 200, {
      ...accepted, status: outcome.status.state, ...(outcome.status.error ? { error: outcome.status.error } : {}), ...(outcome.reply ? { reply: outcome.reply } : {}),
      // The Run goes on without this request: follow it from `cursor`.
      ...(running ? { cursor } : {}),
    });
  }

  /** The send's own turn as a stream: what the Run does, from just before the message until the conversation is idle. */
  private async streamTurn(conversation: Conversation, sentId: string, accepted: unknown, cursor: string, response: http.ServerResponse): Promise<void> {
    const stream = new EventStream(response);
    const feed = (await conversation.feedKey())!;
    const stop = new AbortController();
    response.once("close", () => stop.abort());
    const heartbeat = setInterval(() => stream.heartbeat(), 15_000);
    stream.frame(accepted, { name: "accepted" });
    // The turn is over once nothing runs and the message is in history; how it ended is the conversation's status.
    const settled = async () => { const status = await conversation.status(); return status.state !== "running" && (await conversation.messages(undefined, 500)).messages.some(message => message.id === sentId) ? status : undefined; };
    await follow(this.studio.eventLog, feed, cursor, async ({ cursor: id, event }) => {
      stream.frame(event, { id });
      if (stream.lagging) { response.destroy(); stop.abort(); return; }
      const ended = event.type === "run_end" || event.type === "state" ? await settled() : undefined;
      if (ended) { stream.frame({ status: ended.state, ...(ended.error ? { error: ended.error } : {}) }, { name: "done" }); stop.abort(); }
    }, { signal: stop.signal, ...this.deps.pace });
    clearInterval(heartbeat);
    stream.end();
  }

  /** Replay after the cursor (`after`, or Last-Event-ID), then follow. Without either, from now. */
  private async events(conversation: Conversation, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const feed = await conversation.feedKey();
    if (!feed) throw new ConversationError(404, "conversation_not_started", "This worker has no conversation yet. Send it a message first.");
    const given = url.searchParams.get("after_cursor") ?? (request.headers["last-event-id"] as string | undefined);
    const from = await resumePoint(this.studio.eventLog, feed, given);
    const stream = new EventStream(response);
    const stop = new AbortController();
    response.once("close", () => stop.abort());
    const heartbeat = setInterval(() => stream.heartbeat(), 15_000);
    await follow(this.studio.eventLog, feed, from, ({ cursor, event }) => {
      stream.frame(event, { id: cursor });
      if (stream.lagging) { response.destroy(); stop.abort(); }
    }, { signal: stop.signal, ...this.deps.pace });
    clearInterval(heartbeat);
    stream.end();
  }
}
