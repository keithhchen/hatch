import type { AssetShelf } from "./assets.js";
import type { Conversation, SendInput, Sent } from "./conversation.js";

/**
 * A conversation whose messages carry assets. Before delivery the bytes are put where the model reads them and
 * the assets are linked to the message. The same file may be sent in any number of messages. A message that fails to
 * deliver gives its links back. Put inside the idempotent layer, so a replayed send never gets here.
 */
export class AttachedConversation implements Conversation {
  constructor(private inner: Conversation, private shelf: AssetShelf) {}

  status() { return this.inner.status(); }
  messages(after?: string, limit?: number) { return this.inner.messages(after, limit); }
  feedKey() { return this.inner.feedKey(); }
  get partial() { return this.inner.partial?.bind(this.inner); }
  stop() { return this.inner.stop(); }

  async send(input: SendInput): Promise<Sent> {
    const { attachments } = input;
    if (!attachments.length) return this.inner.send(input);
    await this.shelf.desk.stage(this.shelf.scope, attachments);
    await this.shelf.desk.attach(this.shelf.scope, attachments, input.id);
    try { return await this.inner.send(input); } catch (error) {
      await this.shelf.desk.release(this.shelf.scope, attachments, input.id).catch(failure => console.error("[conversation assets]", failure));
      throw error;
    }
  }
}
