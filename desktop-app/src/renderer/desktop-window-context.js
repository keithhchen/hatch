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

