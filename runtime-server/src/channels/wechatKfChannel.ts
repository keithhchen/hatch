import { createHash } from "node:crypto";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";
import { WeComCrypto } from "./wecomCrypto.js";

/**
 * WeChat Customer Service runs on one enterprise's WeCom API. The super admin enables API access in the WeCom console
 * (应用管理 > 微信客服 > API), picks a self-built app under 可调用接口的应用 and hands it the kf accounts to manage.
 * That app's Secret (with the corp id) is what gettoken takes, and the callback's Token and EncodingAESKey sign and seal
 * the notifications. The docs show no OAuth flow, so the Expert pastes these four values.
 */
export type WeChatKfCredentials = { corpId: string; secret: string; token: string; encodingAesKey: string };

type KfMessage = {
  msgid?: string; open_kfid?: string; external_userid?: string; origin?: number; msgtype?: string;
  text?: { content?: string };
  image?: { media_id?: string }; voice?: { media_id?: string }; video?: { media_id?: string }; file?: { media_id?: string };
  location?: { name?: string; address?: string; latitude?: number; longitude?: number };
  link?: { title?: string; desc?: string; url?: string };
};
type KfPayload = { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number; msg_list?: KfMessage[]; next_cursor?: string; has_more?: number };

const BASE = "https://qyapi.weixin.qq.com";
const TOKEN_MARGIN_MS = 5 * 60_000;
const FROM_CUSTOMER = 3;
const FILE_NAMES = { image: "photo.jpg", voice: "voice.amr", video: "video.mp4", file: "file" } as const;
/** 45009 call frequency and 45033 concurrency: refused, nothing sent. */
const RATE_LIMITED = new Set([45009, 45033]);
/** Secret or corp id wrong, IP not whitelisted, authorization revoked or never given, kf account gone, API switched off, servicer outside the app's visible range. */
const ACCESS_LOST = new Set([40001, 40013, 40091, 60020, 60030, 48002, 48004, 48006, 48007, 95000, 95004, 95017]);
const DUPLICATE_MSGID = 95033;

/** access_token invalid or expired (40014, 42001): the request was refused whole, so a new token may retry it. */
class StaleToken extends ChannelSendError {}
/** 95033: the msgid is already known, so an earlier attempt of this same send went through. */
class AlreadySent extends ChannelSendError {}

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml)?.slice(1).find(value => value !== undefined);

/** WeChat Customer Service on the Expert's own enterprise: one adapter per account, and its webhook URL carries the account. */
export class WeChatKfChannel implements ChannelAdapter {
  readonly kind = "wechatkf" as const;
  /** WeCom's media limits are 2 MB images and voice, 10 MB video, 20 MB files. */
  readonly maxFileBytes = 20 * 1024 * 1024;
  private cachedToken?: { value: string; expiresAt: number };
  /** Per kf account. Lost on restart: the pull then starts at the oldest message WeCom keeps (3 days), and the inbox's UNIQUE (channel, scope, event_id) on msgid makes those repeats harmless. */
  private cursors = new Map<string, string>();
  constructor(private credentials: WeChatKfCredentials, readonly scope: string, private fetchImpl: typeof fetch = fetch) {}
  /** Text is at most 2048 bytes and a UTF-16 unit is at most 3 of them. A reply needs the customer's last message within 48 hours, and at most 5 replies follow it (95001, permanent). */
  capabilities(): ChannelCapabilities { return { stream: false, edit: false, typing: false, buttons: false, maxLength: 682, canInitiate: false, replyWindowMs: 48 * 3600_000, idempotentSend: true }; }
  available(): boolean { return Object.values(this.credentials).every(Boolean); }
  connectUrl(_code: string): undefined { return undefined; }
  verify(raw: Buffer, _headers: Record<string, string | string[] | undefined>, query?: URLSearchParams): boolean {
    const encrypted = tag(raw.toString("utf8"), "Encrypt");
    const timestamp = query?.get("timestamp"); const nonce = query?.get("nonce");
    // WeCom documents no freshness window for timestamp, so none is enforced.
    return Boolean(encrypted && timestamp && nonce) && this.crypto.check(query?.get("msg_signature"), timestamp!, nonce!, encrypted!);
  }
  challenge(query: URLSearchParams): string | undefined {
    // Base64 has no spaces: one here is a '+' the sender left unescaped.
    const echostr = query.get("echostr")?.replaceAll(" ", "+");
    const timestamp = query.get("timestamp"); const nonce = query.get("nonce");
    try { return echostr && timestamp && nonce && this.crypto.check(query.get("msg_signature"), timestamp, nonce, echostr) ? this.crypto.decrypt(echostr) : undefined; } catch { return undefined; }
  }
  /** The notification only says something is waiting; the messages are pulled here. */
  async parse(raw: Buffer): Promise<{ events: InboundEvent[] }> {
    const xml = this.crypto.decrypt(tag(raw.toString("utf8"), "Encrypt") ?? "");
    const [event, token, openKfId] = ["Event", "Token", "OpenKfId"].map(name => tag(xml, name));
    return { events: event === "kf_msg_or_event" && openKfId ? await this.pull(openKfId, token) : [] };
  }
  async send(to: PlatformAddress, message: OutboundMessage, key: string): Promise<void> {
    const [openKfId] = to.threadId.split("|");
    // msgid must be unique per kf account, so the key's hash makes a repeated send fail with 95033.
    const msgid = createHash("sha256").update(key).digest("hex").slice(0, 32);
    try {
      await guardSend("WeChat KF send", () => this.call("/cgi-bin/kf/send_msg", { touser: to.senderId, open_kfid: openKfId, msgid, msgtype: "text", text: { content: message.text } }));
    } catch (error) {
      if (!(error instanceof AlreadySent)) throw error;
    }
  }
  async download(file: InboundFile): Promise<Buffer> {
    const path = "/cgi-bin/media/get";
    return this.authed(async token => {
      const response = await this.fetchImpl(`${BASE}${path}?access_token=${token}&media_id=${encodeURIComponent(file.ref)}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw this.rejection(path, response.status, {});
      const tooLarge = () => new Error(`WeChat KF file is over ${this.maxFileBytes} bytes`);
      if (Number(response.headers.get("content-length")) > this.maxFileBytes) throw tooLarge();
      const chunks: Uint8Array[] = []; let total = 0;
      for await (const chunk of response.body ?? []) {
        total += chunk.length;
        if (total > this.maxFileBytes) throw tooLarge();
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      // Failure is a JSON body with errcode; a file can be JSON too, so only that shape counts.
      if (response.headers.get("content-type")?.includes("json")) {
        let payload: KfPayload | undefined;
        try { payload = JSON.parse(bytes.toString("utf8")) as KfPayload; } catch { /* a file, not a failure */ }
        if (payload?.errcode) throw this.rejection(path, response.status, payload);
      }
      return bytes;
    });
  }
  private get crypto(): WeComCrypto { return new WeComCrypto(this.credentials.token, this.credentials.encodingAesKey, this.credentials.corpId); }
  private async pull(openKfId: string, token?: string): Promise<InboundEvent[]> {
    const events: InboundEvent[] = [];
    let cursor = this.cursors.get(openKfId);
    for (let more = true; more;) {
      const page = await this.call("/cgi-bin/kf/sync_msg", { open_kfid: openKfId, ...(token ? { token } : {}), ...(cursor ? { cursor } : {}), limit: 1000, voice_format: 0 });
      events.push(...(page.msg_list ?? []).flatMap(item => this.toEvent(item)));
      // An empty page can still have more behind it, so has_more decides.
      more = page.has_more === 1 && Boolean(page.next_cursor);
      cursor = page.next_cursor ?? cursor;
    }
    // Committed only once every page arrived: a failed pull starts again from the same place.
    if (cursor) this.cursors.set(openKfId, cursor);
    return events;
  }
  /** Customer messages only. Origin 4 (system events) and 5 (staff) are not the customer speaking. */
  private toEvent(item: KfMessage): InboundEvent[] {
    const { msgid, open_kfid: kfId, external_userid: customer, msgtype, location, link } = item;
    if (item.origin !== FROM_CUSTOMER || !msgid || !kfId || !customer) return [];
    const kind = msgtype && msgtype in FILE_NAMES ? msgtype as keyof typeof FILE_NAMES : undefined;
    const mediaId = kind && item[kind]?.media_id;
    const text = msgtype === "text" ? item.text?.content?.trim()
      : msgtype === "location" && location ? [location.name, location.address, `${location.latitude},${location.longitude}`].filter(Boolean).join("\n")
      : msgtype === "link" && link ? [link.title, link.desc, link.url].filter(Boolean).join("\n") : undefined;
    // Menus, mini programs, merged chats and the rest arrive as an event with no text and no file.
    return [{ eventId: msgid, address: { threadId: `${kfId}|${customer}`, senderId: customer }, messageRef: msgid, ...(text ? { text } : {}), ...(kind && mediaId ? { file: { ref: mediaId, name: FILE_NAMES[kind] } } : {}) }];
  }
  private async token(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) return this.cachedToken.value;
    const { corpId, secret } = this.credentials;
    const payload = await this.request(`/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`);
    if (!payload.access_token) throw new Error("WeChat KF returned no access token");
    this.cachedToken = { value: payload.access_token, expiresAt: Date.now() + (payload.expires_in ?? 0) * 1000 - TOKEN_MARGIN_MS };
    return payload.access_token;
  }
  /** One retry with a fresh token when WeCom says ours is stale. */
  private async authed<T>(run: (token: string) => Promise<T>): Promise<T> {
    try { return await run(await this.token()); } catch (error) {
      if (!(error instanceof StaleToken)) throw error;
      this.cachedToken = undefined;
      return run(await this.token());
    }
  }
  private call(path: string, body: object): Promise<KfPayload> {
    return this.authed(token => this.request(`${path}?access_token=${token}`, JSON.stringify(body)));
  }
  /** WeCom reports failures in errcode, with HTTP 200. */
  private async request(path: string, body?: string): Promise<KfPayload> {
    const response = await this.fetchImpl(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json; charset=utf-8" }, body }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as KfPayload;
    if (!response.ok || payload.errcode) throw this.rejection(path.split("?")[0]!, response.status, payload);
    return payload;
  }
  private rejection(path: string, status: number, payload: KfPayload): ChannelSendError {
    const code = payload.errcode;
    const message = `WeChat KF ${path} failed: ${code ? `${payload.errmsg ?? "error"} (errcode ${code})` : `HTTP ${status}`}`;
    if (!code) return new ChannelSendError(message, failureForStatus(status), { access: lostAccess(status) });
    if (code === 40014 || code === 42001) return new StaleToken(message, "definite");
    if (code === DUPLICATE_MSGID) return new AlreadySent(message, "permanent");
    if (RATE_LIMITED.has(code)) return new ChannelSendError(message, "definite", code === 45009 ? { retryAfterMs: 60_000 } : {});
    // -1 is "system busy": it may or may not have gone through.
    return new ChannelSendError(message, code === -1 ? "ambiguous" : "permanent", { access: ACCESS_LOST.has(code) });
  }
}
