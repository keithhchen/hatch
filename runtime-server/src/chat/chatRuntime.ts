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
import { fenced } from "./runFence.js";
import type { StopRelay } from "./stopRelay.js";
import { TranscriptResumePolicy } from "./resumePolicy.js";
import { RunEventHub } from "./runEventHub.js";
import { RunSupervisor } from "./runSupervisor.js";
import { runTerminators } from "./runTerminator.js";
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
  /** Tells the instance that executes a Run it was stopped. Without one, a stop reaches another instance at its next lease renewal. */
  stops?: StopRelay;
  /** The hub the Runs publish to, when a host also wants to hear every event; by default one over `relay`. */
  hub?: RunEventHub;
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
    this.hub = options.hub ?? new RunEventHub(options.relay);
    this.feed = new ConversationFeed(repository, this.hub, options.feedPollMs);
    let strategy: CompactionStrategy<RuntimeCompactionMessage> | undefined;
    this.compaction = new ChatCompaction({
      repository, store, hub: this.hub, executorId,
      strategy: () => strategy ??= (options.compactionStrategy ?? chatCompactionStrategy)()
    });
    const recovery = new ToolRecovery({ repository });
    const terminators = runTerminators(repository, this.hub, executorId);
    this.supervisor = new RunSupervisor(
      repository,
      new TurnExecutor({
        // The executor writes through the fence: once its Run is stopped or taken over it can write nothing more.
        // The index is where each write takes its hold, which the write itself checks.
        repository: fenced(repository, executorId, { transitionRun: 3, savePartialOutput: 2, claimSteeredMessages: 1, requestToolCall: 1 }),
        store: fenced(store, executorId, { append: 1 }),
        terminator: terminators.executing,
        hub: this.hub, registry: this.registry, scopes: options.scopes, runner: options.runner, recovery,
        compactions: this.compaction, toolTimeoutMs: options.toolTimeoutMs, toolPollMs: options.toolPollMs
      }),
      new TranscriptResumePolicy(store, recovery),
      { executorId, leaseMs: options.leaseMs ?? DEFAULT_RUN_LEASE_MS, sweepMs: options.sweepMs ?? 5_000, toolPollMs: options.toolPollMs, afterReply: (run) => this.compaction.afterReply(run), stops: options.stops },
      terminators
    );
    this.service = new ChatService({ repository, terminator: terminators.external, supervisor: this.supervisor, hub: this.hub, admission: options.admission, registry: this.registry, limits: options.limits, compaction: this.compaction });
  }

  /** Takes over Runs a previous instance left behind, then keeps watching for more. */
  async start(): Promise<void> {
    this.stopListening = await this.hub.listen();
    await this.supervisor.start();
    await this.supervisor.sweep();
  }

  /** Waits for the Runs this instance holds; see RunSupervisor.drain. */
  drain(): Promise<void> { return this.supervisor.drain(); }

  async stop(): Promise<void> {
    await this.supervisor.stop();
    await this.compaction.drain();
    await this.stopListening();
  }

  /** An explicit stop: the only thing that ends a Run early. */
  async cancel(conversationId: string, runId: string, reason: string): Promise<boolean> {
    return this.supervisor.cancel(conversationId, runId, reason);
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
