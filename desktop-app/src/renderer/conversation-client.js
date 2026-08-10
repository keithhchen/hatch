import { runtimeHttpUrl } from "./entitlement-client.js";

/**
 * Small renderer client for the durable Conversation Library.  The renderer
 * supplies only the current entitlement binding; Runtime re-verifies the
 * account and Agent access before answering every request.
 */
export function conversationScope(binding = {}) {
  const params = new URLSearchParams();
  if (binding.entitlementId) params.set("entitlement_id", binding.entitlementId);
  if (binding.creatorId) params.set("creator_id", binding.creatorId);
  if (binding.agentId) params.set("agent_id", binding.agentId);
  return params;
}

export async function listConversations(serverUrl, accessToken, binding, options = {}, fetchImpl = fetch) {
  const params = conversationScope(binding);
  if (options.status) params.set("status", options.status);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, "/v1/conversations"), accessToken, {
    method: "GET",
    search: params
  });
}

export async function createConversation(serverUrl, accessToken, binding, input = {}, fetchImpl = fetch) {
  const params = conversationScope(binding);
  return requestConversation(fetchImpl, runtimeHttpUrl(serverUrl, "/v1/conversations"), accessToken, {
    method: "POST",
    search: params,
    body: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {})
    }
  });
}

export async function updateConversation(serverUrl, accessToken, binding, conversationId, input = {}, fetchImpl = fetch) {
  const params = conversationScope(binding);
  return requestConversation(
    fetchImpl,
    runtimeHttpUrl(serverUrl, `/v1/conversations/${encodeURIComponent(conversationId)}`),
    accessToken,
    {
      method: "PATCH",
      search: params,
      body: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.version !== undefined ? { version: input.version } : {})
      }
    }
  );
}

export async function getConversationSnapshot(serverUrl, accessToken, binding, conversationId, afterCursor = 0, fetchImpl = fetch) {
  const params = conversationScope(binding);
  if (afterCursor > 0) params.set("after_cursor", String(afterCursor));
  return requestConversation(
    fetchImpl,
    runtimeHttpUrl(serverUrl, `/v1/conversations/${encodeURIComponent(conversationId)}/snapshot`),
    accessToken,
    { method: "GET", search: params }
  );
}

/**
 * Project a durable Runtime snapshot into the renderer's interrupted-task
 * affordance. The snapshot is authoritative for a run that was interrupted
 * while this renderer was gone (for example a process crash before the
 * window-context write completed). It never creates an executable/reclaimable
 * run; the caller only uses the projection to show the recovery banner.
 */
export function interruptedRunFromSnapshot(snapshot, currentRun = null, dismissedRunId = "") {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const interrupted = [...runs]
    .filter((run) => run && run.status === "interrupted")
    .map((run) => ({
      run,
      id: String(run.id ?? run.run_id ?? "").trim()
    }))
    .filter((entry) => entry.id)
    .at(-1);
  if (!interrupted || interrupted.id === String(dismissedRunId || "").trim()) return null;

  const { run, id } = interrupted;
  if (currentRun?.runId && currentRun.runId !== id) return null;
  if (currentRun?.runId === id) {
    return {
      ...currentRun,
      status: "interrupted",
      interruptedReason: String(run.interrupted_reason ?? run.interruptedReason ?? "").trim()
    };
  }

  const createdAt = Date.parse(run.created_at ?? run.createdAt ?? "");
  return {
    runId: id,
    clientMessageId: String(run.client_message_id ?? run.clientMessageId ?? "").trim(),
    assistantId: `${id}_assistant`,
    text: "",
    startedAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    timing: {},
    status: "interrupted",
    interruptedReason: String(run.interrupted_reason ?? run.interruptedReason ?? "").trim()
  };
}

async function requestConversation(fetchImpl, baseUrl, accessToken, { method, search, body }) {
  const url = new URL(baseUrl);
  for (const [key, value] of search ?? []) url.searchParams.set(key, value);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    throw conversationClientError("Hatch can't reach your Conversation Library.", "network_error", error);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = conversationClientError(
      payload?.error?.message || "We couldn't update this conversation.",
      payload?.error?.code || (response.status === 401 ? "auth_invalid" : "conversation_request_failed")
    );
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
