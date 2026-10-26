import { describe, expect, it, vi } from "vitest";
import { ApprovalCenter } from "./approvals.js";
import { NativeToolExecutor, localToolDeadlineMs } from "./native-tools.js";
import { WorkspaceAccess } from "./workspace.js";

const grant = { grant_id: "grant_1", display_path: "/Users/ada/project" };

/** Native tool-authority double for this unit test only. */
function nativeTools({ approval = false, result = { status: "ok", result: { text: "done" } } } = {}) {
  const calls = [];
  const invoke = vi.fn(async (command, args) => {
    calls.push([command, args]);
    if (command === "ensure_workspace") return grant;
    if (command === "read_task_settings") return { workspaceGrant: grant, permissionMode: "ask-before-changes" };
    if (command === "set_window_tool_context") return { context_id: `ctx_${args.runId}` };
    if (command === "execute_tool_call") return approval ? { status: "approval_required" } : { status: "accepted" };
    if (command === "poll_tool_call") return result;
    return undefined;
  });
  return { calls, invoke };
}

async function executor(options) {
  const native = nativeTools(options);
  const workspace = new WorkspaceAccess(native.invoke, "conv_1");
  await workspace.restore();
  const approvals = new ApprovalCenter();
  const tools = new NativeToolExecutor({ invoke: native.invoke, conversationId: "conv_1", workspace, approvals, agentKey: "product:p" });
  return { ...native, workspace, approvals, tools };
}

describe("native tool executor", () => {
  it("advertises local tools only with a verified folder grant", async () => {
    const { tools, workspace } = await executor();
    expect(tools.localTools).toContain("file_read");
    await workspace.revoke();
    expect(tools.localTools).toEqual([]);
  });

  it("registers the run's native context before the message and executes inside it", async () => {
    const { tools, calls } = await executor();
    await tools.prepareRun({ conversationId: "conv_1", runId: "run_1" });
    expect(calls.find(([command]) => command === "set_window_tool_context")[1]).toEqual({ conversationId: "conv_1", runId: "run_1", workspaceGrantId: "grant_1", permissionPolicy: "ask-before-changes" });
    const result = await tools.execute({ run_id: "run_1", tool_call_id: "t1", name: "file_read", arguments: {} });
    expect(result).toEqual({ status: "ok", result: { text: "done" } });
    expect(calls.find(([command]) => command === "execute_tool_call")[1]).toMatchObject({ contextId: "ctx_run_1", runId: "run_1" });
  });

  it("relays the user's decision for a call the native gate holds", async () => {
    const { tools, approvals, calls } = await executor({ approval: true });
    await tools.prepareRun({ conversationId: "conv_1", runId: "run_1" });
    const running = tools.execute({ run_id: "run_1", tool_call_id: "t2", name: "file_write", arguments: { path: "a.md" } });
    await vi.waitFor(() => expect(approvals.getState().pending).toHaveLength(1));
    expect(approvals.countFor("conv_1")).toBe(1);
    approvals.getState().pending[0].decide(false);
    await running;
    expect(calls.some(([command, args]) => command === "deny_pending_tool_call" && args.toolCallId === "t2")).toBe(true);
    expect(approvals.getState().pending).toEqual([]);
  });

  it("answers a tool request without a registered run as unavailable", async () => {
    const { tools } = await executor();
    expect(await tools.execute({ run_id: "unknown", tool_call_id: "t3", name: "file_read" })).toMatchObject({ status: "error", error: { code: "local_tool_unavailable" } });
    expect(localToolDeadlineMs({ name: "shell_exec", arguments: { timeout_ms: 60_000 } })).toBe(65_000);
  });
});

describe("conversation workspace", () => {
  it("never trusts a saved grant the native validator rejects", async () => {
    const invoke = vi.fn(async command => {
      if (command === "read_task_settings") return { workspaceGrant: grant, permissionMode: "allow-changes" };
      if (command === "ensure_workspace") throw new Error("workspace_grant_stale");
    });
    const workspace = new WorkspaceAccess(invoke, "conv_1");
    await workspace.restore();
    expect(workspace.getState()).toMatchObject({ status: "stale", permission: "allow-changes" });
    expect(workspace.grant).toBeNull();
  });

  it("persists choices against its own conversation", async () => {
    const { invoke, calls } = nativeTools();
    const workspace = new WorkspaceAccess(invoke, "conv_9");
    await workspace.restore();
    workspace.setPermission("allow-changes");
    expect(calls.at(-1)).toEqual(["patch_window_settings", { patch: { context: { conversationId: "conv_9", workspaceGrant: grant, permissionMode: "allow-changes" } } }]);
  });
});
