import { createDecipheriv, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ChannelAdapter, InboundEvent, InboundFile, OutboundMessage, TaskButtonAction } from "./channels.js";

export type LarkCredentials = { domain: "lark" | "feishu"; appId: string; appSecret: string; verificationToken: string; encryptKey?: string };

type LarkBody = {
  encrypt?: string;
  type?: string;
  token?: unknown;
  challenge?: string;
  header?: { event_id?: string; event_type?: string; token?: unknown };
  event?: {
    sender?: { sender_id?: { open_id?: string } };
    message?: { message_id: string; chat_type: string; message_type: string; content?: string };
    operator?: { open_id?: string };
    action?: { value?: { taskId?: unknown; action?: unknown } };
  };
};
type LarkContent = { text?: string; image_key?: string; file_key?: string; file_name?: string; title?: string; content?: LarkPostNode[][] };
type LarkPostNode = { tag?: string; text?: string; href?: string; user_name?: string };
type LarkPayload = { code?: number; msg?: string; tenant_access_token?: string; expire?: number; bot?: unknown };

const BASE_URLS = { lark: "https://open.larksuite.com", feishu: "https://open.feishu.cn" };
const APPLINKS = { lark: "https://applink.larksuite.com", feishu: "https://applink.feishu.cn" };
/** Lark counts the request body, in bytes. */
const TEXT_BYTES = 150 * 1024;
const CARD_BYTES = 30 * 1024;
const TOKEN_MARGIN_MS = 5 * 60_000;

function same(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || !supplied || !expected) return false;
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function decryptLark(encrypt: string, encryptKey: string): string {
  const payload = Buffer.from(encrypt, "base64");
  const decipher = createDecipheriv("aes-256-cbc", createHash("sha256").update(encryptKey).digest(), payload.subarray(0, 16));
  return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8");
}

function postText(post: LarkContent): string | undefined {
  const line = (nodes: LarkPostNode[]) => nodes.map(node => node.tag === "a" && node.href ? `[${node.text ?? node.href}](${node.href})` : node.text ?? node.user_name ?? "").join("");
  return [post.title, ...(post.content ?? []).map(line)].filter(Boolean).join("\n").trim() || undefined;
}

/** Longest prefix of text, with an ellipsis, whose request still fits. */
function fit(text: string, limit: number, requestFor: (text: string) => string): string {
  const fits = (candidate: string) => Buffer.byteLength(requestFor(candidate)) <= limit;
  if (fits(text)) return text;
  const chars = [...text];
  const cut = (count: number) => `${chars.slice(0, count).join("").trimEnd()}…`;
  let low = 0; let high = chars.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (fits(cut(middle))) low = middle; else high = middle - 1; }
  return cut(low);
}

function card(text: string, buttons: NonNullable<OutboundMessage["buttons"]>): unknown {
  return {
    schema: "2.0",
    body: { elements: [
      { tag: "div", text: { tag: "plain_text", content: text } },
      ...buttons.map(button => ({
        tag: "button",
        type: button.action === "approve" ? "primary" : "default",
        text: { tag: "plain_text", content: button.label.slice(0, 100) },
        behaviors: [{ type: "callback", value: { taskId: button.taskId, action: button.action } }],
      })),
    ] },
  };
}

/** Lark or Feishu custom app. A custom app works in one enterprise only, so each Expert brings their own and one adapter serves one account. */
export class LarkChannel implements ChannelAdapter {
  readonly kind = "lark" as const;
  /** Events carry no size. Lark downloads go up to 100 MB; this is our cap, enforced in download. */
  readonly maxFileBytes = 50 * 1024 * 1024;
  private cachedToken?: { value: string; expiresAt: number };
  constructor(private credentials: LarkCredentials, readonly scope: string, private fetchImpl: typeof fetch = fetch) {}
  available(): boolean { return Boolean(this.credentials.appId && this.credentials.appSecret && this.credentials.verificationToken); }
  /** The AppLink can't carry a prefilled code, so the Expert types it. */
  connectUrl(_code: string): undefined { return undefined; }
  chatUrl(): string { return `${APPLINKS[this.credentials.domain]}/client/bot/open?appId=${encodeURIComponent(this.credentials.appId)}`; }
  async probe(): Promise<void> {
    const { bot } = await this.call("/open-apis/bot/v3/info");
    if (!bot) throw new Error("Lark returned no bot: enable the Bot capability on this app");
  }
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const { encryptKey, verificationToken } = this.credentials;
    try {
      const body = this.open(raw);
      // URL verification is not signed. It proves itself with the token, and parse answers it with the challenge alone.
      if (body.type === "url_verification") return same(body.token, verificationToken);
      if (!encryptKey) return same(body.header?.token ?? body.token, verificationToken);
      const header = (name: string) => headers[`x-lark-${name}`]?.toString() ?? "";
      const signed = Buffer.concat([Buffer.from(header("request-timestamp") + header("request-nonce") + encryptKey), raw]);
      return same(header("signature"), createHash("sha256").update(signed).digest("hex"));
    } catch { return false; }
  }
  parse(raw: Buffer): { events: InboundEvent[]; respond?: unknown } {
    const body = this.open(raw);
    if (body.type === "url_verification") return { events: [], respond: { challenge: body.challenge } };
    const type = body.header?.event_type;
    if (type === "card.action.trigger") {
      const peerId = body.event?.operator?.open_id;
      const eventId = body.header?.event_id;
      if (!peerId || !eventId) return { events: [] };
      const value = body.event?.action?.value;
      const valid = typeof value?.taskId === "string" && (value.action === "approve" || value.action === "decline");
      const button = valid ? { taskId: value!.taskId as string, action: value!.action as TaskButtonAction } : { taskId: "", action: "decline" as const };
      return { events: [{ eventId, peerId, button }], respond: { toast: { type: "info", content: "收到" } } };
    }
    if (type !== "im.message.receive_v1") return { events: [] };
    const message = body.event?.message;
    const peerId = body.event?.sender?.sender_id?.open_id;
    if (!message || !peerId || message.chat_type !== "p2p") return { events: [] };
    const id = message.message_id;
    const content = JSON.parse(message.content || "{}") as LarkContent;
    const text = message.message_type === "text" ? content.text?.trim() : message.message_type === "post" ? postText(content) : undefined;
    const file = message.message_type === "image" && content.image_key ? { ref: `${id}|${content.image_key}|image`, name: "photo.jpg" }
      : message.message_type === "file" && content.file_key ? { ref: `${id}|${content.file_key}|file`, name: content.file_name ?? "file" } : undefined;
    // Lark says to dedupe on message_id, not event_id.
    return { events: [{ eventId: id, peerId, messageRef: id, ...(text ? { text } : {}), ...(file ? { file } : {}) }] };
  }
  async send(peerId: string, message: OutboundMessage): Promise<void> {
    const buttons = message.buttons ?? [];
    const uuid = randomUUID();
    const request = (text: string) => JSON.stringify({
      ...(message.replyTo ? {} : { receive_id: peerId }),
      msg_type: buttons.length ? "interactive" : "text",
      content: JSON.stringify(buttons.length ? card(text, buttons) : { text }),
      uuid,
    });
    const path = message.replyTo ? `/open-apis/im/v1/messages/${encodeURIComponent(message.replyTo)}/reply` : "/open-apis/im/v1/messages?receive_id_type=open_id";
    await this.call(path, request(fit(message.text, buttons.length ? CARD_BYTES : TEXT_BYTES, request)));
  }
  async download(file: InboundFile): Promise<Buffer> {
    const [messageId, key, type] = file.ref.split("|");
    if (!messageId || !key || !type) throw new Error("Lark file ref is malformed");
    const response = await this.fetchImpl(`${this.base}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}?type=${type}`, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Lark file download failed: ${describe(await response.json().catch(() => ({})) as LarkPayload, response.status)}`);
    const tooLarge = () => new Error(`Lark file is over ${this.maxFileBytes} bytes`);
    if (Number(response.headers.get("content-length")) > this.maxFileBytes) throw tooLarge();
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.length;
      if (total > this.maxFileBytes) throw tooLarge();
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    // A file can be JSON itself, so only Lark's own failure shape counts.
    if (response.headers.get("content-type")?.includes("json")) {
      let payload: LarkPayload | undefined;
      try { payload = JSON.parse(bytes.toString("utf8")) as LarkPayload; } catch { /* a file, not a failure */ }
      if (typeof payload?.code === "number" && payload.code !== 0 && typeof payload.msg === "string") throw new Error(`Lark file download failed: ${describe(payload, response.status)}`);
    }
    return bytes;
  }
  private get base(): string { return BASE_URLS[this.credentials.domain]; }
  private open(raw: Buffer): LarkBody {
    const body = JSON.parse(raw.toString("utf8")) as LarkBody;
    const key = this.credentials.encryptKey;
    return key && body.encrypt !== undefined ? JSON.parse(decryptLark(body.encrypt, key)) as LarkBody : body;
  }
  private async token(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) return this.cachedToken.value;
    const { appId, appSecret } = this.credentials;
    let payload: LarkPayload;
    try { payload = await this.request("/open-apis/auth/v3/tenant_access_token/internal", JSON.stringify({ app_id: appId, app_secret: appSecret })); }
    catch (error) { throw new Error(`Lark tenant token failed, check the App ID, App Secret and domain (${this.credentials.domain}): ${(error as Error).message}`); }
    if (!payload.tenant_access_token) throw new Error("Lark returned no tenant access token");
    this.cachedToken = { value: payload.tenant_access_token, expiresAt: Date.now() + (payload.expire ?? 0) * 1000 - TOKEN_MARGIN_MS };
    return payload.tenant_access_token;
  }
  private async call(path: string, body?: string): Promise<LarkPayload> { return this.request(path, body, await this.token()); }
  /** Lark reports failures in code, sometimes with HTTP 200. */
  private async request(path: string, body?: string, token?: string): Promise<LarkPayload> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json; charset=utf-8", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as LarkPayload;
    if (!response.ok || payload.code !== 0) throw new Error(`Lark ${path} failed: ${describe(payload, response.status)}`);
    return payload;
  }
}

function describe(payload: LarkPayload, status: number): string {
  return payload.code === undefined ? `HTTP ${status}` : `${payload.msg ?? "error"} (code ${payload.code})`;
}
