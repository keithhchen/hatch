// Pure helpers for the Studio users, earnings and settings pages.
// No React here so node --test can exercise them directly.

export const INTL_LOCALE = { zh: "zh-CN", en: "en-US", ja: "ja-JP" };

export function intlLocale(locale) {
  return INTL_LOCALE[locale] ?? INTL_LOCALE.en;
}

export function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

/** Formats an integer amount in minor units (cents, yen…) for the page locale. */
export function formatMinor(minor, currency = "USD", locale = "en") {
  if (minor === null || minor === undefined || !Number.isFinite(Number(minor))) return "";
  const code = String(currency || "USD").toUpperCase();
  const digits = currencyDigits(code);
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(minor) / 10 ** digits);
}

export function formatDateTime(value, locale = "en") {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(time);
}

export function formatDate(value, locale = "en") {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" }).format(time);
}

const USER_LABEL_KEYS = { account: "userAccount", guest: "userGuest", im: "userIm" };

export function userLabelKey(kind) {
  return USER_LABEL_KEYS[kind] ?? USER_LABEL_KEYS.account;
}

/** Rows from GET /v1/creator/users, most recently active first. */
export function userRows(users) {
  return [...(Array.isArray(users) ? users : [])].sort((a, b) => Date.parse(b.last_at ?? "") - Date.parse(a.last_at ?? "") || 0);
}

export function userTotals(rows) {
  return {
    users: rows.length,
    agents: new Set(rows.map((row) => row.product_id)).size,
    conversations: rows.reduce((sum, row) => sum + Number(row.conversations ?? 0), 0),
    messages: rows.reduce((sum, row) => sum + Number(row.messages ?? 0), 0)
  };
}

export function usersQuery(productId) {
  return productId ? `?product_id=${encodeURIComponent(productId)}` : "";
}

export function payoutSetupState(payouts) {
  if (!payouts || payouts.setup_available === false || payouts.setup_status === "unavailable") return "unavailable";
  return payouts.setup_status === "complete" ? "complete" : "required";
}

export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function statusTone(value) {
  if (["paid", "succeeded", "fulfilled", "delivered", "completed", "active", "complete", "recognized"].includes(value)) return "pass";
  if (["failed", "refunded", "revoked", "cancelled", "partially_refunded"].includes(value)) return "fail";
  if (["reserved", "submitted", "in_transit", "processing", "pending", "not_started"].includes(value)) return "wait";
  return "neutral";
}
