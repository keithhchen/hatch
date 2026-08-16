export function runNeedsAttention(run) {
  return run?.status === "needs_attention" || run?.stage === "needs_attention";
}

export function runAttentionAction(run) {
  if (!runNeedsAttention(run)) return null;
  return run?.retryable === true ? "retry" : "add_sources";
}

export function runAttentionError(run) {
  const error = String(run?.last_error ?? "").trim();
  return error || null;
}
