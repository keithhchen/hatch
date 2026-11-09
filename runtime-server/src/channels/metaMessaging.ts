import type { ChannelCapabilities } from "../surfaces/contract.js";
import { buttonId, fitLabel, parseButtonId } from "./buttons.js";
import { MetaChannel, type Entry } from "./metaChannel.js";
import type { InboundEvent, OutboundMessage, PlatformAddress } from "./types.js";

const DAY_MS = 24 * 60 * 60_000;
const MAX_QUICK_REPLIES = 13;
const MAX_QUICK_TITLE = 20;
/** What a customer can send that we can read, and what to call it: a URL has no file name. */
const MEDIA: Record<string, string> = { image: "photo.jpg", audio: "voice.m4a", video: "video.mp4" };

/**
 * Instagram Messaging and Messenger speak the same webhook (`messaging[]`) and the same send. The customer is a stable
 * platform-scoped id (IGSID, PSID); they must write first, and a reply is allowed for 24 hours after.
 */
export abstract class MetaMessagingChannel extends MetaChannel {
  readonly client = "dm" as const;
  protected abstract readonly textLimit: number;
  protected abstract endpoint(tenant: string): string;
  /** Fields every send carries on this platform. */
  protected envelope: Record<string, unknown> = {};

  capabilities(): ChannelCapabilities {
    return { stream: false, edit: false, typing: true, buttons: true, maxLength: this.textLimit, replyWindowMs: DAY_MS, canInitiate: false, idempotentSend: false };
  }

  /** Delivery after failures can be out of order: events are read by their own timestamps. */
  protected events(entry: Entry): InboundEvent[] {
    const items = [...entry.messaging ?? []] as Array<Record<string, any>>;
    return items.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).flatMap(item => this.item(String(entry.id), item));
  }

  private item(tenant: string, item: Record<string, any>): InboundEvent[] {
    const sender = item.sender?.id as string | undefined;
    const { message, postback } = item;
    if (!sender || (!message && !postback) || message?.is_echo || message?.is_deleted) return [];
    const eventId = message?.mid ?? postback?.mid ?? `${tenant}:${sender}:${item.timestamp}`;
    const base = { address: { threadId: `${tenant}:${sender}`, senderId: sender }, scope: tenant, messageRef: eventId };
    const button = parseButtonId(message?.quick_reply?.payload ?? postback?.payload);
    if (button) return [{ eventId, ...base, button }];
    if (!message) return [];
    const files = (message.attachments ?? []).filter((attachment: any) => attachment.payload?.url && (attachment.type in MEDIA || attachment.type === "file"));
    const text = message.text ? { text: message.text as string } : {};
    if (!files.length) return [{ eventId, ...base, ...text }];
    return files.map((attachment: any, index: number) => ({
      eventId: index ? `${eventId}:${index}` : eventId, ...base, ...(index ? {} : text),
      file: { ref: attachment.payload.url as string, name: MEDIA[attachment.type] ?? (new URL(attachment.payload.url).pathname.split("/").pop() || "file") },
    }));
  }

  /** The platform's text limit may count bytes: a subclass cuts the text to what one message can hold. */
  protected chunks(text: string): string[] { return [text]; }

  protected requests(to: PlatformAddress, message: OutboundMessage): Array<{ url: string; body: unknown }> {
    const [tenant, contact] = MetaChannel.split(to.threadId);
    const replies = message.buttons?.length ? { quick_replies: message.buttons.slice(0, MAX_QUICK_REPLIES).map(button => ({ content_type: "text", title: fitLabel(button.label, MAX_QUICK_TITLE), payload: buttonId(button) })) } : {};
    const chunks = this.chunks(message.text);
    return chunks.map((text, index) => ({
      url: this.endpoint(tenant), body: { recipient: { id: contact }, ...this.envelope, message: { text, ...(index === chunks.length - 1 ? replies : {}) } },
    }));
  }
}
