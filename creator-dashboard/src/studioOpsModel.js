// Pure helpers for the Studio orders, earnings and settings pages.
// No React here so node --test can exercise them directly.

export const INTL_LOCALE = { zh: "zh-CN", en: "en-US", ja: "ja-JP" };

export const ORDER_FILTER_KEYS = ["product", "order", "payment", "delivery", "refund", "from", "to"];

export const ORDER_FILTER_OPTIONS = {
  order: ["paid", "fulfilled", "delivered", "partially_refunded", "refunded", "cancelled"],
  payment: ["succeeded", "paid", "processing", "failed", "not_required", "partially_refunded", "refunded"],
  delivery: ["completed", "not_started"],
  refund: ["none", "refunded"]
};

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

/** A YYYY-MM-DD date input value → ISO timestamp at the start or end of that local day. */
export function dayBoundary(day, edge) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return "";
  const date = new Date(`${day}T${edge === "end" ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

/** Filter state (date inputs as YYYY-MM-DD) → query string for /v1/creator/orders(/export). */
export function ordersQuery(filters = {}, paging = {}) {
  const params = new URLSearchParams();
  for (const key of ORDER_FILTER_KEYS) {
    const raw = String(filters[key] ?? "").trim();
    if (!raw) continue;
    const value = key === "from" ? dayBoundary(raw, "start") : key === "to" ? dayBoundary(raw, "end") : raw;
    if (value) params.set(key, value);
  }
  if (paging.limit) params.set("limit", String(Math.min(100, Math.max(1, paging.limit))));
  if (paging.cursor) params.set("cursor", paging.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function activeFilterCount(filters = {}) {
  return ORDER_FILTER_KEYS.filter((key) => String(filters[key] ?? "").trim()).length;
}

/** Creator and Hatch shares recognized on an order (reversed revenue excluded). */
export function orderShares(order) {
  const revenue = Array.isArray(order?.revenue) ? order.revenue.filter((entry) => entry.status === "recognized") : [];
  if (!revenue.length) {
    if (Number.isFinite(order?.creator_share_minor)) {
      return { recognized: true, creator: order.creator_share_minor, hatch: order.hatch_share_minor ?? 0 };
    }
    return { recognized: false, creator: null, hatch: null };
  }
  return {
    recognized: true,
    creator: revenue.reduce((sum, entry) => sum + Number(entry.creator_share_minor ?? 0), 0),
    hatch: revenue.reduce((sum, entry) => sum + Number(entry.hatch_share_minor ?? 0), 0)
  };
}

export function orderProductName(order, productNames = {}) {
  return order?.product_name ?? order?.product_snapshot?.name ?? productNames[order?.product_id] ?? order?.product_id ?? "";
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
