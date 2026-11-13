import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import { z } from "zod";
import { MAX_BYTES } from "../assets/pipeline.js";
import { normalizeClientAttributes } from "../surfaces/contract.js";
import type { ChatGateway } from "./gateway.js";
import { ChatError } from "./principal.js";

const text = z.string().min(1).max(512);
const Principal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), accountId: text }).strict(),
  z.object({ kind: z.literal("contact"), connectionId: text, contactId: text }).strict()
]);
const Conversation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), id: text }).strict(),
  z.object({ kind: z.literal("thread"), connectionId: text, threadId: text }).strict()
]);
const Part = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.enum(["image", "file", "audio"]), assetId: text }).strict()
]);
const Client = z.object({ client: z.enum(["im", "dm"]), device: z.string().optional(), locale: z.string().optional(), language: z.string().optional() });
const Send = z.object({ principal: Principal, conversation: Conversation, client: Client, message_id: text, parts: z.array(Part).min(1) }).strict();
const Upload = z.object({ principal: Principal, conversation: Conversation, name: z.string().min(1).max(512) }).strict();

const Restart = z.object({ principal: Principal, thread: z.object({ kind: z.literal("thread"), connectionId: text, threadId: text }).strict(), key: text }).strict();

const ROOT = "/v1/service/chat";
/** The largest file the asset pipeline accepts, plus nothing: a larger body is refused before it is read. */
const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_BYTES));

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ChatError("invalid_request", parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "), 400);
  return parsed.data;
};

const json = (raw: string): unknown => {
  try { return JSON.parse(raw || "{}"); } catch { throw new ChatError("invalid_json", "The request must be JSON.", 400); }
};

async function readBytes(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > maxBytes) throw new ChatError("request_too_large", `The body is limited to ${maxBytes} bytes.`, 413);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());

/**
 * The channel layer's door into Chat from another process. Only a caller holding the service token gets in; everything
 * behind it is the same ChatGateway an in-process caller uses, so there is no second path into a conversation.
 */
export class ChatServiceApi {
  constructor(private readonly deps: { token: string | undefined; gateway: ChatGateway }) {}

  /** False when the path is not one of ours. Failures are thrown as ChatError for the caller to write. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith(`${ROOT}/`)) return false;
    if (!this.deps.token) throw new ChatError("service_unavailable", "The Chat service API is not configured on this Runtime.", 503);
    const given = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    if (!sameSecret(given, this.deps.token)) throw new ChatError("service_auth_required", "A valid Chat service token is required.", 401);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const route = url.pathname.slice(ROOT.length);

    if (req.method === "POST" && route === "/messages") {
      const input = parse(Send, json((await readBytes(req, 1_048_576)).toString("utf8")));
      reply(200, await this.deps.gateway.send(input.principal, input.conversation, normalizeClientAttributes(input.client), input.message_id, input.parts));
      return true;
    }
    if (req.method === "POST" && route === "/conversations/restart") {
      const input = parse(Restart, json((await readBytes(req, 65_536)).toString("utf8")));
      reply(200, await this.deps.gateway.restart(input.principal, input.thread, input.key));
      return true;
    }
    if (req.method === "POST" && route === "/uploads") {
      // The file is the body; who it is for travels in a header so the bytes need no envelope.
      const meta = parse(Upload, json(Buffer.from(String(req.headers["x-hatch-upload"] ?? ""), "base64url").toString("utf8")));
      const bytes = await readBytes(req, MAX_UPLOAD_BYTES);
      if (!bytes.length) throw new ChatError("invalid_upload", "The file is empty.", 400);
      reply(200, await this.deps.gateway.upload(meta.principal, meta.conversation, { name: meta.name, bytes }));
      return true;
    }
    const run = /^\/runs\/([^/]+)$/.exec(route);
    if (req.method === "GET" && run) {
      const progress = await this.deps.gateway.progress(decodeURIComponent(run[1]!));
      if (!progress) throw new ChatError("run_not_found", "Run was not found.", 404);
      reply(200, progress);
      return true;
    }
    throw new ChatError("not_found", "Chat service route was not found.", 404);
  }
}
