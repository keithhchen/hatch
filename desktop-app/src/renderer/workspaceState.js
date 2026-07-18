export async function selectWorkspace({
  invokeTauri,
  storage,
  setWorkspaceRef,
  setWorkspace,
  disconnectRuntime,
  previousWorkspace = "",
  recordTrace,
  correlationId = workspaceCorrelationId(),
  commandTimeoutMs = 30_000
}) {
  const trace = (phase, status, fields = {}) => {
    recordTrace?.(phase, status, correlationId, fields);
  };
  const rootChanged = (root) => ({
    root_changed: root !== previousWorkspace,
    equals_previous: root === previousWorkspace
  });

  trace("workspace.select.start", "requested");
  try {
    trace("workspace.pick.start", "requested");
    const selected = await invokeWorkspaceCommand({
      invokeTauri,
      command: "pick_workspace",
      timeoutMs: commandTimeoutMs,
      onStart: () => trace("workspace.pick.invoke.start", "requested"),
      onResolve: () => trace("workspace.pick.invoke.result", "resolved"),
      onReject: (error) => trace("workspace.pick.invoke.error", workspaceErrorStatus(error))
    });
    if (!selected) {
      trace("workspace.pick.result", "cancelled", {
        root_changed: false,
        equals_previous: true
      });
      return undefined;
    }
    trace("workspace.pick.result", "selected", rootChanged(selected));

    trace("workspace.ensure.start", "requested");
    const normalized = await invokeWorkspaceCommand({
      invokeTauri,
      command: "ensure_workspace",
      args: { workspaceRoot: selected },
      timeoutMs: commandTimeoutMs,
      onStart: () => trace("workspace.ensure.invoke.start", "requested"),
      onResolve: () => trace("workspace.ensure.invoke.result", "resolved"),
      onReject: (error) => trace("workspace.ensure.invoke.error", workspaceErrorStatus(error))
    });
    trace("workspace.ensure.result", "ok", rootChanged(normalized));

    setWorkspaceRef(normalized);
    trace("workspace.ref.updated", "ok", rootChanged(normalized));
    storage.setItem("hatch.workspaceRoot", normalized);
    trace("workspace.storage.write", "ok", rootChanged(normalized));
    setWorkspace(normalized);
    trace("workspace.state.updated", "ok", rootChanged(normalized));
    disconnectRuntime?.();
    trace("workspace.disconnect", disconnectRuntime ? "requested" : "skipped");
    return normalized;
  } catch (error) {
    trace("workspace.select.exception", workspaceErrorStatus(error));
    throw error;
  }
}

export async function invokeWorkspaceCommand({
  invokeTauri,
  command,
  args,
  timeoutMs = 30_000,
  onStart,
  onResolve,
  onReject
}) {
  onStart?.();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Workspace command timed out: ${command}`);
      error.code = "workspace_command_timeout";
      reject(error);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([invokeTauri(command, args), timeout]);
    onResolve?.(result);
    return result;
  } catch (error) {
    onReject?.(error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function restoreWorkspace({ storage, defaultWorkspace, setWorkspaceRef, setWorkspace }) {
  const savedWorkspace = storage.getItem("hatch.workspaceRoot") || defaultWorkspace;
  setWorkspaceRef(savedWorkspace);
  setWorkspace(savedWorkspace);
  return savedWorkspace;
}

function workspaceCorrelationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function workspaceErrorStatus(error) {
  return error?.code === "workspace_command_timeout" ? "timeout" : "error";
}
