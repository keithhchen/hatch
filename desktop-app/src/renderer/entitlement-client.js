export async function fetchPurchasedCreatorAgents(registryUrl, authToken, fetchImpl = fetch) {
  let accessResponse;
  try {
    accessResponse = await fetchImpl(new URL("/v1/user/agent-access", registryUrl).toString(), {
      headers: { authorization: `Bearer ${authToken}`, accept: "application/json" }
    });
  } catch (error) {
    throw clientError("Hatch can't reach the service. Check your connection and try again.", "network_error", error);
  }
  const accessPayload = await accessResponse.json().catch(() => ({}));
  if (!accessResponse.ok) {
    throw clientError(
      accessPayload?.detail || "We couldn't open your agents. Try signing in again.",
      accessResponse.status === 401 ? "auth_invalid" : "entitlement_request_failed",
      null,
      accessResponse.status
    );
  }
  if (!Array.isArray(accessPayload)) throw new Error("We couldn't open your agent library. Try again.");
  return accessPayload
    .filter(isCreatorAgentEntitlement)
    .sort((left, right) => Date.parse(right.granted_at || "") - Date.parse(left.granted_at || ""));
}

export function runtimeHttpUrl(runtimeUrl, pathname) {
  const url = new URL(runtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isCreatorAgentEntitlement(value) {
  return Boolean(
    value?.status === "active"
    && value?.entitlement_id
    && value?.creator?.id
    && value?.creator?.name
    && value?.product?.id
    && value?.product?.name
  );
}

function clientError(message, code, cause = null, status) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  if (cause) error.cause = cause;
  return error;
}
