import { englishMessage } from "./i18n.js";

export const LOCAL_TOOL_TRANSPORT_GRACE_MS = 5_000;
export const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 30_000;
export const LOCAL_TOOL_STOP_UNCONFIRMED =
  englishMessage("error.localTool.stopUnconfirmed");
export const LOCAL_TOOL_STOP_UNCONFIRMED_KEY = "error.localTool.stopUnconfirmed";

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
  const seconds = Math.round(deadlineMs / 1000);
  const i18nKey = timedOut ? "error.localTool.timeout" : "error.localTool.cancelled";
  const i18nValues = timedOut
    ? { seconds, name: message.name }
    : { name: message.name };
  const error = new Error(englishMessage(i18nKey, i18nValues));
  error.code = timedOut ? "local_tool_timeout" : "local_tool_cancelled";
  error.i18nKey = i18nKey;
  error.i18nValues = i18nValues;
  return error;
}

/** Keep renderer-only localization metadata out of the strict wire schema. */
export function protocolToolError(error) {
  return {
    code: String(error?.code ?? "local_runner_error"),
    message: String(error?.message ?? "")
  };
}

export function statusAfterLocalToolStop(successStatus, stopped) {
  return stopped ? successStatus : LOCAL_TOOL_STOP_UNCONFIRMED;
}

export function committedResultAfterCancellation(result) {
  return result && result.error?.code !== "cancelled" ? result : null;
}
