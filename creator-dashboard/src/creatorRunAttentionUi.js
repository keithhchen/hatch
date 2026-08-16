export function runNeedsAttention(run) {
  // `factory_stage` is a durable terminal snapshot and can remain
  // `needs_attention` while a retry is already claimed and running. The
  // authoritative lifecycle status must win in that window; otherwise the
  // Creator sees an error panel while the server is doing real work.
  if (run?.status === "queued" || run?.status === "running") return false;
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
