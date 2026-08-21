/**
 * Keep a Conversation creation idempotency key alive for retries made by the
 * same renderer. The key is intentionally in-memory only: it is not an auth
 * secret, but persisting it as window/session state would make a later user
 * action look like a retry after a restart.
 */
export function createConversationCreationTracker() {
  const pending = new Map();
  return {
    requestId(scope, createId) {
      const key = String(scope || "").trim();
      if (!key) throw new Error("Conversation creation scope is required.");
      const existing = pending.get(key);
      if (existing) return existing;
      const next = String(createId?.() || "").trim();
      if (!next) throw new Error("Conversation creation idempotency key is required.");
      pending.set(key, next);
      return next;
    },
    settle(scope, { retryable = false } = {}) {
      if (retryable) return;
      pending.delete(String(scope || "").trim());
    },
    clear(scope) {
      pending.delete(String(scope || "").trim());
    },
    size() {
      return pending.size;
    }
  };
}

export function conversationCreationScope({ accountId = "", binding = {}, purpose = "create" } = {}) {
  // JSON avoids accidental collisions from delimiter characters in IDs while
  // keeping the scope easy to inspect in a debugger.
  return JSON.stringify([
    String(purpose || "create").trim(),
    String(accountId || "").trim(),
    String(binding.entitlementId || "").trim()
  ]);
}
