import { pathsFor } from "../assets/views.js";
import type { ConversationRecord } from "../conversationRepository.js";
import type { ChatAssets } from "../chat/assets.js";

/** A file or picture the Expert sent the Assistant, as the workers that need it can read it. */
export type Material = {
  /** Where the Assistant's own tools show it: the path the model read in the conversation. */
  chatPath: string;
  /** A name of its own, so two files with one name never share a path. */
  name: string;
  kind: "image" | "file";
  /** A file as the text it was read as; a picture as its resized pixels. */
  bytes: Buffer;
  mimeType: string;
};

const safeName = (name: string): string => name.normalize("NFC").replace(/[\\/:\x00-\x1f]+/g, "-").replace(/^\.+/, "").slice(-120) || "file";
const IMAGE_EXTENSION: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

/**
 * What the Expert has sent the Assistant, read from the conversation's own attachments: the one place it lives.
 * Workers and Products get a copy of the text when work starts; they never get a second record of the file.
 */
export class ExpertMaterials {
  constructor(private readonly deps: { assets: ChatAssets; conversation: (accountId: string) => Promise<ConversationRecord> }) {}

  async list(accountId: string): Promise<Material[]> {
    const conversation = await this.deps.conversation(accountId);
    const byMessage = new Map<string, Awaited<ReturnType<ChatAssets["attachments"]>>>();
    for (const attached of await this.deps.assets.attachments(conversation)) byMessage.set(attached.messageId, [...byMessage.get(attached.messageId) ?? [], attached]);
    const materials: Material[] = [];
    for (const [messageId, attached] of byMessage) {
      const paths = pathsFor(messageId, attached.map(entry => entry.asset));
      for (const { asset } of attached) {
        if (asset.record.kind === "audio") continue;
        const image = asset.record.kind === "image";
        const resized = image ? asset.derivative("resized") : undefined;
        const bytes = await this.deps.assets.derivative(asset, image ? "resized" : "text");
        if (!bytes) continue;
        materials.push({
          chatPath: paths.get(asset.id)!, kind: image ? "image" : "file", bytes,
          name: `${asset.id.slice(0, 8)}-${safeName(asset.record.name)}${image ? IMAGE_EXTENSION[resized?.mime ?? ""] ?? ".jpg" : ".md"}`,
          mimeType: image ? resized?.mime ?? "image/jpeg" : "text/markdown"
        });
      }
    }
    return materials;
  }
}
