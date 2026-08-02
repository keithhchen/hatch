export async function dashboardRequest(path, options = {}) {
  const token = options.token ?? sessionStorage.getItem("hatch.creator.session");
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(typeof options.body === "string" ? { "content-type": "application/json" } : {}),
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

export async function fetchVoice(token) {
  try {
    return await dashboardRequest("/v1/creator/voice", { token });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function uploadVoice(blob, token) {
  const form = new FormData();
  form.append("files", blob, "voice-sample");
  form.append("consent_version", "v1");
  if (typeof blob.type === "string" && blob.type) form.append("format", blob.type);
  return dashboardRequest("/v1/creator/voice", { method: "PUT", body: form, token });
}

export async function revokeVoice(token) {
  return dashboardRequest("/v1/creator/voice", { method: "DELETE", token });
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
