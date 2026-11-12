import type { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import { BuildNotReadyError, type AgentEntry } from "../factoryAgents/definitions.js";
import { userMessage } from "../factoryAgents/imageRefs.js";
import type { MessageOrigin, Role, Session, WorkbenchStore } from "../factoryAgents/store.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { attachmentLines } from "./assets.js";
import { failureOf } from "../factoryAgents/runFailure.js";
import { ConversationError, page, type Conversation, type ConversationStatus, type SendInput, type Sent } from "./conversation.js";
import { projectMessages } from "./project.js";
import { blockedBy, blockedMessage, WORKERS, type Worker, type WorkerRegistry } from "./workers.js";

/** The part of a Product workspace a worker conversation needs. */
export interface WorkerWorkspace {
  store: Pick<WorkbenchStore, "list" | "create"> & { backend: Pick<WorkbenchStore["backend"], "writeManual"> };
  runtime: Pick<WorkbenchRuntime, "send" | "stop" | "events" | "runId" | "queued">;
  entries(): Promise<AgentEntry[]>;
  /** Throws BuildNotReadyError when Build has neither uploads nor interview output. */
  assertRoleAvailable(role: Role): Promise<void>;
}

const originOf = (message: AgentMessage) => (message as { origin?: MessageOrigin }).origin;

/** Sends under one session do not interleave: a repeat of a message waits for the first and finds it. */
const sending = new Map<string, Promise<unknown>>();
async function inTurn<T>(key: string, step: () => Promise<T>): Promise<T> {
  const run = (sending.get(key) ?? Promise.resolve()).catch(() => undefined).then(step);
  sending.set(key, run);
  try { return await run; } finally { if (sending.get(key) === run) sending.delete(key); }
}

const statusOf = (session: Session | undefined, runId?: string): ConversationStatus =>
  session?.status === "running" ? { state: "running", ...(runId ? { runId } : {}) } : session?.status === "failed" ? { state: "failed", error: failureOf(session) } : { state: "idle" };

/** One worker's session in a Product workspace, as a conversation. The session is created by the first message. */
export class WorkerConversation implements Conversation {
  constructor(private worker: Worker, private workspace: WorkerWorkspace, private registry: WorkerRegistry = WORKERS) {}

  private async session(): Promise<Session | undefined> { return (await this.workspace.store.list()).find(session => session.role === this.worker.role); }

  async status(): Promise<ConversationStatus> { return this.statusOf(await this.session()); }

  private statusOf(session?: Session): ConversationStatus { return statusOf(session, session && this.workspace.runtime.runId(session.id)); }

  async messages(after?: string, limit?: number) {
    const session = await this.session();
    const status = this.statusOf(session);
    return { status, messages: session ? page(projectMessages(session.messages), after, limit) : [] };
  }

  /** The message the session already holds under this id, as it was sent. Its own record is the only one: there is no ledger beside it. */
  async replay(input: SendInput): Promise<Sent | undefined> {
    const session = await this.session();
    const earlier = session && (session.messages.find(message => originOf(message)?.itemId === input.id) ?? this.workspace.runtime.queued(session.id, input.id));
    if (!session || !earlier) return undefined;
    const origin = originOf(earlier);
    const assets = (origin?.attachments ?? []).map(asset => asset.assetId);
    if (origin?.text !== input.text || assets.join() !== input.attachments.map(asset => asset.id).join()) {
      throw new ConversationError(409, "idempotency_conflict", "This idempotency key was used for a different message.");
    }
    const attachments = (origin?.attachments ?? []).map(({ type, name, assetId }) => ({ type, name, asset_id: assetId }));
    return {
      conversationId: session.id, queued: false, runId: this.workspace.runtime.runId(session.id),
      message: { id: input.id, role: "user", text: input.text, created_at: new Date(earlier.timestamp ?? 0).toISOString(), ...(attachments.length ? { attachments } : {}) }
    };
  }

  /** The runtime decides atomically whether this steers the running turn or starts one; a message already accepted under this id is returned as it was. */
  async send(input: SendInput): Promise<Sent> {
    await this.assertAvailable();
    const session = await this.session() ?? await this.workspace.store.create(this.worker.role);
    return inTurn(session.id, async () => (await this.replay(input)) ?? this.deliver(session, input));
  }

  private async deliver(session: Session, input: SendInput): Promise<Sent> {
    const images = input.attachments.filter(asset => asset.kind === "image").map(asset => asset.path);
    const lines = attachmentLines(input.attachments);
    const attachments = input.attachments.map(({ kind, name, id }) => ({ type: kind, name, assetId: id }));
    const message = userMessage([input.text, ...lines].filter(Boolean).join("\n"), images, { kind: "expert", itemId: input.id, text: input.text, attachments });
    const { queued, runId } = await this.workspace.runtime.send(session.id, message, input.client);
    return {
      conversationId: session.id, queued, runId,
      message: { id: input.id, role: "user", text: input.text, created_at: new Date().toISOString(), ...(attachments.length ? { attachments: attachments.map(({ type, name, assetId }) => ({ type, name, asset_id: assetId })) } : {}) },
    };
  }

  async feedKey(): Promise<string | undefined> { return (await this.session())?.id; }

  async stop(): Promise<void> { const session = await this.session(); if (session) this.workspace.runtime.stop(session.id); }

  private async assertAvailable(): Promise<void> {
    try { await this.workspace.assertRoleAvailable(this.worker.role); } catch (error) {
      if (!(error instanceof BuildNotReadyError)) throw error;
      const reason = { needs_one_of: ["uploads", "interview"] };
      throw new ConversationError(409, "worker_unavailable", blockedMessage(this.worker.id), { worker: this.worker.id, ...reason });
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
      const reason = entry && blockedBy(entry);
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
