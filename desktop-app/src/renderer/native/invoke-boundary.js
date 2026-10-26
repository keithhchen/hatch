export async function invokeDesktopCommand(command, args, {
  invokeImpl,
  packaged = Boolean(globalThis.window?.__TAURI_INTERNALS__)
} = {}) {
  // Do not even attempt an authority-bearing invoke when Tauri did not inject
  // the packaged-app bridge. This prevents a web shim from manufacturing a
  // result that looks like native authority.
  if (!packaged) {
    if (command === "default_workspace") return "";
    throw desktopOnlyError(command);
  }
  if (typeof invokeImpl !== "function") {
    throw desktopOnlyError(command);
  }
  return invokeImpl(command, args);
}

export function desktopOnlyError(command, cause) {
  const error = new Error(`Native desktop command '${String(command || "unknown")}' is unavailable outside the packaged Hatch app.`);
  error.code = "desktop_only";
  if (cause !== undefined) error.cause = cause;
  return error;
}
