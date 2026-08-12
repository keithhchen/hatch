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
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed with ${response.status}`);
    error.status = response.status;
    error.code = payload.error?.code;
    error.details = payload.error?.details;
    error.request_id = payload.request_id ?? response.headers.get("x-request-id");
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
