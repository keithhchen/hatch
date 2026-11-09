import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelCapabilities, ClientGroup, DeliveryFailure } from "../surfaces/contract.js";
import type { TenantTokens } from "./tenantTokens.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type ChannelKind, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";

export const GRAPH = "https://graph.facebook.com/v27.0";

export type MetaConfig = { appSecret?: string; verifyToken?: string; tokens?: TenantTokens };
export type GraphError = { code?: number; error_subcode?: number; message?: string; is_transient?: boolean };
/** One webhook entry: a Page, an Instagram account or a WhatsApp business account, with its own events. */
export type Entry = Record<string, any>;

const RATE_LIMITED = new Set([4, 17, 32, 613, 80007, 130429, 131056]);
const ACCESS_LOST = new Set([102, 190, 368, 131005]);
const UNAVAILABLE = new Set([1, 2, 131000, 131057]);
/** Permission error 10 with this subcode is the 24-hour window, not lost access. */
const OUTSIDE_WINDOW = 2018278;

/**
 * Graph errors arrive as HTTP 400 whatever went wrong, so the code decides. Throttled: refused outright. Access taken away:
 * never retried. Platform trouble: may have gone through. Anything else the platform refused will be refused again.
 */
export function classifyGraphError(status: number, error: GraphError = {}): { failure: DeliveryFailure; access: boolean } {
  const { code = 0, error_subcode: subcode } = error;
  if (status === 429 || RATE_LIMITED.has(code)) return { failure: "definite", access: false };
  if (ACCESS_LOST.has(code) || (code === 10 && subcode !== OUTSIDE_WINDOW) || (code >= 200 && code < 300) || lostAccess(status)) return { failure: "permanent", access: true };
  if (UNAVAILABLE.has(code) || status >= 500 || error.is_transient) return { failure: "ambiguous", access: false };
  return { failure: failureForStatus(status), access: false };
}

/** Meta signs the payload with non-ASCII escaped as lower-case \uXXXX on at least one product; the docs disagree, so accept either. */
const escapeUnicode = (text: string): string => text.replace(/[\u0080-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * What WhatsApp, Instagram and Messenger share: one signed webhook for many tenants, batched into entries, and a Graph send.
 * A thread is `tenant:contact`, so a send finds its tenant's token. A subclass reads one platform's entries and writes its requests.
 */
export abstract class MetaChannel implements ChannelAdapter {
  abstract readonly kind: ChannelKind;
  abstract readonly client: Extract<ClientGroup, "im" | "dm">;
  readonly scope = "";
  readonly maxFileBytes = 20 * 1024 * 1024;
  /** The webhook's `object`: a payload for another product is not ours. */
  protected abstract readonly object: string;
  abstract capabilities(): ChannelCapabilities;
  protected abstract events(entry: Entry): InboundEvent[];
  /** The Graph requests that carry one message, in order. */
  protected abstract requests(to: PlatformAddress, message: OutboundMessage): Array<{ url: string; body: unknown }>;

  constructor(protected config: MetaConfig, protected fetchImpl: typeof fetch = fetch) {}

  available(): boolean { return Boolean(this.config.appSecret && this.config.verifyToken && this.config.tokens); }
  connectUrl(_code: string): string | undefined { return undefined; }

  /** The tenant and the contact inside a thread id. */
  protected static split(threadId: string): [string, string] {
    const at = threadId.indexOf(":");
    return [threadId.slice(0, at), threadId.slice(at + 1)];
  }

  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const supplied = headers["x-hub-signature-256"]?.toString();
    const { appSecret } = this.config;
    if (!appSecret || !supplied?.startsWith("sha256=")) return false;
    const a = Buffer.from(supplied.slice("sha256=".length));
    return [raw, Buffer.from(escapeUnicode(raw.toString("utf8")))].some(body => {
      const b = Buffer.from(createHmac("sha256", appSecret).update(body).digest("hex"));
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  /** The GET Meta makes when the endpoint is set up: the challenge to echo, or nothing when the token is wrong. */
  handshake(query: URLSearchParams): string | undefined {
    const token = query.get("hub.verify_token");
    const { verifyToken } = this.config;
    if (query.get("hub.mode") !== "subscribe" || !verifyToken || !token) return undefined;
    const a = Buffer.from(token); const b = Buffer.from(verifyToken);
    return a.length === b.length && timingSafeEqual(a, b) ? query.get("hub.challenge") ?? undefined : undefined;
  }

  /** Many entries, for many tenants, may share one POST, and the platform repeats events: each is kept once. */
  parse(raw: Buffer): { events: InboundEvent[] } {
    const payload = JSON.parse(raw.toString("utf8")) as { object?: string; entry?: Entry[] };
    if (payload.object !== this.object) return { events: [] };
    const seen = new Set<string>();
    return { events: (payload.entry ?? []).flatMap(entry => this.events(entry)).filter(event => !seen.has(event.eventId) && seen.add(event.eventId)) };
  }

  async send(to: PlatformAddress, message: OutboundMessage, _key: string): Promise<void> {
    const token = await this.token(MetaChannel.split(to.threadId)[0]);
    for (const { url, body } of this.requests(to, message)) await this.post(url, body, token);
  }

  async download(file: InboundFile): Promise<Buffer> {
    const url = new URL(file.ref);
    if (url.protocol !== "https:") throw new Error(`${this.kind} file is not on https`);
    return this.fetchBytes(url.toString());
  }

  /** A message to say why Meta refused: the platform's own words, with its code. */
  protected explain(error: GraphError = {}): string { return `${error.message ?? "unknown error"} (${error.code ?? "?"}${error.error_subcode ? `/${error.error_subcode}` : ""})`; }

  protected async token(tenant: string): Promise<string> {
    const token = await this.config.tokens?.(tenant);
    if (!token) throw new ChannelSendError(`${this.kind} access for ${tenant} is gone or was never granted`, "permanent", { access: true });
    return token;
  }

  protected async fetchBytes(url: string, token?: string): Promise<Buffer> {
    const response = await this.fetchImpl(url, { ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${this.kind} file download failed: ${response.status}`);
    if (Number(response.headers.get("content-length")) > this.maxFileBytes) throw new Error(`${this.kind} file is over ${this.maxFileBytes} bytes`);
    return Buffer.from(await response.arrayBuffer());
  }

  protected async post(url: string, body: unknown, token: string): Promise<void> {
    await guardSend(`${this.kind} send`, async () => {
      const response = await this.fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (response.ok) return;
      const { error } = await response.json().catch(() => ({})) as { error?: GraphError };
      const { failure, access } = classifyGraphError(response.status, error);
      const wait = Number(response.headers.get("retry-after")) * 1000;
      throw new ChannelSendError(`${this.kind} send failed: ${this.explain(error)}`, failure, { access, ...(failure === "definite" && wait > 0 ? { retryAfterMs: wait } : {}) });
    });
  }
}
