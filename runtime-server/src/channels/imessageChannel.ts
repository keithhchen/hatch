import type { Content } from "@spectrum-ts/core";
import { imageMime } from "../factoryAgents/imageRefs.js";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { guardSend, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";

type IMessageConfig = { projectId?: string; projectSecret?: string; address?: string };
type SpectrumSpace = { type: "dm" | "group"; phone: string };
type SpectrumMessage = { id: string; direction: "inbound" | "outbound"; sender?: { id: string }; content: Content };

/** The part of Spectrum this adapter uses. Types only above: the SDK itself loads in connectSpectrum. */
export interface SpectrumClient {
  messages(): AsyncIterable<readonly [SpectrumSpace, SpectrumMessage]>;
  sendText(address: string, text: string): Promise<void>;
  attachment(guid: string, phone: string): Promise<Buffer | undefined>;
  stop(): Promise<void>;
}

async function connectSpectrum(config: IMessageConfig): Promise<SpectrumClient> {
  const [{ Spectrum }, { imessage }] = await Promise.all([import("@spectrum-ts/core"), import("@spectrum-ts/imessage")]);
  // Startup has no deadline of its own; one that hangs would stop the listener restarting.
  const app = await Spectrum({ projectId: config.projectId!, projectSecret: config.projectSecret!, providers: [imessage.config()], signal: AbortSignal.timeout(30_000) });
  const line = imessage(app);
  return {
    messages: () => line.messages,
    // Without phone a project with several lines picks one at random, and the Expert would hear from a stranger's number.
    sendText: async (address, text) => { await (await line.space.create(address, { phone: config.address! })).send(text); },
    attachment: async (guid, phone) => (await line.getAttachment(guid, phone))?.read(),
    stop: () => app.stop(),
  };
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };
const fileName = (name: string, mimeType: string) => {
  const extension = IMAGE_EXTENSIONS[mimeType.toLowerCase()];
  return extension && !imageMime(name) ? `${name || "photo"}${extension}` : name || "file";
};

/** Reactions, read receipts and the like yield nothing. A message we can't read yet yields an event with no text and no file. */
function toEvents(eventId: string, address: PlatformAddress, phone: string, content: Content): InboundEvent[] {
  switch (content.type) {
    case "text": return [{ eventId, address, text: content.text }];
    case "attachment": return [{ eventId, address, file: { ref: `${phone}|${content.id}`, name: fileName(content.name, content.mimeType), ...(content.size ? { size: content.size } : {}) } }];
    // A voice note is an attachment with its own id (an Apple CAF or m4a): fetched the same way.
    case "voice": return content.id ? [{ eventId, address, file: { ref: `${phone}|${content.id}`, name: content.name || "voice.caf", ...(content.size ? { size: content.size } : {}) } }] : [{ eventId, address }];
    case "reply": return toEvents(eventId, address, phone, content.content);
    // Text with attachments arrives as a group whose items have their own ids.
    case "group": return content.items.flatMap(item => toEvents(item.id, address, phone, item.content));
    case "contact": case "custom": case "app": case "richlink": return [{ eventId, address }];
    default: return [];
  }
}

/** iMessage through Photon's Spectrum. One official line; each Expert links their own address. */
export class IMessageChannel implements ChannelAdapter {
  readonly kind = "imessage" as const;
  readonly scope = "";
  /** Spectrum documents no limit. */
  readonly maxFileBytes = 20 * 1024 * 1024;
  private client?: Promise<SpectrumClient>;
  constructor(private config: IMessageConfig, private connect: (config: IMessageConfig) => Promise<SpectrumClient> = connectSpectrum) {}
  capabilities(): ChannelCapabilities { return { stream: false, edit: false, typing: false, buttons: false, maxLength: 8000, canInitiate: true, idempotentSend: false }; }
  available(): boolean { return Boolean(this.config.projectId && this.config.projectSecret && this.config.address); }
  /** RFC 5724. It needs a phone number, so a line that is an email address has no link. */
  connectUrl(code: string): string | undefined {
    return /^\+\d+$/.test(this.config.address ?? "") ? `sms:${this.config.address}?body=${encodeURIComponent(code)}` : undefined;
  }
  async listen(onEvents: (events: InboundEvent[]) => Promise<void>, signal: AbortSignal): Promise<void> {
    const client = await this.connection();
    const abort = () => { void client.stop().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) return;
      for await (const [space, message] of client.messages()) {
        if (space.type !== "dm" || message.direction !== "inbound" || !message.sender?.id) continue;
        const events = toEvents(message.id, { threadId: message.sender.id, senderId: message.sender.id }, space.phone, message.content);
        if (events.length) await onEvents(events);
      }
      if (!signal.aborted) throw new Error("iMessage stream ended");
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      this.client = undefined;
      await client.stop().catch(() => undefined);
    }
  }
  async send(to: PlatformAddress, message: OutboundMessage, _key: string): Promise<void> {
    await guardSend("iMessage send", async () => (await this.connection()).sendText(to.threadId, message.text));
  }
  async download(file: InboundFile): Promise<Buffer> {
    const split = file.ref.indexOf("|");
    const bytes = await (await this.connection()).attachment(file.ref.slice(split + 1), file.ref.slice(0, split));
    if (!bytes) throw new Error("iMessage attachment not found");
    return bytes;
  }
  private connection(): Promise<SpectrumClient> {
    this.client ??= this.connect(this.config).catch(error => { this.client = undefined; throw error; });
    return this.client;
  }
}
