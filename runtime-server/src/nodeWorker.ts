import { getFactoryNode } from "./creatorLearning/nodeRegistry.js";
import type { NodeExecutionStateStore } from "./nodeExecution.js";
import type { NodeScope } from "./node.js";
import { NodeRuntime } from "./nodeRuntime.js";

/**
 * One process-level executor for all Factory Nodes.
 *
 * HTTP only enqueues an execution. This worker claims rows through Postgres,
 * so a process restart can recover an expired loading/actor/critic lease and
 * two entry points cannot execute the same row at the same time.
 */
export class NodeExecutionWorker {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly abortController = new AbortController();
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly executions: NodeExecutionStateStore,
    private readonly runtime: NodeRuntime,
    private readonly pollMs = 1_000
  ) {
    if (!Number.isInteger(pollMs) || pollMs < 100) throw new TypeError("Node worker pollMs must be at least 100ms");
  }

  start(): void {
    if (this.pollTimer) return;
    this.stopped = false;
    this.pollTimer = setInterval(() => {
      void this.recover();
    }, this.pollMs);
    void this.recover();
  }

  enqueue(scope: NodeScope): void {
    if (this.stopped) return;
    void this.execute(scope);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.abortController.abort();
    await Promise.all(this.inFlight.values());
  }

  private async recover(): Promise<void> {
    if (this.stopped) return;
    try {
      const rows = await this.executions.listRunnable();
      for (const row of rows) {
        this.enqueue({
          productId: row.productId,
          nodeName: row.nodeName,
          executionId: row.executionId
        });
      }
    } catch (error) {
      console.error("Factory Node worker poll failed", error);
    }
  }

  private async execute(scope: NodeScope): Promise<void> {
    const key = `${scope.productId}/${scope.nodeName}/${scope.executionId}`;
    if (this.inFlight.has(key)) return;
    const task = this.run(scope);
    this.inFlight.set(key, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async run(scope: NodeScope): Promise<void> {
    try {
      const node = getFactoryNode(scope.nodeName);
      await this.runtime.run(node as never, scope, undefined, this.abortController.signal);
    } catch (error) {
      // NodeRuntime has already checkpointed failed state. Keep the worker
      // alive so another execution can proceed.
      console.error(`Factory Node ${scope.nodeName}/${scope.executionId} failed`, error);
    }
  }
}
