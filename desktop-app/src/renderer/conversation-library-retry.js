export const DEFAULT_CONVERSATION_LIBRARY_RETRY_DELAYS_MS = Object.freeze([
  1_000,
  2_000,
  5_000,
  10_000,
  30_000
]);

/**
 * Keep Conversation Library recovery bounded and scoped to one account/Agent
 * binding. The caller owns the actual timer and request cancellation; this
 * controller only decides when a retry or an explicit focus/online trigger is
 * allowed.
 */
export function createConversationLibraryRetryController({
  delays = DEFAULT_CONVERSATION_LIBRARY_RETRY_DELAYS_MS,
  manualCooldownMs = 1_500
} = {}) {
  const retryDelays = Array.isArray(delays)
    ? delays.map((value) => Math.max(0, Number(value))).filter(Number.isFinite)
    : [];
  const cooldown = Math.max(0, Number(manualCooldownMs) || 0);
  let scope = "";
  let attempt = 0;
  let lastManualTriggerAt = Number.NEGATIVE_INFINITY;

  return {
    setScope(nextScope = "") {
      const next = String(nextScope || "");
      if (next === scope) return;
      scope = next;
      attempt = 0;
      lastManualTriggerAt = Number.NEGATIVE_INFINITY;
    },
    reset(nextScope = scope) {
      scope = String(nextScope || "");
      attempt = 0;
      lastManualTriggerAt = Number.NEGATIVE_INFINITY;
    },
    nextAutomaticRetry({ retryable = true } = {}) {
      if (!retryable || attempt >= retryDelays.length) return null;
      const nextAttempt = attempt + 1;
      const delay = retryDelays[attempt];
      attempt = nextAttempt;
      return { attempt, delay };
    },
    allowManualTrigger(now = Date.now()) {
      const timestamp = Number(now);
      if (!Number.isFinite(timestamp) || timestamp - lastManualTriggerAt < cooldown) return false;
      lastManualTriggerAt = timestamp;
      // A focus/online event is an explicit new recovery opportunity. Start a
      // fresh bounded backoff burst instead of inheriting an exhausted outage.
      attempt = 0;
      return true;
    },
    getSnapshot() {
      return { scope, attempt, lastManualTriggerAt };
    }
  };
}

export function conversationLibraryRetryScope({ accountId = "", binding = {} } = {}) {
  return JSON.stringify([
    String(accountId || "").trim(),
    String(binding.entitlementId || "").trim(),
    String(binding.creatorId || "").trim(),
    String(binding.agentId || "").trim()
  ]);
}

/**
 * A missing/rolling-out Library route can be transient even when fetch itself
 * completed successfully. Retry only generic route/transport failures; do
 * not hide semantic auth, binding, or conversation-not-found errors.
 */
export function isRetryableConversationLibraryError(error) {
  if (error?.code === "network_error") return true;
  if (error?.code !== "conversation_request_failed") return false;
  const status = Number(error?.status);
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}
