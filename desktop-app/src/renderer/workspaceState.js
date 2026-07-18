export async function selectWorkspace({
  invokeTauri,
  storage,
  setWorkspaceRef,
  setWorkspace,
  disconnectRuntime
}) {
  const selected = await invokeTauri("pick_workspace");
  if (!selected) return undefined;

  const normalized = await invokeTauri("ensure_workspace", {
    workspaceRoot: selected
  });
  setWorkspaceRef(normalized);
  storage.setItem("hatch.workspaceRoot", normalized);
  setWorkspace(normalized);
  disconnectRuntime?.();
  return normalized;
}
