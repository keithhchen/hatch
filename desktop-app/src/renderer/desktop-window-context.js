/**
 * Native window context is presentational state (Conversation, draft,
 * workspace projection, scroll/cursor). Window labels are stable across
 * launches, so the context must carry an account binding before it can be
 * restored after a sign-out/sign-in transition.
 */
export function accountScopedWindowContext(value, accountId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const owner = typeof value.accountId === "string" ? value.accountId.trim() : "";
  const account = typeof accountId === "string" ? accountId.trim() : "";
  if (!owner || !account || owner !== account) return {};
  return value;
}

/**
 * The original single-window build used one profile-level active-run slot.
 * Once a Conversation window has a server ID in its URL, its run projection
 * belongs exclusively to the native window context and must never fall back
 * to that shared legacy slot.
 */
export function usesLegacyProfileRunFallback(requestedConversationId) {
  return String(requestedConversationId ?? "").trim() === "";
}
