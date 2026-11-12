import type { Asset, AssetScope } from "../assets/domain.js";
import { ConversationError, type ReadyAsset } from "./conversation.js";
import type { ContentPart } from "../surfaces/contract.js";

/** Resolves an uploaded asset in one conversation's scope. Nothing here knows how assets are stored. */
export interface AssetResolver {
  /** The asset when it exists in the scope and is ready; `pending` when it exists but is not ready yet. */
  resolve(scope: AssetScope, assetId: string): Promise<ReadyAsset | "pending" | undefined>;
  /** Puts what the model reads where it reads it. Runs before the message is delivered, and is safe to repeat. */
  stage(scope: AssetScope, assets: readonly ReadyAsset[]): Promise<void>;
  /**
   * Links the assets to the message about to be delivered. The same asset may join any number of messages. Safe to repeat for the same message.
   */
  attach(scope: AssetScope, assets: readonly ReadyAsset[], messageId: string): Promise<void>;
  /** Drops the links of a message that was not delivered. */
  release(scope: AssetScope, assets: readonly ReadyAsset[], messageId: string): Promise<void>;
}

/** Where a conversation keeps the files its model reads, and the path each asset gets there. Nothing for a voice message. */
export type Workshop = { files: { writeManual(path: string, bytes: Buffer): Promise<void> }; place(asset: Asset): string };

export type UploadedAsset = { asset_id: string; kind: ReadyAsset["kind"]; name: string; bytes: number; state: "ready" | "processing" };

/** Takes a file from a client. A file that cannot become a ready asset is refused with a ConversationError saying why. */
export interface AssetUploader {
  upload(scope: AssetScope, input: { name: string; bytes: Buffer }): Promise<UploadedAsset>;
}

/** Shows a client what it uploaded: the form made for viewing, which only an image has. */
export interface AssetViewer {
  view(scope: AssetScope, assetId: string): Promise<{ bytes: Buffer; mime: string } | undefined>;
}

export type AssetDesk = AssetResolver & AssetUploader & AssetViewer;

/** What a conversation offers for attachments: the scope they live in and the desk that handles them. */
export type AssetShelf = { scope: AssetScope; desk: AssetDesk };

export type Content = { text: string; attachments: ReadyAsset[] };

/** The ContentPart[] a client sent, as text plus ready assets. Voice messages count as their transcript. */
export async function resolveContent(parts: readonly ContentPart[], shelf: AssetShelf | undefined): Promise<Content> {
  const texts: string[] = [];
  const attachments: ReadyAsset[] = [];
  for (const part of parts) {
    if (part.type === "text") { texts.push(part.text); continue; }
    if (!shelf) throw new ConversationError(501, "attachments_unavailable", "This conversation cannot take attachments.");
    const asset = await shelf.desk.resolve(shelf.scope, part.assetId);
    if (!asset) throw new ConversationError(404, "asset_not_found", `No asset ${part.assetId}.`);
    if (asset === "pending") throw new ConversationError(409, "asset_not_ready", `Asset ${part.assetId} is not ready yet. Send the message when it is.`);
    if (asset.kind !== part.type) throw new ConversationError(400, "asset_kind_mismatch", `Asset ${part.assetId} is a ${asset.kind}, not an ${part.type}.`);
    attachments.push(asset);
    if (asset.kind === "audio" && asset.transcript) texts.push(asset.transcript);
  }
  return { text: texts.join("\n\n").trim(), attachments };
}

/** `content` as a client may send it: a string, or ContentPart[]. Anything else is the caller's mistake. */
export function parseContent(value: unknown): ContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  const parts: Array<{ type?: unknown; text?: unknown; assetId?: unknown }> = Array.isArray(value) ? value : [];
  const valid = parts.length > 0 && parts.every(part => part && (part.type === "text" ? typeof part.text === "string" : ["image", "file", "audio"].includes(part.type as string) && typeof part.assetId === "string" && part.assetId));
  if (!valid) throw new ConversationError(400, "invalid_message", "content must be text or a list of text, image, file and audio parts.");
  return parts as ContentPart[];
}

/** How the model sees an attachment that is not pixels: one line. A voice message is its transcript, so it has none. */
export const attachmentLines = (assets: readonly ReadyAsset[]): string[] => assets.filter(asset => asset.kind === "file").map(attachmentLine);

const attachmentLine = (asset: ReadyAsset): string => `[${asset.kind}: ${asset.name} (${asset.mimeType}, ${asset.bytes} bytes) at ${asset.path}]`;
