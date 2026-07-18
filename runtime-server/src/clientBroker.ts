import { MAX_TOOL_RESULT_BYTES, type OutboundMessage, type ToolRequest, type ToolResult } from "./protocol.js";
import type { RunStateMachine } from "./runState.js";
import type { RuntimeStore } from "./store.js";
import { requireTool } from "./tools.js";

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

  async execute(
    runId: string,
    name: string,
    args: Record<string, unknown>,
    state?: RunStateMachine,
    toolCallId = `tool_${this.nextId++}`,
    options: ClientToolBrokerExecuteOptions = {}
  ): Promise<Record<string, unknown>> {
    const tool = requireTool(name);
    if (tool.locality !== "client") {
      throw new Error(`Tool is not client-local: ${name}`);
    }

    const parsedArgs = tool.schema.parse(args) as Record<string, unknown>;
    const approval = options.approvalOverride ?? tool.approval;
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

    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(pendingKey(runId, toolCallId));
        void this.store.append({
          type: "tool.call",
          conversation_id: state?.conversationId,
          run_id: runId,
          tool_call_id: toolCallId,
          name,
          arguments: parsedArgs,
          status: "failed",
          locality: "client",
          approval,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(options.skillRunId ? { skill_run_id: options.skillRunId } : {}),
          error: { message: `Timed out waiting for client tool result: ${name}` }
        });
        reject(new Error(`Timed out waiting for client tool result: ${name}`));
      }, this.timeoutMs);

      this.pending.set(pendingKey(runId, toolCallId), {
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
      });
    });
    // The caller does not receive `result` until after requested/emit completes.
    // Cancellation can reject it during that window, so attach ownership now
    // without changing the promise returned to the caller below.
    void result.catch(() => undefined);

    await state?.waitForTool();
    await this.store.append({
      type: "tool.call",
      conversation_id: state?.conversationId,
      run_id: runId,
      tool_call_id: toolCallId,
      name,
      arguments: parsedArgs,
      status: "requested",
      locality: "client",
      approval,
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.skillRunId ? { skill_run_id: options.skillRunId } : {})
    });
    if (approval === "ask") {
      await this.emit({
        type: "approval.request",
        run_id: runId,
        tool_call_id: toolCallId,
        name,
        arguments: parsedArgs,
        ...approvalReason(parsedArgs)
      });
    }
    await this.emit(request);
    return result;
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
      await this.emitApprovalDecision(pending, "approved", error.message);
      await this.store.append({
        type: "tool.call",
        conversation_id: pending.conversationId,
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        name: pending.name,
        arguments: pending.arguments,
        status: "failed",
        locality: "client",
        approval: pending.approval,
        ...(pending.scope ? { scope: pending.scope } : {}),
        ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
        error
      });
      await pending.state?.resumeFromTool().catch(() => undefined);
      pending.reject(new Error(error.message));
      return true;
    }

    this.pending.delete(key);
    clearTimeout(pending.timeout);

    if (message.status === "error") {
      await this.emitApprovalDecision(pending, message.error?.code === "approval_denied" ? "denied" : "approved", message.error?.message);
      await this.store.append({
        type: "tool.call",
        conversation_id: pending.conversationId,
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        name: pending.name,
        arguments: pending.arguments,
        status: "failed",
        locality: "client",
        approval: pending.approval,
        ...(pending.scope ? { scope: pending.scope } : {}),
        ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
        error: message.error
      });
      await pending.state?.resumeFromTool().catch(() => undefined);
      pending.reject(new Error(message.error?.message ?? "Client tool failed"));
      return true;
    }

    await this.emitApprovalDecision(pending, "approved");
    await this.store.append({
      type: "tool.call",
      conversation_id: pending.conversationId,
      run_id: message.run_id,
      tool_call_id: message.tool_call_id,
      name: pending.name,
      arguments: pending.arguments,
      status: "completed",
      locality: "client",
      approval: pending.approval,
      ...(pending.scope ? { scope: pending.scope } : {}),
      ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
      result: message.result ?? {}
    });
    await pending.state?.resumeFromTool().catch(() => undefined);
    pending.resolve(message.result ?? {});
    return true;
  }

  async cancelAll(reason = "Client broker canceled"): Promise<void> {
    for (const [key, pending] of this.pending) {
      await this.cancelPendingCall(key, pending, reason);
    }
  }

  async cancelRun(runId: string, reason = "Run canceled"): Promise<number> {
    let cancelled = 0;
    for (const [key, pending] of this.pending) {
      if (pending.runId !== runId) continue;
      await this.cancelPendingCall(key, pending, reason);
      cancelled += 1;
    }
    return cancelled;
  }

  private async cancelPendingCall(key: string, pending: PendingCall, reason: string): Promise<void> {
    if (this.pending.get(key) !== pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(key);
    // Settle the worker-facing promise before any awaited observability fan-out.
    // Protected workers must unwind even when the client event sink is slow.
    pending.reject(new Error(reason));
    await this.store.append({
      type: "tool.call",
      conversation_id: pending.conversationId,
      run_id: pending.runId,
      tool_call_id: pending.toolCallId,
      name: pending.name,
      arguments: pending.arguments,
      status: "cancelled",
      locality: "client",
      approval: pending.approval,
      ...(pending.scope ? { scope: pending.scope } : {}),
      ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {}),
      error: { message: reason }
    });
    await this.emit({
      type: "tool_call.delta",
      run_id: pending.runId,
      tool_call_id: pending.toolCallId,
      name: pending.name,
      locality: "client",
      approval: pending.approval,
      status: "cancelled",
      arguments: pending.arguments,
      error: {
        code: "tool_cancelled",
        message: reason
      },
      ...(pending.scope ? { scope: pending.scope } : {}),
      ...(pending.skillRunId ? { skill_run_id: pending.skillRunId } : {})
    });
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
  return `${runId}:${toolCallId}`;
}

function approvalReason(args: Record<string, unknown>): { reason?: string } {
  const justification = args.justification;
  return typeof justification === "string" && justification.trim()
    ? { reason: justification.trim() }
    : {};
}
