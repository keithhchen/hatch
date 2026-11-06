import { ConversationTransport, RuntimeConnection } from "@hatch/chat";
import { PROTOCOL_VERSION, RUNTIME_SOCKET_URL } from "../config.js";
import * as rest from "../conversation-client.js";

/** The browser's IANA time zone, so the Agent knows the user's local time. */
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Desktop ConversationTransport: the bearer-token Runtime REST client plus
 * a direct Runtime WebSocket. `agent` supplies the access binding — an owner
 * by `productId`, an acquirer by `entitlementId` — and Runtime decides
 * whether it authorizes this account for every request.
 */
export class DesktopConversationTransport extends ConversationTransport {
  constructor({ token, binding, clientVersion, fetchImpl = (...args) => fetch(...args), socketUrl = RUNTIME_SOCKET_URL, WebSocketImpl = globalThis.WebSocket }) {
    super();
    Object.assign(this, { token, binding, clientVersion, fetchImpl, socketUrl, WebSocketImpl });
    this.assetSources = new Map();
  }

  /** Wire fields for the hello frame: exactly one access key. */
  get scope() {
    return this.binding.entitlementId ? { entitlement_id: this.binding.entitlementId } : { product_id: this.binding.productId };
  }

  call(method, ...args) {
    return rest[method](this.socketUrl, this.token, this.binding, ...args, this.fetchImpl);
  }

  list(cursor) { return this.call("listConversations", { status: "active", limit: 50, cursor }); }
  create({ briefAnswers } = {}) { return this.call("createConversation", { clientRequestId: crypto.randomUUID(), briefAnswers }); }
  update(conversationId, input) { return this.call("updateConversation", conversationId, input); }
  snapshot(conversationId) { return this.call("getConversationSnapshot", conversationId, 0); }
  history(conversationId, { beforeCursor }) { return this.call("getConversationHistoryPage", conversationId, { beforeCursor }); }
  events(conversationId, { afterCursor, throughCursor }) { return this.call("getConversationJournalPage", conversationId, { afterCursor, throughCursor }); }
  run(conversationId, runId) { return this.call("getConversationRun", conversationId, runId); }
  async toolDetail(conversationId, detailRef) { return { tool: await this.call("getConversationToolDetail", conversationId, detailRef) }; }

  assetUrl(conversationId, assetId) {
    return rest.runtimeHttpUrl(this.socketUrl, `/v1/conversations/${encodeURIComponent(conversationId)}/assets/${encodeURIComponent(assetId)}`);
  }

  /** Assets need the bearer header, so pictures render from object URLs. */
  assetSource(conversationId, assetId) {
    const key = `${conversationId}:${assetId}`;
    if (!this.assetSources.has(key)) {
      const source = this.call("fetchAsset", conversationId, assetId).then(async response => URL.createObjectURL(await response.blob()));
      source.catch(() => this.assetSources.delete(key));
      this.assetSources.set(key, source);
    }
    return this.assetSources.get(key);
  }

  connect(conversationId, handlers) {
    return new DesktopRuntimeConnection({ conversationId, transport: this, handlers });
  }

  dispose() {
    for (const source of this.assetSources.values()) void source.then(url => URL.revokeObjectURL(url), () => {});
    this.assetSources.clear();
  }
}

export class DesktopRuntimeConnection extends RuntimeConnection {
  constructor({ conversationId, transport, handlers: { onOpen, onEvent, onClose } }) {
    super();
    this.conversationId = conversationId;
    this.transport = transport;
    this.socket = new transport.WebSocketImpl(transport.socketUrl);
    this.socket.onopen = onOpen;
    this.socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      onEvent(message);
    };
    this.socket.onclose = onClose;
  }

  hello(localTools) {
    this.frame({
      type: "client.hello",
      protocol_version: PROTOCOL_VERSION,
      auth_token: this.transport.token,
      conversation_id: this.conversationId,
      ...this.transport.scope,
      client_version: this.transport.clientVersion,
      local_tools: localTools,
      time_zone: browserTimeZone()
    });
  }

  send({ runId, clientMessageId, content = "", attachments = [], taskStart = false, localTools }) {
    this.frame({
      type: "client.message", run_id: runId, client_message_id: clientMessageId,
      conversation_id: this.conversationId, local_tools: localTools, time_zone: browserTimeZone(),
      ...(taskStart ? { task_start: true } : {}),
      message: { role: "user", content, ...(attachments.length ? { attachments } : {}) }
    });
  }

  toolResult(runId, toolCallId, { status, result, error }) {
    this.frame({ type: "tool_call.result", run_id: runId, tool_call_id: toolCallId, status, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) });
  }

  cancel(runId) { this.frame({ type: "turn.cancel", run_id: runId, reason: "user_requested" }); }
  frame(message) { this.socket.send(JSON.stringify(message)); }
  get ready() { return this.socket.readyState === 1; }
  close() { this.socket.close(); }
}
