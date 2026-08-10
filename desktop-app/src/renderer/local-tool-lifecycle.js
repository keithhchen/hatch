export const LOCAL_TOOL_TRANSPORT_GRACE_MS = 5_000;
export const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000;
export const LOCAL_TOOL_STOP_UNCONFIRMED =
  "Hatch couldn't confirm that the local tool stopped. Check the workspace before continuing.";

export function localToolTransportDeadlineMs(message, graceMs = LOCAL_TOOL_TRANSPORT_GRACE_MS) {
  const requested = Number(message?.arguments?.timeout_ms);
  const nativeTimeout = message?.name === "shell_exec"
    && Number.isFinite(requested)
    && requested >= 100
    && requested <= 120_000
    ? requested
    : DEFAULT_NATIVE_TOOL_TIMEOUT_MS;
  return nativeTimeout + Math.max(0, Number(graceMs) || 0);
}

export function localToolCancellationError(message, reason, deadlineMs) {
  const timedOut = reason === "timeout";
  const error = new Error(timedOut
    ? `Local tool did not return within its native timeout plus transport grace (${Math.round(deadlineMs / 1000)}s): ${message.name}`
    : `Local tool was stopped before completion: ${message.name}`);
  error.code = timedOut ? "local_tool_timeout" : "local_tool_cancelled";
  return error;
}

export function statusAfterLocalToolStop(successStatus, stopped) {
  return stopped ? successStatus : LOCAL_TOOL_STOP_UNCONFIRMED;
}

export function committedResultAfterCancellation(result) {
  return result && result.error?.code !== "cancelled" ? result : null;
}
