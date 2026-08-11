import { runtimeHttpUrl } from "./entitlement-client.js";

export function isServerConversationId(value) {
  return /^conv_[a-z0-9]+$/i.test(String(value || "").trim());
}

export function isTerminalRunStatus(value) {
  return new Set(["completed", "failed", "cancelled"]).has(
    String(value || "").trim().toLowerCase()
  );
}

/**
 * A running or interrupted task owns the current window's executor context.
 * Starting another Conversation must therefore use a separate native window;
 * terminal projections are safe to clear and may reuse the current window.
 */
export function shouldOpenNewConversationInWindow(activeRun) {
  const runId = String(activeRun?.runId ?? activeRun?.id ?? "").trim();
  return Boolean(runId) && !isTerminalRunStatus(activeRun?.status);
}

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

const SNAPSHOT_EVENT_TYPES = new Set([
  "conversation.created",
  "conversation.updated",
  "run.created",
  "run.state",
  "message.created"
]);

/**
 * Reconcile the journal portion of a durable snapshot without creating a
 * second transcript projection in the renderer. The Runtime response already
 * contains the canonical full `messages` and `runs` projections; the journal
 * is the cursor/idempotency boundary that proves which changes were included.
 *
 * We therefore validate and de-duplicate journal events before accepting the
 * reported cursor. A malformed, out-of-order, or unknown event must not allow
 * the renderer to advance its cursor past state it has not safely projected.
 */
export function reconcileConversationSnapshot(snapshot, { afterCursor = 0 } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw conversationClientError("The Conversation snapshot is invalid.", "snapshot_invalid");
  }
  const priorCursor = Number(afterCursor);
  if (!Number.isSafeInteger(priorCursor) || priorCursor < 0) {
    throw conversationClientError("The Conversation cursor is invalid.", "snapshot_invalid");
  }
  const reportedCursor = Number(snapshot.cursor);
  if (!Number.isSafeInteger(reportedCursor) || reportedCursor < priorCursor) {
    throw conversationClientError("The Conversation snapshot cursor is invalid.", "snapshot_invalid");
  }
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const runIds = new Set(runs.map((run) => String(run?.id ?? run?.run_id ?? "").trim()).filter(Boolean));
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const seen = new Set();
  const reconciledEvents = [];
  let previousCursor = priorCursor;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw conversationClientError("The Conversation journal is invalid.", "snapshot_invalid");
    }
    const cursor = Number(event.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= 0) {
      throw conversationClientError("The Conversation journal cursor is invalid.", "snapshot_invalid");
    }
    // A server may return an event already covered by a retrying request. It
    // is safe to discard that duplicate, but never to accept a new event out
    // of order.
    if (cursor <= priorCursor || seen.has(cursor)) continue;
    if (cursor < previousCursor) {
      throw conversationClientError("The Conversation journal is out of order.", "snapshot_invalid");
    }
    if (!SNAPSHOT_EVENT_TYPES.has(String(event.type || ""))) {
      throw conversationClientError("The Conversation journal contains an unknown event.", "snapshot_invalid");
    }
    const runId = String(event.run_id ?? event.runId ?? "").trim();
    if (runId && !runIds.has(runId)) {
      throw conversationClientError("The Conversation journal references an unknown Run.", "snapshot_invalid");
    }
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw conversationClientError("The Conversation journal payload is invalid.", "snapshot_invalid");
    }
    seen.add(cursor);
    previousCursor = cursor;
    reconciledEvents.push(event);
  }
  if (reconciledEvents.length && previousCursor > reportedCursor) {
    throw conversationClientError("The Conversation journal exceeds its snapshot cursor.", "snapshot_invalid");
  }
  return {
    messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
    runs,
    events: reconciledEvents,
    cursor: reportedCursor
  };
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
  const dismissed = String(dismissedRunId || "").trim();
  const interruptedEntries = [...runs]
    .filter((run) => run && run.status === "interrupted")
    .map((run) => ({
      run,
      id: String(run.id ?? run.run_id ?? "").trim()
    }))
    .filter((entry) => entry.id && entry.id !== dismissed);
  const currentRunId = String(currentRun?.runId || "").trim();
  const interrupted = currentRunId
    ? interruptedEntries.find((entry) => entry.id === currentRunId)
    : interruptedEntries.at(-1);
  if (!interrupted) return null;

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
