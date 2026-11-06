import type { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { page, publicEvent, type Conversation, type ConversationEvent, type ConversationStatus, type PublicMessage, type Sent, type Unsubscribe } from "./conversation.js";

/** The part of the Assistant an account-level conversation needs. */
export interface AssistantHost {
  view(accountId: string): Promise<{ messages: Array<{ id: string; role: "expert" | "assistant"; text: string; at: string; images?: string[] }>; running: boolean }>;
  ingest(accountId: string, item: { id: string; source: "web"; text: string }): Promise<boolean>;
  stop(accountId: string): Promise<void>;
  readonly events: EventEmitter;
}

/** The account's Assistant chat, in the same shape as a worker's. */
export class AssistantConversation implements Conversation {
  constructor(private accountId: string, private assistant: AssistantHost) {}

  async status(): Promise<ConversationStatus> { return { state: (await this.assistant.view(this.accountId)).running ? "running" : "idle" }; }

  async messages(after?: string, limit?: number) {
    const view = await this.assistant.view(this.accountId);
    const all = view.messages.map((line): PublicMessage => ({
      id: line.id, role: line.role === "expert" ? "user" : "assistant", text: line.text, created_at: line.at,
      ...(line.images?.length ? { attachments: line.images.map(name => ({ type: "image" as const, name })) } : {}),
    }));
    return { status: { state: view.running ? "running" as const : "idle" as const }, messages: page(all, after, limit) };
  }

  async send(content: string): Promise<Sent> {
    const queued = (await this.status()).state === "running";
    const id = randomUUID();
    await this.assistant.ingest(this.accountId, { id, source: "web", text: content });
    return { conversationId: this.accountId, queued, message: { id, role: "user", text: content, created_at: new Date().toISOString() } };
  }

  async events(listener: (event: ConversationEvent) => void): Promise<Unsubscribe> {
    const forward = (event: { accountId?: string }) => { const shown = event.accountId === this.accountId ? publicEvent(event) : undefined; if (shown) listener(shown); };
    this.assistant.events.on("event", forward);
    return () => { this.assistant.events.off("event", forward); };
  }

  stop(): Promise<void> { return this.assistant.stop(this.accountId); }
}
