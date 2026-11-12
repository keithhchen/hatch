import { AssistantConversation, type AssistantHost } from "./assistantConversation.js";
import type { AssetDesk, AssetShelf, Workshop } from "./assets.js";
import { AttachedConversation } from "./attachedConversation.js";
import { ConversationError, type Conversation } from "./conversation.js";
import type { EventLog } from "./eventLog.js";
import type { AssistantPanel } from "./panel.js";
import { productPlacement } from "./pipelineAssets.js";
import { WorkerDirectory, type WorkerWorkspace } from "./workerConversation.js";

export type StudioDeps = {
  /** The Product when this account owns it. */
  product(accountId: string, productId: string): Promise<{ brief_spec?: unknown } | undefined>;
  workspace(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string): Promise<WorkerWorkspace>;
  assistant(): AssistantHost | undefined;
  eventLog: EventLog;
  /** What Studio's Assistant page shows beside the conversation. */
  panel?: () => AssistantPanel | undefined;
  /** Attachments for a conversation, over the files its workspace keeps. Without it, conversations take none. */
  assets?: (workshop: Workshop) => AssetDesk;
};

/** What a client asks to talk to. */
export type TargetSpec = { kind: "worker"; productId: string; workerId: string } | { kind: "assistant" };

export type Target = { conversation: Conversation; maxContent: number; accountId: string; assets?: AssetShelf };

const NOT_FOUND = (code: string, message: string) => new ConversationError(404, code, message);

/**
 * Finds the conversation a client addressed, for every transport. A client's key is the message's id, and the conversation
 * itself knows whether it already accepted it: the Assistant on Chat's acceptance, a worker from its own session.
 * Recording is not done here: every runtime, a Product's or the Assistant's, journals its Runs from the start.
 */
export class Studio {
  constructor(private deps: StudioDeps) {}

  get eventLog(): EventLog { return this.deps.eventLog; }

  private async workspace(accountId: string, token: string, productId: string): Promise<WorkerWorkspace> {
    const product = await this.deps.product(accountId, productId);
    if (!product) throw NOT_FOUND("product_not_found", "Product was not found.");
    return this.deps.workspace({ creatorId: accountId, productId, briefSpec: product.brief_spec }, token);
  }

  async directory(accountId: string, token: string, productId: string): Promise<WorkerDirectory> {
    return new WorkerDirectory(await this.workspace(accountId, token, productId));
  }

  async target(accountId: string, token: string, spec: TargetSpec): Promise<Target> {
    if (spec.kind === "assistant") {
      const host = this.assistantHost();
      return this.shelved(new AssistantConversation(accountId, host), 20_000, accountId, host.conversationId(accountId), this.deps.assets && host.assets());
    }
    const workspace = await this.workspace(accountId, token, spec.productId);
    const worker = new WorkerDirectory(workspace).conversation(spec.workerId);
    if (!worker) throw NOT_FOUND("worker_not_found", `No worker named ${spec.workerId}.`);
    const conversationId = `worker:${spec.productId}:${spec.workerId}`;
    return this.shelved(worker, 100_000, accountId, conversationId, this.deps.assets?.({ files: workspace.store.backend, place: productPlacement }));
  }

  /** A conversation that takes attachments when it has a desk. */
  private shelved(conversation: Conversation, maxContent: number, accountId: string, conversationId: string, desk?: AssetDesk): Target {
    const assets = desk && { desk, scope: { kind: "account" as const, accountId, conversationId } };
    return { conversation: assets ? new AttachedConversation(conversation, assets) : conversation, maxContent, accountId, ...(assets ? { assets } : {}) };
  }

  get panel(): AssistantPanel {
    const panel = this.deps.panel?.();
    if (!panel) throw new ConversationError(503, "assistant_unavailable", "The Assistant requires the Registry database.");
    return panel;
  }

  private assistantHost(): AssistantHost {
    const host = this.deps.assistant();
    if (!host) throw new ConversationError(503, "assistant_unavailable", "The Assistant requires the Registry database.");
    return host;
  }
}
