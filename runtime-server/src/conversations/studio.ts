import { AssistantConversation, type AssistantHost } from "./assistantConversation.js";
import type { AssetDesk, AssetShelf } from "./assets.js";
import { AttachedConversation } from "./attachedConversation.js";
import { ConversationError, type Conversation } from "./conversation.js";
import type { EventLog } from "./eventLog.js";
import { IdempotentConversation, type MessageLedger } from "./ledger.js";
import { record } from "./recorder.js";
import { WorkerDirectory, type WorkerWorkspace } from "./workerConversation.js";

export type StudioDeps = {
  /** The Product when this account owns it. */
  product(accountId: string, productId: string): Promise<{ brief_spec?: unknown } | undefined>;
  workspace(scope: { creatorId: string; productId: string; briefSpec?: unknown }, token: string): Promise<WorkerWorkspace>;
  assistant(): AssistantHost | undefined;
  eventLog: EventLog;
  ledger: MessageLedger;
  /** Attachments for a Product's workers, over the files its workspace shares. Without it, workers take none. */
  assets?: (files: WorkerWorkspace["store"]["backend"]) => AssetDesk;
};

/** What a client asks to talk to. */
export type TargetSpec = { kind: "worker"; productId: string; workerId: string } | { kind: "assistant" };

export type Target = { conversation: Conversation; maxContent: number; accountId: string; assets?: AssetShelf };

const NOT_FOUND = (code: string, message: string) => new ConversationError(404, code, message);

/**
 * Finds the conversation a client addressed, for every transport. Each conversation comes back idempotent.
 * Recording is not done here: a Product's runtime journals every Run from its start, and the Assistant is recorded once it exists.
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
    if (spec.kind === "assistant") return { conversation: this.assistant(accountId), maxContent: 20_000, accountId };
    const workspace = await this.workspace(accountId, token, spec.productId);
    const worker = new WorkerDirectory(workspace).conversation(spec.workerId);
    if (!worker) throw NOT_FOUND("worker_not_found", `No worker named ${spec.workerId}.`);
    const conversationId = `worker:${spec.productId}:${spec.workerId}`;
    const desk = this.deps.assets?.(workspace.store.backend);
    const assets = desk && { desk, scope: { kind: "account" as const, accountId, conversationId } };
    return { conversation: new IdempotentConversation(assets ? new AttachedConversation(worker, assets) : worker, this.deps.ledger, conversationId), maxContent: 100_000, accountId, ...(assets ? { assets } : {}) };
  }

  /** Starts recording the Assistant's events; call it once the Assistant exists so nothing before the first client is missed. */
  recordAssistant(): void {
    const host = this.deps.assistant();
    if (host) record(this.deps.eventLog, host.events, event => event.accountId && `assistant:${event.accountId}`);
  }

  private assistant(accountId: string): Conversation {
    const host = this.deps.assistant();
    if (!host) throw new ConversationError(503, "assistant_unavailable", "The Assistant requires the Registry database.");
    this.recordAssistant();
    return new IdempotentConversation(new AssistantConversation(accountId, host), this.deps.ledger, `assistant:${accountId}`);
  }
}
