import { ToolExecutor } from "@hatch/chat";
import { LOCAL_TOOLS } from "./local-tools.js";

const GRACE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

/** Native shell timeout (bounded) or the default, plus transport grace. */
export function localToolDeadlineMs(request) {
  const requested = Number(request?.arguments?.timeout_ms);
  const native = request?.name === "shell_exec" && Number.isFinite(requested) && requested >= 100 && requested <= 120_000 ? requested : DEFAULT_TIMEOUT_MS;
  return native + GRACE_MS;
}

const toolError = (code, message) => ({ status: "error", error: { code, message } });
const protocolResult = result => result.status === "error"
  ? { status: "error", error: { code: String(result.error?.code ?? "local_runner_error"), message: String(result.error?.message ?? "") } }
  : { status: "ok", result: result.result };

/**
 * Desktop ToolExecutor: local tools run in the native layer, inside the
 * conversation's workspace grant, under a per-run tool context registered
 * before the message is sent. The native gate decides whether a call needs
 * the user's approval (permission policy); the renderer only relays the
 * user's answer for a call native has already recorded.
 */
export class NativeToolExecutor extends ToolExecutor {
  constructor({ invoke, conversationId, workspace, approvals, agentKey }) {
    super();
    Object.assign(this, { invoke, conversationId, workspace, approvals, agentKey });
    this.contexts = new Map();
    this.running = new Map();
  }

  /** Without a folder grant the conversation offers no local tools. */
  get localTools() {
    return this.workspace.grant ? [...LOCAL_TOOLS] : [];
  }

  async prepareRun({ conversationId, runId }) {
    await this.clearContexts();
    const grant = this.workspace.grant;
    if (!grant || conversationId !== this.conversationId) return;
    const result = await this.invoke("set_window_tool_context", {
      conversationId, runId, workspaceGrantId: grant.grant_id, permissionPolicy: this.workspace.permission
    });
    if (typeof result?.context_id !== "string" || !result.context_id) throw new Error("Native tool context registration returned no context_id");
    this.contexts.set(runId, { contextId: result.context_id, runId });
  }

  /** Native enforces the gate inside `execute`; the approval.request itself is not a decision. */
  requestApproval() {
    return Promise.resolve({ approved: true });
  }

  execute(request) {
    const context = this.contexts.get(request.run_id);
    if (!context) return Promise.resolve(toolError("local_tool_unavailable", "Choose a folder to let this Agent use local tools."));
    return new Promise(resolve => {
      let settled = false;
      let pollTimer;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(pollTimer);
        clearTimeout(deadline);
        this.running.delete(request.tool_call_id);
        resolve(result);
      };
      const call = (command, extra = {}) => this.invoke(command, { ...context, toolCallId: request.tool_call_id, ...extra });
      const poll = async () => {
        if (settled) return;
        try {
          const result = await call("poll_tool_call");
          if (result) return finish(protocolResult(result));
        } catch (error) {
          return finish(toolError("local_runner_error", String(error?.message ?? error)));
        }
        pollTimer = setTimeout(poll, POLL_MS);
      };
      const cancel = async reason => {
        if (settled) return;
        try {
          await call("cancel_tool_call");
          const result = await call("poll_tool_call");
          // A file operation may commit between the cancel signal and its next
          // safe point; report that honest result instead of "cancelled".
          if (result && result.error?.code !== "cancelled") return finish(protocolResult(result));
          finish(toolError(reason === "timeout" ? "local_tool_timeout" : "local_tool_cancelled", `${request.name} was stopped`));
        } catch (error) {
          finish(toolError("local_tool_cancel_failed", String(error?.message ?? error)));
        }
      };
      const deadline = setTimeout(() => void cancel("timeout"), localToolDeadlineMs(request));
      this.running.set(request.tool_call_id, { runId: request.run_id, cancel });
      this.invoke("execute_tool_call", { ...context, request }).then(async submission => {
        if (submission?.status === "approval_required") {
          const approved = await this.approvals.ask({ conversationId: this.conversationId, agentKey: this.agentKey, request });
          if (settled) return;
          await call(approved ? "approve_pending_tool_call" : "deny_pending_tool_call");
        }
        void poll();
      }).catch(error => finish(toolError("local_runner_error", String(error?.message ?? error))));
    });
  }

  cancel(runId) {
    for (const entry of [...this.running.values()]) if (!runId || entry.runId === runId) void entry.cancel("user_requested");
    this.approvals.denyAll(this.conversationId);
  }

  async clearContexts() {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    await Promise.allSettled(contexts.map(context => this.invoke("clear_window_tool_context", context)));
  }

  /** Stop local work and revoke native contexts (conversation closing). */
  async dispose() {
    this.cancel();
    await Promise.allSettled([...this.running.values()].map(entry => entry.cancel("window_closed")));
    await this.clearContexts();
  }
}
