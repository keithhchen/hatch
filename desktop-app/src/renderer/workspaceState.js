export async function selectWorkspace({
  invokeTauri,
  storage,
  setWorkspaceRef,
  setWorkspace,
  disconnectRuntime,
  previousWorkspace = "",
  recordTrace,
  correlationId = workspaceCorrelationId()
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
    const selected = await invokeTauri("pick_workspace");
    if (!selected) {
      trace("workspace.pick.result", "cancelled", {
        root_changed: false,
        equals_previous: true
      });
      return undefined;
    }
    trace("workspace.pick.result", "selected", rootChanged(selected));

    trace("workspace.ensure.start", "requested");
    const normalized = await invokeTauri("ensure_workspace", {
      workspaceRoot: selected
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
    trace("workspace.select.exception", "error");
    throw error;
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
