import type { ChannelCapabilities } from "../surfaces/contract.js";
import { buttonId, fitLabel, parseButtonId } from "./buttons.js";
import { ChannelPolicyError, type Eligibility } from "./eligibility.js";
import { GRAPH, MetaChannel, type Entry } from "./metaChannel.js";
import type { InboundEvent, InboundFile, OutboundMessage, PlatformAddress } from "./types.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
/** Interactive messages hold at most this much body text. */
const MAX_BUTTON_BODY = 1024;
/** A business-scoped user id: a country code, a dot, and an id. A phone number is digits. */
const BSUID = /^[A-Z]{2}\./;

/** Name an incoming media file from its type, since WhatsApp sends a name only for documents. */
function mediaName(message: Record<string, any>): string | undefined {
  const media = message[message.type];
  const extension = String(media?.mime_type ?? "").split(";")[0]!.split("/")[1];
  if (message.type === "document") return media.filename ?? "file";
  if (message.type === "image") return `photo.${extension ?? "jpg"}`;
  if (message.type === "audio") return `${media.voice ? "voice" : "audio"}.${extension ?? "ogg"}`;
  if (message.type === "video") return `video.${extension ?? "mp4"}`;
  return undefined;
}

/** An account change that ends our access to the business account. */
const ENDS_ACCESS = new Set(["PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED", "ACCOUNT_DELETED", "ACCOUNT_OFFBOARDED"]);

/**
 * WhatsApp Business Policy: an AI provider may not serve on the platform when general-purpose AI is the primary functionality.
 * The Assistant is a general-purpose assistant, so it is never eligible. A Product is eligible only on a Connection an operator
 * marked `taskSpecific`, which is never the default. Everything else fails with this error rather than being served.
 */
export const whatsappEligibility: Eligibility = connection => {
  if (connection.target.kind === "product" && connection.taskSpecific) return;
  throw new ChannelPolicyError("whatsapp_general_purpose_ai", "WhatsApp does not allow a general-purpose AI assistant as the primary function of a business number. This Agent has not been reviewed as a task-specific business agent.");
};

/**
 * WhatsApp Cloud API. One webhook serves every business account that installed the app: the tenant is the business account (WABA) id,
 * and a thread is `waba:phoneNumberId:contact`, since a send goes through one of its numbers.
 * The contact is their phone number, or their BSUID when they hide it. A reply is allowed for 24 hours after they last wrote;
 * after that only a template could be sent, and we never send one: the reply stays in Hatch as undelivered.
 */
export class WhatsAppChannel extends MetaChannel {
  readonly kind = "whatsapp" as const;
  readonly client = "im" as const;
  protected readonly object = "whatsapp_business_account";
  capabilities(): ChannelCapabilities {
    return { stream: false, edit: false, typing: true, buttons: true, maxLength: 4096, replyWindowMs: DAY_MS, canInitiate: false, idempotentSend: false };
  }

  protected events(entry: Entry): InboundEvent[] {
    const tenant = String(entry.id);
    return (entry.changes ?? []).flatMap((change: Entry): InboundEvent[] => {
      if (change.field === "account_update") return ENDS_ACCESS.has(change.value?.event) ? [this.revoked(String(change.value.waba_info?.waba_id ?? tenant), change.value.event, entry.time)] : [];
      const phoneNumberId = change.value?.metadata?.phone_number_id as string | undefined;
      const messages = [...change.value?.messages ?? []] as Array<Record<string, any>>;
      return change.field === "messages" && phoneNumberId ? messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).flatMap(message => this.message(tenant, phoneNumberId, message)) : [];
    });
  }

  private revoked(tenant: string, event: string, time: unknown): InboundEvent {
    return { eventId: `account_update:${tenant}:${event}:${time ?? ""}`, address: { threadId: tenant, senderId: tenant }, scope: tenant, revoked: true };
  }

  private message(tenant: string, phoneNumberId: string, message: Record<string, any>): InboundEvent[] {
    const sender = (message.from ?? message.from_user_id) as string | undefined;
    if (!sender) return [];
    const base = { eventId: message.id as string, address: { threadId: `${tenant}:${phoneNumberId}:${sender}`, senderId: sender }, scope: tenant, messageRef: message.id as string };
    const button = parseButtonId(message.interactive?.button_reply?.id);
    if (button) return [{ ...base, button }];
    if (message.type === "text") return [{ ...base, ...(message.text?.body ? { text: message.text.body } : {}) }];
    const name = mediaName(message);
    const media = message[message.type];
    if (!name || !media?.id) return [base];
    return [{ ...base, ...(media.caption ? { text: media.caption } : {}), file: { ref: `${tenant}:${media.id}`, name } }];
  }

  protected requests(to: PlatformAddress, message: OutboundMessage): Array<{ url: string; body: unknown }> {
    const { url, contact } = WhatsAppChannel.route(to);
    const common = { messaging_product: "whatsapp", recipient_type: "individual", ...(BSUID.test(contact) ? { recipient: contact } : { to: contact }), ...(message.replyTo ? { context: { message_id: message.replyTo } } : {}) };
    const text = (body: string) => ({ url, body: { ...common, type: "text", text: { body, preview_url: false } } });
    const buttons = message.buttons?.slice(0, MAX_BUTTONS) ?? [];
    if (!buttons.length) return [text(message.text)];
    const interactive = (body: string) => ({ url, body: { ...common, type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: buttons.map(button => ({ type: "reply", reply: { id: buttonId(button), title: fitLabel(button.label, MAX_BUTTON_TITLE) } })) } } } });
    // The body of a button message is short: a long reply goes first as plain text, and the buttons follow with their labels.
    return message.text.length <= MAX_BUTTON_BODY ? [interactive(message.text)] : [text(message.text), interactive(buttons.map(button => button.label).join(" / "))];
  }

  /** The send endpoint of the number a thread was written to, and the contact on it. */
  private static route(to: PlatformAddress): { tenant: string; url: string; contact: string } {
    const [tenant, rest] = MetaChannel.split(to.threadId);
    const at = rest.indexOf(":");
    return { tenant, url: `${GRAPH}/${rest.slice(0, at)}/messages`, contact: rest.slice(at + 1) };
  }

  /** The indicator lasts until we reply or 25 seconds, and needs the message it answers. */
  async typing(to: PlatformAddress, messageRef?: string): Promise<void> {
    const { tenant, url } = WhatsAppChannel.route(to);
    if (messageRef) await this.post(url, { messaging_product: "whatsapp", status: "read", message_id: messageRef, typing_indicator: { type: "text" } }, await this.token(tenant));
  }

  /** Proves the token reaches the business account and subscribes the app to it. Returns the account's name. */
  async probe(waba: string, token: string): Promise<{ name: string }> {
    const { name } = await this.call("GET", `${GRAPH}/${encodeURIComponent(waba)}?fields=name`, token);
    await this.call("POST", `${GRAPH}/${encodeURIComponent(waba)}/subscribed_apps`, token);
    return { name };
  }

  /** A media id becomes a short-lived URL, and the URL is fetched with the same token. */
  async download(file: InboundFile): Promise<Buffer> {
    const [tenant, mediaId] = MetaChannel.split(file.ref);
    const token = await this.token(tenant);
    const response = await this.fetchImpl(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const { url } = await response.json().catch(() => ({})) as { url?: string };
    if (!response.ok || !url) throw new Error(`WhatsApp media lookup failed: ${response.status}`);
    return this.fetchBytes(url, token);
  }
}
