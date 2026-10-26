/** A failed Hatch HTTP request, classified for the UI by `code`. */
export class HatchRequestError extends Error {
  constructor(code, message = code, status = undefined) {
    super(message);
    this.name = "HatchRequestError";
    this.code = code;
    if (status) this.status = status;
  }
}

export const isAuthInvalid = error => error?.code === "auth_invalid" || error?.status === 401;

/**
 * JSON request with an optional bearer token. Transport failures become
 * `network_error`; 401 becomes `auth_invalid`; other failures keep the
 * server's error code so callers can distinguish them.
 */
export async function requestJson(url, { token, method = "GET", body, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(String(url), {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  } catch (cause) {
    const error = new HatchRequestError("network_error", "Hatch can't reach the service.");
    error.cause = cause;
    throw error;
  }
  const payload = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = response.status === 401 ? "auth_invalid" : payload?.error?.code ?? "request_failed";
    throw new HatchRequestError(code, payload?.error?.message ?? payload?.detail ?? code, response.status);
  }
  return payload;
}
