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

/**
 * WhatsApp Business Policy: an AI provider may not serve on the platform when general-purpose AI is the primary functionality.
 * The Assistant is a general-purpose assistant, so it is never eligible. A Product is eligible only once someone reviewed it
 * as a task-specific business agent and listed it. Everything else fails with this error rather than being served.
 */
export const whatsappEligibility = (reviewedProducts: ReadonlySet<string>): Eligibility => connection => {
  if (connection.target.kind === "product" && reviewedProducts.has(connection.target.productId)) return;
  throw new ChannelPolicyError("whatsapp_general_purpose_ai", "WhatsApp does not allow a general-purpose AI assistant as the primary function of a business number. This Agent has not been reviewed as a task-specific business agent.");
};

/**
 * WhatsApp Cloud API. One webhook serves every business number that installed the app: the tenant is the phone number id.
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
    return (entry.changes ?? []).filter((change: Entry) => change.field === "messages").flatMap((change: Entry) => {
      const phoneNumberId = change.value?.metadata?.phone_number_id as string | undefined;
      const messages = [...change.value?.messages ?? []] as Array<Record<string, any>>;
      return phoneNumberId ? messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).flatMap(message => this.message(phoneNumberId, message)) : [];
    });
  }

  private message(tenant: string, message: Record<string, any>): InboundEvent[] {
    const sender = (message.from ?? message.from_user_id) as string | undefined;
    if (!sender) return [];
    const base = { eventId: message.id as string, address: { threadId: `${tenant}:${sender}`, senderId: sender }, scope: tenant, messageRef: message.id as string };
    const button = parseButtonId(message.interactive?.button_reply?.id);
    if (button) return [{ ...base, button }];
    if (message.type === "text") return [{ ...base, ...(message.text?.body ? { text: message.text.body } : {}) }];
    const name = mediaName(message);
    const media = message[message.type];
    if (!name || !media?.id) return [base];
    return [{ ...base, ...(media.caption ? { text: media.caption } : {}), file: { ref: `${tenant}:${media.id}`, name } }];
  }

  protected requests(to: PlatformAddress, message: OutboundMessage): Array<{ url: string; body: unknown }> {
    const [tenant, contact] = MetaChannel.split(to.threadId);
    const url = `${GRAPH}/${tenant}/messages`;
    const common = { messaging_product: "whatsapp", recipient_type: "individual", ...(BSUID.test(contact) ? { recipient: contact } : { to: contact }), ...(message.replyTo ? { context: { message_id: message.replyTo } } : {}) };
    const text = (body: string) => ({ url, body: { ...common, type: "text", text: { body, preview_url: false } } });
    const buttons = message.buttons?.slice(0, MAX_BUTTONS) ?? [];
    if (!buttons.length) return [text(message.text)];
    const interactive = (body: string) => ({ url, body: { ...common, type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: buttons.map(button => ({ type: "reply", reply: { id: buttonId(button), title: fitLabel(button.label, MAX_BUTTON_TITLE) } })) } } } });
    // The body of a button message is short: a long reply goes first as plain text, and the buttons follow with their labels.
    return message.text.length <= MAX_BUTTON_BODY ? [interactive(message.text)] : [text(message.text), interactive(buttons.map(button => button.label).join(" / "))];
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
