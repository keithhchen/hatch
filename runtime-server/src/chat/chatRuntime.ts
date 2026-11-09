import { randomUUID } from "node:crypto";
import type { CompactionStrategy } from "../compactionStrategy.js";
import { chatCompactionStrategy, type RuntimeCompactionMessage } from "../compaction.js";
import type { ConversationRepository } from "../conversationRepository.js";
import type { ToolRequest } from "../protocol.js";
import { DEFAULT_RUN_LEASE_MS } from "../conversationRepository.js";
import type { RuntimeStore } from "../store.js";
import { ChatCompaction } from "./chatCompaction.js";
import { ChatService, RunRegistry, type PrincipalLimits, type RunAdmission } from "./chatService.js";
import { ConversationFeed } from "./conversationFeed.js";
import type { EventRelay } from "./eventRelay.js";
import { TranscriptResumePolicy } from "./resumePolicy.js";
import { RunEventHub } from "./runEventHub.js";
import { RunSupervisor } from "./runSupervisor.js";
import { ToolRecovery } from "./toolRecovery.js";
import { TurnExecutor, type ScopeResolver, type TurnRunner } from "./turnExecutor.js";

export type ChatRuntimeOptions<Scope> = {
  repository: ConversationRepository;
  store: RuntimeStore;
  runner: TurnRunner<Scope>;
  scopes: ScopeResolver<Scope>;
  admission: RunAdmission;
  limits?: PrincipalLimits;
  toolTimeoutMs: number;
  leaseMs?: number;
  sweepMs?: number;
  feedPollMs?: number;
  toolPollMs?: number;
  /** Carries live events between instances. Without one, observers only see Runs this instance executes. */
  relay?: EventRelay;
  /** The compaction strategy; by default Chat's, built from the model's window on first use. */
  compactionStrategy?: () => CompactionStrategy<RuntimeCompactionMessage>;
};

/**
 * The Chat API's server-owned core, assembled once per process. No part of it
 * knows about a transport: HTTP and WebSocket adapters call into it.
 */
export class ChatRuntime<Scope> {
  readonly hub: RunEventHub;
  readonly registry = new RunRegistry<Scope>();
  readonly feed: ConversationFeed;
  readonly supervisor: RunSupervisor;
  readonly service: ChatService<Scope>;
  readonly compaction: ChatCompaction;
  private stopListening: () => Promise<void> = async () => undefined;

  constructor(private readonly options: ChatRuntimeOptions<Scope>) {
    const { repository, store } = options;
    const executorId = `executor_${randomUUID().replaceAll("-", "")}`;
    this.hub = new RunEventHub(options.relay);
    this.feed = new ConversationFeed(repository, this.hub, options.feedPollMs);
    let strategy: CompactionStrategy<RuntimeCompactionMessage> | undefined;
    this.compaction = new ChatCompaction({
      repository, store, hub: this.hub, executorId,
      strategy: () => strategy ??= (options.compactionStrategy ?? chatCompactionStrategy)()
    });
    const recovery = new ToolRecovery({ repository });
    this.supervisor = new RunSupervisor(
      repository,
      new TurnExecutor({
        repository, store, hub: this.hub, registry: this.registry, scopes: options.scopes, runner: options.runner, recovery,
        compactions: this.compaction, toolTimeoutMs: options.toolTimeoutMs, toolPollMs: options.toolPollMs
      }),
      new TranscriptResumePolicy(store, recovery),
      { executorId, leaseMs: options.leaseMs ?? DEFAULT_RUN_LEASE_MS, sweepMs: options.sweepMs ?? 5_000, toolPollMs: options.toolPollMs, afterReply: (run) => this.compaction.afterReply(run) }
    );
    this.service = new ChatService({ repository, supervisor: this.supervisor, hub: this.hub, admission: options.admission, registry: this.registry, limits: options.limits, compaction: this.compaction });
  }

  /** Takes over Runs a previous instance left behind, then keeps watching for more. */
  async start(): Promise<void> {
    this.stopListening = await this.hub.listen();
    this.supervisor.start();
    await this.supervisor.sweep();
  }

  async stop(): Promise<void> {
    await this.supervisor.stop();
    await this.compaction.drain();
    await this.stopListening();
  }

  /** An explicit stop: the only thing that ends a Run early. */
  async cancel(conversationId: string, runId: string, reason: string): Promise<boolean> {
    const cancelled = await this.supervisor.cancel(conversationId, runId, reason);
    if (cancelled) this.hub.publish(conversationId, { type: "turn.failed", run_id: runId, error: { code: "run_cancelled", message: reason } });
    return cancelled;
  }

  /**
   * Local-tool calls waiting for a client in this conversation, read from the durable record: whichever
   * instance holds the Run, and after a restart, any permitted client can see and answer them.
   */
  async pendingToolRequests(conversationId: string): Promise<ToolRequest[]> {
    const { repository } = this.options;
    const snapshot = await repository.recoverySnapshot(conversationId, []);
    const active = snapshot.runs.filter((run) => ["queued", "running", "waiting_for_tool", "compacting"].includes(run.status));
    const now = Date.now();
    return (await Promise.all(active.map((run) => repository.listToolCalls(run.id)))).flat()
      .filter((call) => !call.outcome && Date.parse(call.expiresAt) > now)
      .map((call): ToolRequest => ({
        type: "tool_call.request", run_id: call.runId, tool_call_id: call.toolCallId, name: call.name,
        arguments: call.arguments, approval: call.approval,
        ...(call.scope ? { scope: call.scope } : {}), ...(call.skillRunId ? { skill_run_id: call.skillRunId } : {})
      }));
  }
}
