import { createHash } from "node:crypto";
import type { ConversationRecord } from "../conversationRepository.js";
import { AssetError, type Asset, type AssetBlobs, type AssetScope } from "../assets/domain.js";
import type { AssetPipeline } from "../assets/pipeline.js";
import { attachmentTools, type AttachmentTool } from "../assets/tools.js";
import { fileLine, imageLabel, pathsFor } from "../assets/views.js";
import type { AttachmentFiles } from "../assets/files.js";
import type { UploadedAsset } from "../conversations/assets.js";
import { clientMessageInputDigest, MAX_USER_MESSAGE_CHARS, type ConversationMessage } from "../protocol.js";
import type { ContentPart } from "../surfaces/contract.js";
import { ChatError } from "./principal.js";

const MAX_ASSETS_PER_MESSAGE = 10;

/**
 * Where a conversation's assets live. It follows the conversation's owner, so a client or the model can never name
 * another scope: a contact's files stay with that contact in that Connection, and an account's with that account.
 */
export function assetScopeOf(conversation: Pick<ConversationRecord, "id" | "ownerAccountId">): AssetScope {
  const [kind, connectionId, ...rest] = conversation.ownerAccountId.split(":");
  const contactId = rest.join(":");
  return kind === "contact" && connectionId && contactId
    ? { kind: "contact", connectionId, contactId, conversationId: conversation.id }
    : { kind: "account", accountId: conversation.ownerAccountId, conversationId: conversation.id };
}

const STATUS: Record<AssetError["code"], number> = {
  too_large: 413, unsupported_type: 415, unsafe_archive: 422, malformed: 422, moderation_blocked: 422, unavailable: 503, not_found: 404, not_ready: 409, conflict: 409
};
const CODE: Record<string, string> = { not_found: "asset_not_found", not_ready: "asset_not_ready", conflict: "asset_conflict", processing_failed: "asset_failed" };

/** What a client sees of an asset failure: a stable code and the reason. */
export const refusal = (error: unknown): unknown => error instanceof AssetError
  ? new ChatError(CODE[error.code] ?? error.code, error.message, STATUS[error.code])
  : error;

/** A platform event id may hold characters a path cannot, so the message id in /attachments/<id>/ is derived from it. */
export const attachmentMessageId = (clientMessageId: string): string => `msg_${createHash("sha256").update(clientMessageId).digest("hex").slice(0, 16)}`;

export type PreparedMessage = { digest: string; message: () => Promise<ConversationMessage> };

/** Turns message parts into the canonical user message and the digest that makes a retry safe. */
export interface PartsReader {
  /** Resolves what the parts refer to and fixes the digest. The message is built, and assets are bound to it, only when the client key is new. */
  prepare(parts: ContentPart[], conversation: ConversationRecord, clientMessageId: string): Promise<PreparedMessage>;
}

/** Text only: used where no asset service is configured. Refuses an attachment rather than dropping it. */
export class TextPartsReader implements PartsReader {
  async prepare(parts: ContentPart[]): Promise<PreparedMessage> {
    if (parts.some((part) => part.type !== "text")) throw new ChatError("attachments_unavailable", "This Runtime cannot take attachments.", 501);
    const content = parts.map((part) => (part as { text: string }).text).join("\n");
    return { digest: clientMessageInputDigest({ content }), message: async () => ({ role: "user", content }) };
  }
}

/** The upload pipeline as Chat uses it, for every client: ready assets in the conversation's scope. */
export class ChatAssets implements PartsReader {
  constructor(private readonly deps: { pipeline: AssetPipeline; blobs: AssetBlobs; files: AttachmentFiles }) {}

  /** Upload first, reference by assetId: the file is a ready asset, or refused with the reason, before any message is sent. */
  async upload(conversation: ConversationRecord, input: { name: string; bytes: Buffer }): Promise<UploadedAsset> {
    try {
      const asset = await this.deps.pipeline.accept(assetScopeOf(conversation), input);
      if (asset.state === "failed") throw new AssetError(asset.record.failure!.code as AssetError["code"], asset.record.failure!.message);
      return { asset_id: asset.id, kind: asset.record.kind, name: asset.record.name, bytes: asset.record.bytes, state: asset.state === "ready" ? "ready" : "processing" };
    } catch (error) { throw refusal(error); }
  }

  async prepare(parts: ContentPart[], conversation: ConversationRecord, clientMessageId: string): Promise<PreparedMessage> {
    const scope = assetScopeOf(conversation);
    const referenced = parts.filter((part) => part.type !== "text") as Array<Exclude<ContentPart, { type: "text" }>>;
    if (referenced.length > MAX_ASSETS_PER_MESSAGE) throw new ChatError("too_many_assets", `A message takes at most ${MAX_ASSETS_PER_MESSAGE} attachments.`, 400);
    if (new Set(referenced.map((part) => part.assetId)).size !== referenced.length) throw new ChatError("duplicate_asset", "An asset can appear once in a message.", 400);
    const assets = new Map<string, Asset>();
    for (const part of referenced) {
      const asset = await this.deps.pipeline.resolveReadyAsset(scope, part.assetId).catch((error) => { throw refusal(error); });
      if (asset.record.kind !== part.type) throw new ChatError("asset_kind_mismatch", `Asset ${part.assetId} is a ${asset.record.kind}, not an ${part.type}.`, 400);
      assets.set(part.assetId, asset);
    }
    const texts = parts.flatMap((part) => part.type === "text" ? [part.text] : []);
    const digest = referenced.length === 0
      ? clientMessageInputDigest({ content: texts.join("\n") })
      : `sha256:${createHash("sha256").update(JSON.stringify(parts.map((part) => part.type === "text" ? part : { type: part.type, sha256: assets.get(part.assetId)!.record.sha256 }))).digest("hex")}`;
    return { digest, message: () => this.build(parts, assets, scope, attachmentMessageId(clientMessageId)) };
  }

  /** The message the model reads: text as written, a voice message as its transcript, an image as pixels beside its path, a file as one line. */
  private async build(parts: ContentPart[], assets: Map<string, Asset>, scope: AssetScope, messageId: string): Promise<ConversationMessage> {
    // Binding is atomic and per asset: an asset of another message is refused here, before the message is accepted.
    const bound = new Map<string, Asset>();
    for (const [id] of assets) bound.set(id, await this.deps.pipeline.attach(scope, id, messageId).catch((error) => { throw refusal(error); }));
    const paths = pathsFor(messageId, [...bound.values()]);
    const lines: string[] = [];
    const images: NonNullable<ConversationMessage["model_images"]> = [];
    for (const part of parts) {
      if (part.type === "text") { lines.push(part.text); continue; }
      const asset = bound.get(part.assetId)!;
      const path = paths.get(asset.id)!;
      if (part.type === "audio") { lines.push(asset.record.transcript ?? ""); continue; }
      if (part.type === "file") { lines.push(fileLine(asset, path)); continue; }
      const resized = asset.derivative("resized");
      if (!resized) throw new ChatError("asset_incomplete", `Asset ${asset.id} has no resized image.`, 500);
      images.push({ type: "image", mimeType: resized.mime, data: (await this.deps.blobs.get(resized.key)).toString("base64") });
      lines.push(imageLabel(path));
    }
    const content = lines.join("\n");
    if (content.length > MAX_USER_MESSAGE_CHARS) throw new ChatError("message_too_long", "This message is too long.", 413);
    return { role: "user", content, ...(images.length ? { model_images: images } : {}) };
  }

  /** The full list, declared once for every Run. */
  tools(): AttachmentTool[] { return attachmentTools(this.deps.files); }

  /** The scope arrives with the conversation, never from the model. */
  toolsFor(conversation: Pick<ConversationRecord, "id" | "ownerAccountId">): { run(name: string, args: unknown): Promise<string> } {
    const scope = assetScopeOf(conversation);
    const byName = new Map(this.tools().map((tool) => [tool.name, tool]));
    return { run: async (name, args) => {
      const tool = byName.get(name);
      if (!tool) throw new Error(`No attachment tool: ${name}`);
      return tool.run(scope, args);
    } };
  }
}
