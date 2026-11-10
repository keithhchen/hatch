import type { EventEmitter } from "node:events";
import { attachmentLines, type Workshop } from "./assets.js";
import { page, type RunFailure, type Conversation, type ConversationStatus, type PublicMessage, type SendInput, type Sent } from "./conversation.js";

type Attachment = { type: "image" | "file" | "audio"; name: string; assetId: string };

/** The part of the Assistant an account-level conversation needs. */
export interface AssistantHost {
  view(accountId: string): Promise<{ messages: Array<{ id: string; role: "expert" | "assistant"; text: string; at: string; images?: string[]; attachments?: Attachment[] }>; running: boolean; runId?: string; failure?: RunFailure }>;
  /** Accepts the message and says which Run took it, when one did. A message that waits for the next turn has no Run yet. */
  submit(accountId: string, item: { id: string; source: "web"; text: string; images?: string[]; attachments?: Attachment[] }): Promise<{ runId?: string }>;
  /** Where this account's Assistant keeps the files it reads, for uploads. */
  workshop(accountId: string): Workshop;
  stop(accountId: string): Promise<void>;
  readonly events: EventEmitter;
}

const wire = ({ type, name, assetId }: Attachment) => ({ type, name, asset_id: assetId });
const statusOf = (view: { running: boolean; runId?: string; failure?: RunFailure }): ConversationStatus =>
  view.running ? { state: "running", ...(view.runId ? { runId: view.runId } : {}) } : view.failure ? { state: "failed", error: view.failure } : { state: "idle" };

/** The account's Assistant chat, in the same shape as a worker's. */
export class AssistantConversation implements Conversation {
  constructor(private accountId: string, private assistant: AssistantHost) {}

  async status(): Promise<ConversationStatus> { return statusOf(await this.assistant.view(this.accountId)); }

  async messages(after?: string, limit?: number) {
    const view = await this.assistant.view(this.accountId);
    const all = view.messages.map((line): PublicMessage => ({
      id: line.id, role: line.role === "expert" ? "user" : "assistant", text: line.text, created_at: line.at,
      ...(line.attachments?.length ? { attachments: line.attachments.map(wire) } : line.images?.length ? { attachments: line.images.map(name => ({ type: "image" as const, name })) } : {}),
    }));
    return { status: statusOf(view), messages: page(all, after, limit) };
  }

  /** Whether the message joins the running turn is the Assistant's own decision in `ingest`. */
  async send(input: SendInput): Promise<Sent> {
    const queued = (await this.status()).state === "running";
    const images = input.attachments.filter(asset => asset.kind === "image").map(asset => asset.path);
    const text = [input.text, ...attachmentLines(input.attachments)].filter(Boolean).join("\n");
    const attachments = input.attachments.map(({ kind, name, id }) => ({ type: kind, name, assetId: id }));
    const { runId } = await this.assistant.submit(this.accountId, { id: input.id, source: "web", text, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
    return { conversationId: this.accountId, queued, ...(runId ? { runId } : {}), message: { id: input.id, role: "user", text: input.text, created_at: new Date().toISOString(), ...(attachments.length ? { attachments: attachments.map(wire) } : {}) } };
  }

  async feedKey(): Promise<string | undefined> { return `assistant:${this.accountId}`; }

  stop(): Promise<void> { return this.assistant.stop(this.accountId); }
}
