import { randomUUID } from "node:crypto";
import type { ConversationRepository } from "../conversationRepository.js";
import type { ToolRequest } from "../protocol.js";
import { DEFAULT_RUN_LEASE_MS } from "../conversationRepository.js";
import type { RuntimeStore } from "../store.js";
import { ChatService, RunRegistry, type PrincipalLimits, type RunAdmission } from "./chatService.js";
import { ConversationFeed } from "./conversationFeed.js";
import { HistoryToolLog, ReadOnlyRestartPolicy } from "./resumePolicy.js";
import { RunEventHub } from "./runEventHub.js";
import { RunSupervisor } from "./runSupervisor.js";
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
};

/**
 * The Chat API's server-owned core, assembled once per process. No part of it
 * knows about a transport: HTTP and WebSocket adapters call into it.
 */
export class ChatRuntime<Scope> {
  readonly hub = new RunEventHub();
  readonly registry = new RunRegistry<Scope>();
  readonly feed: ConversationFeed;
  readonly supervisor: RunSupervisor;
  readonly service: ChatService<Scope>;

  constructor(private readonly options: ChatRuntimeOptions<Scope>) {
    const { repository, store } = options;
    this.feed = new ConversationFeed(repository, this.hub, options.feedPollMs);
    this.supervisor = new RunSupervisor(
      repository,
      new TurnExecutor({ repository, store, hub: this.hub, registry: this.registry, scopes: options.scopes, runner: options.runner, toolTimeoutMs: options.toolTimeoutMs }),
      new ReadOnlyRestartPolicy(new HistoryToolLog(store)),
      { executorId: `executor_${randomUUID().replaceAll("-", "")}`, leaseMs: options.leaseMs ?? DEFAULT_RUN_LEASE_MS, sweepMs: options.sweepMs ?? 5_000 }
    );
    this.service = new ChatService({ repository, supervisor: this.supervisor, hub: this.hub, admission: options.admission, registry: this.registry, limits: options.limits });
  }

  /** Takes over Runs a previous instance left behind, then keeps watching for more. */
  async start(): Promise<void> {
    this.supervisor.start();
    await this.supervisor.sweep();
  }

  stop(): Promise<void> { return this.supervisor.stop(); }

  /** An explicit stop: the only thing that ends a Run early. */
  async cancel(conversationId: string, runId: string, reason: string): Promise<boolean> {
    const cancelled = await this.supervisor.cancel(conversationId, runId, reason);
    if (cancelled) this.hub.publish(conversationId, { type: "turn.failed", run_id: runId, error: { code: "run_cancelled", message: reason } });
    return cancelled;
  }

  /** Local-tool calls waiting for a client in this conversation. */
  async pendingToolRequests(conversationId: string): Promise<ToolRequest[]> {
    const snapshot = await this.options.repository.recoverySnapshot(conversationId, []);
    return snapshot.runs.flatMap((run) => this.supervisor.pendingToolRequests(run.id));
  }
}
