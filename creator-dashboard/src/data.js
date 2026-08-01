export async function dashboardRequest(path, options = {}) {
  const token = options.token ?? sessionStorage.getItem("hatch.creator.session");
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
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
    throw error;
  }
  return payload;
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
