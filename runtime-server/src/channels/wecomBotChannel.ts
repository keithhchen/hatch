import type { ChannelCapabilities } from "../surfaces/contract.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";
import { decryptWeComMedia, WeComCrypto } from "./wecomCrypto.js";

export type WeComBotCredentials = { token: string; encodingAesKey: string; botId?: string };

type Item = { msgtype?: string; text?: { content?: string }; image?: { url?: string } };
type WeComMessage = {
  msgid?: string;
  chatid?: string;
  chattype?: string;
  from?: { userid?: string };
  response_url?: string;
  msgtype?: string;
  text?: { content?: string };
  mixed?: { msg_item?: Item[] };
  voice?: { content?: string };
  image?: { url?: string };
  file?: { url?: string };
  video?: { url?: string };
};

/** WeCom answers 45009 when we call too fast: refused, nothing delivered. */
const RATE_LIMITED = 45009;
/** markdown.content is at most 20480 bytes; a UTF-16 unit is at most 3 bytes of UTF-8. */
const MAX_CONTENT_BYTES = 20480;
const RESPONSE_URL_VALID_MS = 60 * 60_000;
const MEDIA = { image: "image.jpg", file: "file", video: "video.mp4" } as const;

/**
 * WeCom smart bot in URL-callback mode. The bot cannot start a conversation: every message it sends is the one reply
 * a callback's response_url allows. Streaming replies need the long connection and are not used.
 */
export class WeComBotChannel implements ChannelAdapter {
  readonly kind = "wecom" as const;
  /** Media goes up to 100 MB; this is our cap, enforced in download. */
  readonly maxFileBytes = 50 * 1024 * 1024;
  constructor(private credentials: WeComBotCredentials, readonly scope: string, private fetchImpl: typeof fetch = fetch) {}
  /** One message of at most 20480 bytes per inbound message: its response_url works once. */
  capabilities(): ChannelCapabilities { return { stream: false, edit: false, typing: false, buttons: false, maxLength: MAX_CONTENT_BYTES, maxBytes: MAX_CONTENT_BYTES, replyWindowMs: RESPONSE_URL_VALID_MS, replyAllowance: 1, canInitiate: false, idempotentSend: false }; }
  available(): boolean { return Boolean(this.credentials.token) && this.credentials.encodingAesKey?.length === 43; }
  connectUrl(_code: string): undefined { return undefined; }
  verify(raw: Buffer, _headers: unknown, query?: URLSearchParams): boolean {
    try { return this.check(query, (JSON.parse(raw.toString("utf8")) as { encrypt?: string }).encrypt); } catch { return false; }
  }
  /** The GET that proves the URL is ours: the decrypted echostr, in the reply body alone. */
  challenge(query: URLSearchParams): string | undefined {
    try {
      const echostr = query.get("echostr") ?? undefined;
      return this.check(query, echostr) ? this.crypto.decrypt(echostr!) : undefined;
    } catch { return undefined; }
  }
  /** One event per message. Everything else, such as a stream refresh, enter_chat or feedback, needs no reply of ours: an empty body is the empty packet. */
  parse(raw: Buffer): { events: InboundEvent[] } {
    const { encrypt } = JSON.parse(raw.toString("utf8")) as { encrypt: string };
    const body = JSON.parse(this.crypto.decrypt(encrypt)) as WeComMessage;
    const userId = body.from?.userid;
    const type = body.msgtype;
    if (!body.msgid || !userId || !type || !["text", "mixed", "voice", ...Object.keys(MEDIA)].includes(type)) return { events: [] };
    const group = body.chattype === "group";
    const text = (type === "text" ? body.text?.content : type === "voice" ? body.voice?.content
      : type === "mixed" ? body.mixed?.msg_item?.filter(item => item.msgtype === "text").map(item => item.text?.content).join("\n") : undefined)?.trim();
    // A group message reaches us only when it @-mentions the bot, so the text starts with the mention.
    const said = group ? text?.replace(/^@\S+\s*/, "") : text;
    const url = type in MEDIA ? body[type as keyof typeof MEDIA]?.url : undefined;
    return { events: [{
      eventId: body.msgid,
      address: { threadId: group && body.chatid ? body.chatid : userId, senderId: userId },
      ...(group ? { group: true as const } : {}),
      ...(body.response_url ? { messageRef: body.response_url } : {}),
      ...(said ? { text: said } : {}),
      ...(url ? { file: { ref: url, name: MEDIA[type as keyof typeof MEDIA] } } : {}),
    }] };
  }
  /** The response_url allows one POST; a second after an ambiguous failure is refused by the platform. */
  async send(_to: PlatformAddress, message: OutboundMessage, _key: string): Promise<void> {
    if (!message.replyTo) throw new ChannelSendError("A WeCom smart bot can only reply to a message: there is no response_url", "permanent");
    await guardSend("WeCom send", async () => {
      const response = await this.fetchImpl(message.replyTo!, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: message.text } }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => ({})) as { errcode?: number; errmsg?: string };
      const what = `WeCom send failed: HTTP ${response.status}${payload.errcode ? ` ${payload.errmsg ?? ""} (errcode ${payload.errcode})` : ""}`;
      if (!response.ok) throw new ChannelSendError(what, failureForStatus(response.status), { access: lostAccess(response.status) });
      if (payload.errcode) throw new ChannelSendError(what, payload.errcode === RATE_LIMITED ? "definite" : "permanent");
    });
  }
  /** The URL needs no authorization and lives 5 minutes; the content is encrypted with the EncodingAESKey. */
  async download(file: InboundFile): Promise<Buffer> {
    const response = await this.fetchImpl(file.ref, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`WeCom media download failed: HTTP ${response.status}, the link may have expired (5 minutes)`);
    const tooLarge = () => new Error(`WeCom file is over ${this.maxFileBytes} bytes`);
    if (Number(response.headers.get("content-length")) > this.maxFileBytes) throw tooLarge();
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.length;
      if (total > this.maxFileBytes) throw tooLarge();
      chunks.push(chunk);
    }
    try { return decryptWeComMedia(Buffer.concat(chunks), this.credentials.encodingAesKey); }
    catch (error) { throw new Error(`WeCom media could not be decrypted, the link may have expired (5 minutes): ${(error as Error).message}`); }
  }
  private get crypto(): WeComCrypto { return new WeComCrypto(this.credentials.token, this.credentials.encodingAesKey); }
  private check(query: URLSearchParams | undefined, encrypted: string | undefined): boolean {
    return typeof encrypted === "string" && Boolean(query) && this.crypto.check(query!.get("msg_signature"), query!.get("timestamp") ?? "", query!.get("nonce") ?? "", encrypted);
  }
}
