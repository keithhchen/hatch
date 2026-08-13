import { englishMessage } from "./i18n.js";

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
  if (!Array.isArray(accessPayload)) {
    throw localizedError(
      englishMessage("error.entitlement.invalidLibrary"),
      "error.entitlement.invalidLibrary"
    );
  }
  return accessPayload
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
  return Boolean(
    value?.status === "active"
    && value?.entitlement_id
    && value?.creator?.id
    && value?.creator?.name
    && value?.product?.id
    && value?.product_id
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
