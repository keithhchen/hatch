import { formatUsd, getWebLocale, localeTag, localizeWebApiError, translateWeb } from "./webI18n.js";

export async function dashboardRequest(path, options = {}) {
  const { token, ...requestOptions } = options;
  const method = String(options.method ?? "GET").toUpperCase();
  const csrfToken = !["GET", "HEAD", "OPTIONS"].includes(method)
    ? readCookie("hatch_web_csrf")
    : "";
  const locale = getWebLocale();
  const response = await fetch(path, {
    ...requestOptions,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      "x-hatch-locale": locale,
      "accept-language": localeTag(locale),
      // Explicit bearer support remains for non-browser tests and migration
      // clients. The Web app never persists or injects a bearer token.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {})
    }
  });
  if (response.status === 204) return undefined;
  const payload = await response.json();
  if (!response.ok) {
    const localizedPayload = localizeWebApiError(payload, locale);
    const error = new Error(localizedPayload.error?.message ?? `Request failed with ${response.status}`);
    error.status = response.status;
    error.code = localizedPayload.error?.code;
    error.details = localizedPayload.error?.details;
    error.request_id = localizedPayload.request_id ?? response.headers.get("x-request-id");
    throw error;
  }
  return payload;
}

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

export function formatMoney(minor, _currency = "USD") {
  return formatUsd(minor);
}

export function orderStatusLabel(status, locale = getWebLocale()) {
  if (status === "delivered") return translateWeb(locale, "buyer.statusDelivered");
  if (status === "refunded") return translateWeb(locale, "buyer.statusRefunded");
  return translateWeb(locale, "buyer.statusPaid");
}

export function productStatusLabel(status, locale = getWebLocale()) {
  if (status === "published") return translateWeb(locale, "buyer.statusPublished");
  if (status === "ready_to_publish") return translateWeb(locale, "buyer.statusReadyToPublish");
  return translateWeb(locale, "buyer.statusPreparing");
}
