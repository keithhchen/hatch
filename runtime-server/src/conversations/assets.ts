import { ConversationError, type ReadyAsset } from "./conversation.js";
import type { ContentPart } from "../surfaces/contract.js";

/** Resolves an uploaded asset for an account. Implemented by the upload side; nothing here knows how assets are stored. */
export interface AssetResolver {
  /** The asset when it exists, belongs to the account and is ready; `pending` when it exists but is not ready yet. */
  resolve(accountId: string, assetId: string): Promise<ReadyAsset | "pending" | undefined>;
}

export type Content = { text: string; attachments: ReadyAsset[] };

/** The ContentPart[] a client sent, as text plus ready assets. Voice messages count as their transcript. */
export async function resolveContent(parts: readonly ContentPart[], accountId: string, assets: AssetResolver | undefined): Promise<Content> {
  const texts: string[] = [];
  const attachments: ReadyAsset[] = [];
  for (const part of parts) {
    if (part.type === "text") { texts.push(part.text); continue; }
    if (!assets) throw new ConversationError(501, "attachments_unavailable", "This server cannot accept attachments.");
    const asset = await assets.resolve(accountId, part.assetId);
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

/** How the model sees an attachment that is not pixels: one line. */
export const attachmentLine = (asset: ReadyAsset): string => `[${asset.kind}: ${asset.name} (${asset.mimeType}, ${asset.bytes} bytes) at ${asset.path}]`;
