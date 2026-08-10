import { MAX_TOOL_RESULT_BYTES, type OutboundMessage, type ToolRequest, type ToolResult } from "./protocol.js";
import type { RunStateMachine } from "./runState.js";
import type { RuntimeStore } from "./store.js";
import { requireTool } from "./tools.js";
import { projectToolArgumentsForVisibility, projectToolResultForVisibility } from "./toolVisibility.js";

type ClientToolBrokerExecuteOptions = {
  approvalOverride?: ToolRequest["approval"];
  scope?: ToolRequest["scope"];
  skillRunId?: string;
};

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  runId: string;
  conversationId?: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  approval: "none" | "auto" | "ask";
  scope?: ToolRequest["scope"];
  skillRunId?: string;
  state?: RunStateMachine;
};

export class ClientToolBroker {
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly emit: (message: OutboundMessage) => Promise<void>,
    private readonly store: RuntimeStore,
    private readonly timeoutMs = 120000
  ) {}

  execute(
    runId: string,
    name: string,
    args: Record<string, unknown>,
    state?: RunStateMachine,
    toolCallId = `tool_${this.nextId++}`,
    options: ClientToolBrokerExecuteOptions = {}
  ): Promise<Record<string, unknown>> {
    let tool: ReturnType<typeof requireTool>;
    let parsedArgs: Record<string, unknown>;
    try {
      tool = requireTool(name);
      if (tool.locality !== "client") {
        throw new Error(`Tool is not client-local: ${name}`);
      }
      parsedArgs = tool.schema.parse(args) as Record<string, unknown>;
    } catch (error) {
      return Promise.reject(error);
    }
    const approval = options.approvalOverride ?? tool.approval;
    const key = pendingKey(runId, toolCallId);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`Duplicate client tool call ID for run ${runId}: ${toolCallId}`));
    }
    const request: ToolRequest = {
      type: "tool_call.request",
      run_id: runId,
      tool_call_id: toolCallId,
      name,
      arguments: parsedArgs,
      approval,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.skillRunId ? { skill_run_id: options.skillRunId } : {})
    };

    let createdPending!: PendingCall;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // A due timer can already be queued when its old call settles and the
        // same IDs are reused. Only that exact PendingCall may claim the key.
        if (!this.isPending(key, createdPending)) return;
        this.pending.delete(key);
        void observe(() => this.store.append({
          type: "tool.call",
          conversation_id: state?.conversationId,
          run_id: runId,
          tool_call_id: toolCallId,
          name,
          arguments: projectToolArgumentsForVisibility(options.scope, name, parsedArgs),
          status: "failed",
          locality: "client",
          approval,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.skillRunId ? { skill_run_id: options.skillRunId } : {}),
          error: { message: `Timed out waiting for client tool result: ${name}` }
        })).catch(() => undefined);
        reject(new Error(`Timed out waiting for client tool result: ${name}`));
      }, this.timeoutMs);

      createdPending = {
        resolve,
        reject,
        timeout,
        runId,
        conversationId: state?.conversationId,
        toolCallId,
        name,
        arguments: parsedArgs,
        approval,
        scope: options.scope,
        skillRunId: options.skillRunId,
        state
      };
      this.pending.set(key, createdPending);
    });
    // The caller does not receive `result` until after requested/emit completes.
    // Cancellation can reject it during that window, so attach ownership now
    // without changing the promise returned to the caller below.
    void result.catch(() => undefined);

    const pending = this.pending.get(key);
    if (!pending) {
      return Promise.reject(new Error(`Client tool pending state was not created: ${toolCallId}`));
    }
    void this.dispatch(request, pending, state, parsedArgs, approval, options).catch((error) => {
      this.failPending(key, pending, error);
    });
    return result;
  }

  private async dispatch(
    request: ToolRequest,
    pending: PendingCall,
    state: RunStateMachine | undefined,
    parsedArgs: Record<string, unknown>,
    approval: PendingCall["approval"],
    options: ClientToolBrokerExecuteOptions
  ): Promise<void> {
    const key = pendingKey(pending.runId, pending.toolCallId);
    await state?.waitForTool();
    if (!this.isPending(key, pending)) return;
    await this.store.append({
      type: "tool.call",
      conversation_id: state?.conversationId,
      run_id: pending.runId,
      tool_call_id: pending.toolCallId,
      name: pending.name,
      arguments: projectToolArgumentsForVisibility(options.scope, pending.name, parsedArgs),
      status: "requested",
      locality: "client",
      approval,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.skillRunId ? { skill_run_id: options.skillRunId } : {})
    });
    if (!this.isPending(key, pending)) return;
    if (approval === "ask") {
      await this.emit({
        type: "approval.request",
        run_id: pending.runId,
        tool_call_id: pending.toolCallId,
        name: pending.name,
        arguments: parsedArgs,
        ...approvalReason(parsedArgs)
      });
      if (!this.isPending(key, pending)) return;
    }
    await this.emit(request);
  }

  private isPending(key: string, pending: PendingCall): boolean {
    return this.pending.get(key) === pending;
  }

  private failPending(key: string, pending: PendingCall, error: unknown): void {
    if (!this.isPending(key, pending)) return;
    this.pending.delete(key);
    clearTimeout(pending.timeout);
    pending.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async handleResult(message: ToolResult): Promise<boolean> {
    const key = pendingKey(message.run_id, message.tool_call_id);
    const pending = this.pending.get(key);
    if (!pending) {
      return false;
    }

    const serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (serializedBytes > MAX_TOOL_RESULT_BYTES) {
      this.pending.delete(key);
      clearTimeout(pending.timeout);
      const error = {
        code: "tool_result_too_large",
        message: `Tool result exceeds the ${MAX_TOOL_RESULT_BYTES}-byte transport envelope; narrow the request.`
      };
      // The worker-facing promise is the lifecycle authority. Settle it before
      // fallible audit/event fan-out so a store outage cannot orphan the run.
      const resume = observe(() => pending.state?.resumeFromTool());
      pending.reject(new Error(error.message));
      await Promise.allSettled([
        observe(() => this.emitApprovalDecision(pending, "approved", error.message)),
        observe(() => this.store.append({
          type: "tool.call",
          conversation_id: pending.conversationId,
          run_id: message.run_id,
          tool_call_id: message.tool_call_id,
          name: pending.name,
          arguments: projectToolArgumentsForVisibility(pending.scope, pending.name, pending.arguments),
          status: "failed",
          locality: "client",
          approval: pending.approval,
          ...(pending.scope ? { scope: pending.scope } : {}),
          ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
          error
        })),
        resume
      ]);
      return true;
    }

    this.pending.delete(key);
    clearTimeout(pending.timeout);

    if (message.status === "error") {
      const resume = observe(() => pending.state?.resumeFromTool());
      pending.reject(new Error(message.error?.message ?? "Client tool failed"));
      await Promise.allSettled([
        observe(() => this.emitApprovalDecision(pending, message.error?.code === "approval_denied" ? "denied" : "approved", message.error?.message)),
        observe(() => this.store.append({
          type: "tool.call",
          conversation_id: pending.conversationId,
          run_id: message.run_id,
          tool_call_id: message.tool_call_id,
          name: pending.name,
          arguments: projectToolArgumentsForVisibility(pending.scope, pending.name, pending.arguments),
          status: "failed",
          locality: "client",
          approval: pending.approval,
          ...(pending.scope ? { scope: pending.scope } : {}),
          ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
          error: message.error
        })),
        resume
      ]);
      return true;
    }

    const result = message.result ?? {};
    const resume = observe(() => pending.state?.resumeFromTool());
    pending.resolve(result);
    await Promise.allSettled([
      observe(() => this.emitApprovalDecision(pending, "approved")),
      observe(() => this.store.append({
        type: "tool.call",
        conversation_id: pending.conversationId,
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        name: pending.name,
        arguments: projectToolArgumentsForVisibility(pending.scope, pending.name, pending.arguments),
        status: "completed",
        locality: "client",
        approval: pending.approval,
        ...(pending.scope ? { scope: pending.scope } : {}),
        ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
        result: projectToolResultForVisibility(pending.scope, pending.name, result)
      })),
      resume
    ]);
    return true;
  }

  async cancelAll(reason = "Client broker canceled"): Promise<void> {
    const claimed = this.claimPendingCalls(() => true, reason);
    await Promise.allSettled(claimed.map((pending) => this.observeCancellation(pending, reason)));
  }

  async cancelRun(runId: string, reason = "Run canceled"): Promise<number> {
    const claimed = this.claimPendingCalls((pending) => pending.runId === runId, reason);
    await Promise.allSettled(claimed.map((pending) => this.observeCancellation(pending, reason)));
    return claimed.length;
  }

  private claimPendingCalls(predicate: (pending: PendingCall) => boolean, reason: string): PendingCall[] {
    const claimed: PendingCall[] = [];
    for (const [key, pending] of this.pending) {
      if (!predicate(pending) || this.pending.get(key) !== pending) continue;
      this.pending.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
      claimed.push(pending);
    }
    return claimed;
  }

  private async observeCancellation(pending: PendingCall, reason: string): Promise<void> {
    // Audit persistence and client observability are deliberately independent:
    // either one may fail during disconnect without blocking the other or the
    // already-settled protected worker.
    await Promise.allSettled([
      observe(() => this.store.append({
        type: "tool.call",
        conversation_id: pending.conversationId,
        run_id: pending.runId,
        tool_call_id: pending.toolCallId,
        name: pending.name,
        arguments: projectToolArgumentsForVisibility(pending.scope, pending.name, pending.arguments),
        status: "cancelled",
        locality: "client",
        approval: pending.approval,
        ...(pending.scope ? { scope: pending.scope } : {}),
        ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
        error: { message: reason }
      })),
      observe(() => this.emit({
        type: "tool_call.delta",
        run_id: pending.runId,
        tool_call_id: pending.toolCallId,
        name: pending.name,
        locality: "client",
        approval: pending.approval,
        status: "cancelled",
        arguments: projectToolArgumentsForVisibility(pending.scope, pending.name, pending.arguments),
        error: {
          code: "tool_cancelled",
          message: reason
        },
        ...(pending.scope ? { scope: pending.scope } : {}),
        ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {})
      }))
    ]);
  }

  private emitApprovalDecision(
    pending: PendingCall,
    status: "approved" | "denied",
    reason?: string
  ): Promise<void> {
    if (pending.approval !== "ask") return Promise.resolve();
    return this.emit({
      type: "approval.result",
      run_id: pending.runId,
      tool_call_id: pending.toolCallId,
      name: pending.name,
      status,
      ...(reason ? { reason } : {})
    });
  }
}

function pendingKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

function observe<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

function approvalReason(args: Record<string, unknown>): { reason?: string } {
  const justification = args.justification;
  return typeof justification === "string" && justification.trim()
    ? { reason: justification.trim() }
    : {};
}
