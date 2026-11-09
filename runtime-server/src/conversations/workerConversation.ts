import type { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import { AgentDependenciesNotReadyError, type AgentEntry } from "../factoryAgents/definitions.js";
import { userMessage } from "../factoryAgents/imageRefs.js";
import type { Role, Session, WorkbenchStore } from "../factoryAgents/store.js";
import { attachmentLine } from "./assets.js";
import { ConversationError, page, type Conversation, type ConversationStatus, type SendInput, type Sent } from "./conversation.js";
import { projectMessages } from "./project.js";
import { blocked, blockedBy, blockedMessage, WORKERS, type Worker, type WorkerRegistry } from "./workers.js";

/** The part of a Product workspace a worker conversation needs. */
export interface WorkerWorkspace {
  store: Pick<WorkbenchStore, "list" | "create">;
  runtime: Pick<WorkbenchRuntime, "send" | "stop" | "events">;
  entries(): Promise<AgentEntry[]>;
  /** Throws AgentDependenciesNotReadyError when the worker's dependencies have no output yet. */
  assertRoleAvailable(role: Role): Promise<void>;
}

const statusOf = (session?: Session): ConversationStatus =>
  session?.status === "running" ? { state: "running" } : session?.status === "failed" ? { state: "failed", ...(session.error ? { error: session.error } : {}) } : { state: "idle" };

/** One worker's session in a Product workspace, as a conversation. The session is created by the first message. */
export class WorkerConversation implements Conversation {
  constructor(private worker: Worker, private workspace: WorkerWorkspace, private registry: WorkerRegistry = WORKERS) {}

  private async session(): Promise<Session | undefined> { return (await this.workspace.store.list()).find(session => session.role === this.worker.role); }

  async status(): Promise<ConversationStatus> { return statusOf(await this.session()); }

  async messages(after?: string, limit?: number) {
    const session = await this.session();
    const status = statusOf(session);
    return { status, messages: session ? page(projectMessages(session.messages), after, limit) : [] };
  }

  /** The runtime decides atomically whether this steers the running turn or starts one. */
  async send(input: SendInput): Promise<Sent> {
    await this.assertAvailable();
    const session = await this.session() ?? await this.workspace.store.create(this.worker.role);
    const images = input.attachments.filter(asset => asset.kind === "image").map(asset => asset.path);
    const lines = input.attachments.filter(asset => asset.kind !== "image").map(attachmentLine);
    const attachments = input.attachments.map(({ kind, name, id }) => ({ type: kind, name, assetId: id }));
    const message = userMessage([input.text, ...lines].filter(Boolean).join("\n"), images, { kind: "expert", itemId: input.id, text: input.text, attachments });
    const { queued } = await this.workspace.runtime.send(session.id, message, input.client);
    return {
      conversationId: session.id, queued,
      message: { id: input.id, role: "user", text: input.text, created_at: new Date().toISOString(), ...(attachments.length ? { attachments: attachments.map(({ type, name, assetId }) => ({ type, name, asset_id: assetId })) } : {}) },
    };
  }

  async feedKey(): Promise<string | undefined> { return (await this.session())?.id; }

  async stop(): Promise<void> { const session = await this.session(); if (session) this.workspace.runtime.stop(session.id); }

  private async assertAvailable(): Promise<void> {
    try { await this.workspace.assertRoleAvailable(this.worker.role); } catch (error) {
      if (!(error instanceof AgentDependenciesNotReadyError)) throw error;
      const reason = blocked(error.details, this.registry);
      throw new ConversationError(409, "worker_unavailable", blockedMessage(this.worker.id, reason), { worker: this.worker.id, ...reason });
    }
  }
}

/** The Product's workers: what exists, what can start, what is running. */
export class WorkerDirectory {
  constructor(private workspace: WorkerWorkspace, private registry: WorkerRegistry = WORKERS) {}

  conversation(workerId: string): Conversation | undefined {
    const worker = this.registry.byId(workerId);
    return worker && new WorkerConversation(worker, this.workspace, this.registry);
  }

  async list() {
    const [entries, sessions] = await Promise.all([this.workspace.entries(), this.workspace.store.list()]);
    return this.registry.all.map(worker => {
      const entry = entries.find(candidate => candidate.role === worker.role);
      const session = sessions.find(candidate => candidate.role === worker.role);
      const reason = entry && blockedBy(entry, this.registry);
      return {
        id: worker.id,
        name: entry?.name.en ?? worker.id,
        availability: reason ? "locked" : "available",
        ...(reason ? { blocked_by: reason } : {}),
        status: statusOf(session).state === "running" ? "running" : "idle",
        ...(session ? { conversation_id: session.id, updated_at: session.updatedAt } : {}),
      };
    });
  }
}
