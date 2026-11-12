import { createHash } from "node:crypto";
import type { ConversationRecord } from "../conversationRepository.js";
import { clientMessageInputDigest, persistedAttachment, type ConversationMessage, type RunStart } from "../protocol.js";
import type { ContentPart } from "../surfaces/contract.js";
import type { ChatAssets, PartsReader, PreparedMessage } from "./assets.js";
import { ChatError } from "./principal.js";

type Attachment = NonNullable<RunStart["message"]["attachments"]>[number];
type AssetAttachment = Extract<Attachment, { kind: "asset" }>;

const isAsset = (attachment: Attachment): attachment is AssetAttachment => "kind" in attachment && attachment.kind === "asset";

/**
 * The WebSocket's message, put through the pipeline every other transport uses. Its uploaded assets become
 * ContentParts, so `parts.prepare` binds them in the accepting transaction and a retry digests the same way.
 * Inline text and local-file references carry no stored bytes, so they stay on the message as they were sent.
 */
export async function prepareSocketMessage(
  edge: { parts: PartsReader; chatAssets?: ChatAssets },
  message: RunStart["message"],
  conversation: ConversationRecord,
  clientMessageId: string
): Promise<PreparedMessage> {
  const attachments = message.attachments ?? [];
  const uploads = attachments.filter(isAsset);
  if (uploads.length === 0) {
    return { digest: clientMessageInputDigest(message), message: async () => legacyMessage(message.content, attachments) };
  }
  if (!edge.chatAssets) throw new ChatError("attachments_unavailable", "This Runtime cannot take attachments.", 501);
  const parts: ContentPart[] = message.content ? [{ type: "text", text: message.content }] : [];
  for (const upload of uploads) {
    if (!upload.data_base64) throw new ChatError("attachment_bytes_required", `Attachment ${upload.attachment_id} must carry its bytes.`, 400);
    const stored = await edge.chatAssets.upload(conversation, { name: upload.display_name, bytes: Buffer.from(upload.data_base64, "base64") });
    parts.push({ type: stored.kind, assetId: stored.asset_id });
  }
  const prepared = await edge.parts.prepare(parts, conversation, clientMessageId);
  const rest = attachments.filter((attachment) => !isAsset(attachment));
  if (rest.length === 0) return prepared;
  return {
    ...prepared,
    digest: `sha256:${createHash("sha256").update(prepared.digest).update(clientMessageInputDigest({ content: "", attachments: rest })).digest("hex")}`,
    message: async () => {
      const built = await prepared.message();
      const extra = legacyMessage("", rest);
      return { ...built, attachments: extra.attachments, model_images: [...(built.model_images ?? []), ...(extra.model_images ?? [])] };
    }
  };
}

/** Text context and local-file references as the model reads them; an image's bytes go to the model, never to the transcript. */
function legacyMessage(content: string, attachments: Attachment[]): ConversationMessage {
  const modelImages: NonNullable<ConversationMessage["model_images"]> = [];
  for (const attachment of attachments) {
    if ("kind" in attachment && attachment.kind === "local_file" && attachment.media_type.startsWith("image/")) {
      modelImages.push({ type: "image", mimeType: attachment.media_type, data: attachment.data_base64! });
    }
  }
  return { role: "user", content, model_images: modelImages, ...(attachments.length > 0 ? { attachments: attachments.map(persistedAttachment) } : {}) };
}
