import type { AssetShelf } from "./assets.js";
import { ConversationError, type Conversation, type SendInput, type Sent } from "./conversation.js";

/**
 * A conversation whose messages carry assets. Before delivery the bytes are put where the model reads them and
 * the assets are bound to the message, atomically in the database: of two concurrent sends of one asset, one is
 * delivered and the other refused. A message that fails to deliver gives its assets back. Put inside the idempotent
 * layer, so a replayed send never gets here: an asset that already belongs to a message is then really another message's.
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
    await this.shelf.desk.attach(this.shelf.scope, attachments, input.id);
    try { return await this.inner.send(input); } catch (error) {
      await this.shelf.desk.release(this.shelf.scope, attachments, input.id).catch(failure => console.error("[conversation assets]", failure));
      throw error;
    }
  }
}
