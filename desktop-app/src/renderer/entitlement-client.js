import { englishMessage } from "./i18n.js";
import { isUuidV4 } from "./identity.js";

export async function fetchPurchasedCreatorAgents(registryUrl, authToken, fetchImpl = fetch) {
  let accessResponse;
  try {
    accessResponse = await fetchImpl(new URL("/v1/user/product-access", registryUrl).toString(), {
      headers: { authorization: `Bearer ${authToken}`, accept: "application/json" }
    });
  } catch (error) {
    throw clientError(
      englishMessage("error.network.unreachable"),
      "network_error",
      error,
      undefined,
      "error.network.unreachable"
    );
  }
  const accessPayload = await accessResponse.json().catch(() => ({}));
  if (!accessResponse.ok) {
    throw clientError(
      accessPayload?.detail || englishMessage(
        accessResponse.status === 401 ? "error.auth.invalidSession" : "error.entitlement.requestFailed"
      ),
      accessResponse.status === 401 ? "auth_invalid" : "entitlement_request_failed",
      null,
      accessResponse.status,
      accessResponse.status === 401 ? "error.auth.invalidSession" : "error.entitlement.requestFailed"
    );
  }
  // Registry returns a bare array. The Dashboard BFF may wrap the same real
  // access projection while a request is routed through the browser surface;
  // accept that envelope without changing the UUID authority fields.
  const accessRows = Array.isArray(accessPayload)
    ? accessPayload
    : Array.isArray(accessPayload?.creator_agents)
      ? accessPayload.creator_agents
      : null;
  if (!accessRows) {
    throw localizedError(
      englishMessage("error.entitlement.invalidLibrary"),
      "error.entitlement.invalidLibrary"
    );
  }
  return accessRows
    .filter(isCreatorAgentEntitlement)
    .sort((left, right) => Date.parse(right.granted_at || "") - Date.parse(left.granted_at || ""));
}

export function runtimeHttpUrl(runtimeUrl, pathname) {
  let url;
  try {
    url = new URL(runtimeUrl);
  } catch (error) {
    if (error && typeof error === "object") error.i18nKey = "error.entitlement.invalidRuntimeUrl";
    throw error;
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isCreatorAgentEntitlement(value) {
  const productId = value?.product_id;
  const agentId = value?.agent_id;
  return Boolean(
    value?.status === "active"
    && isUuidV4(value?.entitlement_id)
    && isUuidV4(value?.user_id)
    && isUuidV4(value?.creator_id)
    && isUuidV4(productId)
    && (!value?.order_id || isUuidV4(value.order_id))
    && (!agentId || agentId === productId)
    && value?.creator?.id === value.creator_id
    && value?.creator?.name
    && value?.product?.id === productId
    && value?.product?.name
  );
}

function clientError(message, code, cause = null, status, i18nKey, i18nValues) {
  const error = localizedError(message, i18nKey, i18nValues);
  error.code = code;
  if (status) error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function localizedError(message, i18nKey, i18nValues) {
  const error = new Error(message);
  error.i18nKey = i18nKey;
  if (i18nValues) error.i18nValues = i18nValues;
  return error;
}
