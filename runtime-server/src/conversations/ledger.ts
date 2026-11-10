import { createHash } from "node:crypto";
import { ConversationError, type Conversation, type ReadyAsset, type SendInput, type Sent } from "./conversation.js";

/** One message's identity for idempotency: its content and its attachments' bytes, in order. */
export const messageDigest = (text: string, attachments: readonly Pick<ReadyAsset, "sha256">[]): string =>
  createHash("sha256").update(JSON.stringify([text, attachments.map(asset => asset.sha256)])).digest("hex");

export type Claim = { fresh: true } | { fresh: false; digest: string; sent: Sent };

/**
 * Remembers which message a client key stood for. `claim` is atomic in the adapter:
 * of any number of concurrent claims on one key, exactly one is fresh.
 */
export interface MessageLedger {
  claim(scope: string, key: string, digest: string, sent: Sent): Promise<Claim>;
  /** The claim's message was delivered; replays return this. */
  settle(scope: string, key: string, sent: Sent): Promise<void>;
  /** The message was refused: the key stands for nothing, so the client may retry it. */
  release(scope: string, key: string): Promise<void>;
}

export class MemoryMessageLedger implements MessageLedger {
  private rows = new Map<string, { digest: string; sent: Sent }>();
  async claim(scope: string, key: string, digest: string, sent: Sent): Promise<Claim> {
    const existing = this.rows.get(`${scope}\0${key}`);
    if (existing) return { fresh: false, ...existing };
    this.rows.set(`${scope}\0${key}`, { digest, sent });
    return { fresh: true };
  }
  async settle(scope: string, key: string, sent: Sent): Promise<void> { const row = this.rows.get(`${scope}\0${key}`); if (row) row.sent = sent; }
  async release(scope: string, key: string): Promise<void> { this.rows.delete(`${scope}\0${key}`); }
}

/** A conversation whose sends are idempotent: the same key and content is the same message, the same key and other content is a conflict. */
export class IdempotentConversation implements Conversation {
  constructor(private inner: Conversation, private ledger: MessageLedger, private scope: string) {}

  status() { return this.inner.status(); }
  messages(after?: string, limit?: number) { return this.inner.messages(after, limit); }
  feedKey() { return this.inner.feedKey(); }
  get partial() { return this.inner.partial?.bind(this.inner); }
  stop() { return this.inner.stop(); }

  async send(input: SendInput): Promise<Sent> {
    const { key } = input;
    if (!key) return this.inner.send(input);
    const digest = messageDigest(input.text, input.attachments);
    const placeholder: Sent = { conversationId: this.scope, queued: false, message: { id: input.id, role: "user", text: input.text, created_at: new Date().toISOString() } };
    const claim = await this.ledger.claim(this.scope, key, digest, placeholder);
    if (!claim.fresh) {
      if (claim.digest !== digest) throw new ConversationError(409, "idempotency_conflict", "This idempotency key was used for a different message.");
      return claim.sent;
    }
    try {
      const sent = await this.inner.send(input);
      await this.ledger.settle(this.scope, key, sent);
      return sent;
    } catch (error) {
      await this.ledger.release(this.scope, key);
      throw error;
    }
  }
}
