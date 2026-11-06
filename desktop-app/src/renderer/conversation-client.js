/**
 * Desktop's Runtime Conversation REST client: bearer token straight to
 * Runtime, scoped by the Agent's access binding — `{ productId }` for an
 * owner or `{ entitlementId }` for an acquirer, never both. Dependency-free,
 * so the Factory's headless Hatch tool runs the same client in Node.
 */

export function runtimeHttpUrl(runtimeUrl, pathname) {
  const url = new URL(runtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Exactly one access key: an acquirer's entitlement, else the owner's product. */
export function conversationScope(binding = {}) {
  const params = new URLSearchParams();
  if (binding.entitlementId) params.set("entitlement_id", binding.entitlementId);
  else if (binding.productId) params.set("product_id", binding.productId);
  return params;
}

const conversationPath = (conversationId, path = "") => `/v1/conversations/${encodeURIComponent(conversationId)}${path}`;

export function listConversations(serverUrl, accessToken, binding, options = {}, fetchImpl = fetch) {
  const search = conversationScope(binding);
  for (const [key, value] of Object.entries({ status: options.status, cursor: options.cursor, limit: options.limit })) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, "/v1/conversations"), accessToken, { method: "GET", search });
}

export function createConversation(serverUrl, accessToken, binding, input = {}, fetchImpl = fetch) {
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, "/v1/conversations"), accessToken, {
    method: "POST",
    search: conversationScope(binding),
    body: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
      ...(Array.isArray(input.briefAnswers) ? { brief_answers: input.briefAnswers } : {})
    }
  });
}

/** Rename (`title`) or archive (`status: "archived"`) under the `version` guard. */
export function updateConversation(serverUrl, accessToken, binding, conversationId, input = {}, fetchImpl = fetch) {
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, conversationPath(conversationId)), accessToken, {
    method: "PATCH",
    search: conversationScope(binding),
    body: Object.fromEntries(["title", "status", "version"].filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  });
}

export async function getConversationSnapshot(serverUrl, accessToken, binding, conversationId, _afterCursor = 0, fetchImpl = fetch) {
  const search = conversationScope(binding);
  search.set("view", "page");
  const payload = await requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, conversationPath(conversationId, "/snapshot")), accessToken, { method: "GET", search });
  if (payload?.conversation?.id !== conversationId) throw conversationClientError("The Conversation identity does not match the requested session.", "snapshot_invalid");
  return payload;
}

export function getConversationHistoryPage(serverUrl, accessToken, binding, conversationId, options = {}, fetchImpl = fetch) {
  const search = conversationScope(binding);
  search.set("limit", String(options.limit ?? 50));
  if (options.beforeCursor != null) search.set("before_cursor", options.beforeCursor);
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, conversationPath(conversationId, "/history")), accessToken, { method: "GET", search });
}

export function getConversationJournalPage(serverUrl, accessToken, binding, conversationId, options = {}, fetchImpl = fetch) {
  const search = conversationScope(binding);
  search.set("view", "page");
  search.set("after_cursor", String(options.afterCursor ?? 0));
  search.set("limit", String(options.limit ?? 100));
  if (options.throughCursor != null) search.set("through_cursor", String(options.throughCursor));
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, conversationPath(conversationId, "/events")), accessToken, { method: "GET", search });
}

export async function getConversationToolDetail(serverUrl, accessToken, binding, conversationId, detailRef, fetchImpl = fetch) {
  if (!detailRef?.run_id || !detailRef?.tool_call_id) throw conversationClientError("Invalid tool detail reference.", "tool_detail_invalid");
  const path = conversationPath(conversationId, `/tools/${encodeURIComponent(detailRef.run_id)}/${encodeURIComponent(detailRef.tool_call_id)}`);
  const payload = await requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, path), accessToken, { method: "GET", search: conversationScope(binding) });
  if (payload?.tool?.tool_call_id !== detailRef.tool_call_id) throw conversationClientError("Invalid tool detail response.", "tool_detail_invalid");
  return payload.tool;
}

export async function getConversationRun(serverUrl, accessToken, binding, conversationId, runId, fetchImpl = fetch) {
  const payload = await requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, conversationPath(conversationId, `/runs/${encodeURIComponent(runId)}`)), accessToken, { method: "GET", search: conversationScope(binding) });
  if (String(payload?.run?.id ?? payload?.run?.run_id ?? "") !== runId) throw conversationClientError("Invalid Conversation Run response.", "snapshot_invalid");
  return payload.run;
}

/** A Run plus its acceptance receipt; an unknown Run is `{ run: null, submission: null }`. */
export async function getConversationSubmission(serverUrl, accessToken, binding, conversationId, runId, fetchImpl = fetch) {
  try {
    const payload = await requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, conversationPath(conversationId, `/runs/${encodeURIComponent(runId)}`)), accessToken, { method: "GET", search: conversationScope(binding) });
    if (String(payload?.run?.id ?? payload?.run?.run_id ?? "") !== runId || !Object.hasOwn(payload, "submission")) {
      throw conversationClientError("Runtime cannot verify message acceptance.", "acceptance_unavailable");
    }
    return payload;
  } catch (error) {
    if (error?.code === "run_not_found" && error?.status === 404) return { run: null, submission: null };
    throw error;
  }
}

/** Bytes of an asset referenced by a durable message, as base64. */
export async function getConversationAsset(serverUrl, accessToken, binding, conversationId, assetId, fetchImpl = fetch) {
  const response = await fetchAsset(serverUrl, accessToken, binding, conversationId, assetId, fetchImpl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** The authenticated asset response (Desktop renders it from a Blob). */
export async function fetchAsset(serverUrl, accessToken, binding, conversationId, assetId, fetchImpl = fetch) {
  const url = new URL(runtimeHttpUrl(serverUrl, conversationPath(conversationId, `/assets/${encodeURIComponent(assetId)}`)));
  for (const [key, value] of conversationScope(binding)) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url.toString(), { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "*/*" } });
  } catch (cause) {
    throw conversationClientError("Hatch can't reach the Conversation asset store.", "network_error", cause);
  }
  if (!response.ok) {
    const payload = await response.json?.().catch(() => ({})) ?? {};
    const error = conversationClientError(payload?.error?.message || "We couldn't load this attachment.", payload?.error?.code || (response.status === 401 ? "auth_invalid" : "asset_request_failed"));
    error.status = response.status;
    throw error;
  }
  return response;
}

async function requestConversation(fetchImpl, baseUrl, accessToken, { method, search, body }) {
  const url = new URL(baseUrl);
  for (const [key, value] of search ?? []) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (cause) {
    throw conversationClientError("Hatch can't reach your conversations.", "network_error", cause);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = conversationClientError(payload?.error?.message || "We couldn't update this conversation.", payload?.error?.code || (response.status === 401 ? "auth_invalid" : "conversation_request_failed"));
    error.status = response.status;
    throw error;
  }
  return payload;
}

function conversationClientError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}
