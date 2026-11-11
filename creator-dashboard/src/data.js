import { reportRequestFailure } from "./sentry.js";

export const SERVICE_UNAVAILABLE_MESSAGE = "Hatch is temporarily unavailable. Try again shortly.";

export async function dashboardRequest(path, options = {}) {
  const { token, ...requestOptions } = options;
  const method = String(options.method ?? "GET").toUpperCase();
  const csrfToken = !["GET", "HEAD", "OPTIONS"].includes(method)
    ? readCookie("hatch_web_csrf")
    : "";
  const response = await fetch(path, {
    ...requestOptions,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      // Explicit bearer support remains for non-browser tests and migration
      // clients. The Web app never persists or injects a bearer token.
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {})
    }
  });
  if (response.status === 204) return undefined;
  const failure = (error) => {
    error.status = response.status;
    error.request_id ??= response.headers.get("x-request-id");
    reportRequestFailure(error, {
      method,
      path: String(path).split("?")[0],
      capture: response.status >= 500 || !error.code
    });
    return error;
  };
  let payload;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body (e.g. a Cloudflare HTML error page): never leak the parser error.
    throw failure(new Error(response.ok ? "Something went wrong. Try again." : SERVICE_UNAVAILABLE_MESSAGE));
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed with ${response.status}`);
    error.code = payload.error?.code;
    error.details = payload.error?.details;
    error.request_id = payload.request_id;
    throw failure(error);
  }
  return payload;
}

function readCookie(name) {
  if (typeof document === "undefined") return "";
  const prefix = `${encodeURIComponent(name)}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : "";
}

export function formatMoney(minor, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(minor / 100);
}

export function orderStatusLabel(status) {
  if (status === "delivered") return "Delivered";
  if (status === "refunded") return "Refunded";
  return "Paid";
}

export function productStatusLabel(status) {
  if (status === "published") return "Published";
  if (status === "ready_to_publish") return "Ready to publish";
  return "Preparing";
}
