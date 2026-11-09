import { AssistantConversation, type AssistantHost } from "./assistantConversation.js";
import type { AssetResolver } from "./assets.js";
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
  assets?: AssetResolver;
};

/** What a client asks to talk to. */
export type TargetSpec = { kind: "worker"; productId: string; workerId: string } | { kind: "assistant" };

export type Target = { conversation: Conversation; maxContent: number; accountId: string };

const NOT_FOUND = (code: string, message: string) => new ConversationError(404, code, message);

/**
 * Finds the conversation a client addressed, for every transport. Each conversation comes back
 * idempotent and recorded: what it does reaches the event log whether or not anyone is watching.
 */
export class Studio {
  constructor(private deps: StudioDeps) {}

  get eventLog(): EventLog { return this.deps.eventLog; }

  async directory(accountId: string, token: string, productId: string): Promise<WorkerDirectory> {
    const product = await this.deps.product(accountId, productId);
    if (!product) throw NOT_FOUND("product_not_found", "Product was not found.");
    const workspace = await this.deps.workspace({ creatorId: accountId, productId, briefSpec: product.brief_spec }, token);
    record(this.deps.eventLog, workspace.runtime.events, event => event.sessionId);
    return new WorkerDirectory(workspace);
  }

  async target(accountId: string, token: string, spec: TargetSpec): Promise<Target> {
    if (spec.kind === "assistant") return { conversation: this.assistant(accountId), maxContent: 20_000, accountId };
    const worker = (await this.directory(accountId, token, spec.productId)).conversation(spec.workerId);
    if (!worker) throw NOT_FOUND("worker_not_found", `No worker named ${spec.workerId}.`);
    return { conversation: new IdempotentConversation(worker, this.deps.ledger, `worker:${spec.productId}:${spec.workerId}`), maxContent: 100_000, accountId };
  }

  private assistant(accountId: string): Conversation {
    const host = this.deps.assistant();
    if (!host) throw new ConversationError(503, "assistant_unavailable", "The Assistant requires the Registry database.");
    record(this.deps.eventLog, host.events, event => event.accountId && `assistant:${event.accountId}`);
    return new IdempotentConversation(new AssistantConversation(accountId, host), this.deps.ledger, `assistant:${accountId}`);
  }
}
