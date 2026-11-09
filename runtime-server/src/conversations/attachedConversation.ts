import type { AssetShelf } from "./assets.js";
import { ConversationError, type Conversation, type SendInput, type Sent } from "./conversation.js";

/**
 * A conversation whose messages carry assets. Before delivery the bytes are put where the model reads them;
 * once the message is accepted its assets are bound to it. Put inside the idempotent layer, so a replayed
 * send never gets here: an asset that already belongs to a message is then really another message's.
 */
export class AttachedConversation implements Conversation {
  constructor(private inner: Conversation, private shelf: AssetShelf) {}

  status() { return this.inner.status(); }
  messages(after?: string, limit?: number) { return this.inner.messages(after, limit); }
  feedKey() { return this.inner.feedKey(); }
  stop() { return this.inner.stop(); }

  async send(input: SendInput): Promise<Sent> {
    const { attachments } = input;
    if (!attachments.length) return this.inner.send(input);
    const used = attachments.find(asset => asset.messageId);
    if (used) throw new ConversationError(409, "asset_already_used", `Asset ${used.id} already belongs to another message. Upload the file again to send it again.`);
    await this.shelf.desk.stage(this.shelf.scope, attachments);
    const sent = await this.inner.send(input);
    // The message is accepted: a failed binding is logged, never turned into a refusal of a message that is already delivered.
    await this.shelf.desk.attach(this.shelf.scope, attachments, sent.message.id).catch(error => console.error("[conversation assets]", error));
    return sent;
  }
}
