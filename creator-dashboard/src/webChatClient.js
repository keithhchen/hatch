import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "@hatch/chat";

const API = "/v1/web-chat/conversations";
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** The browser's IANA time zone, so the Agent knows the user's local time. */
function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export class WebChatClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebChatClientError";
    this.code = code;
  }
}

/**
 * Web ConversationTransport: cookie-authenticated requests through the
 * Dashboard proxy (/v1/web-chat/*). `scope` is the access binding sent with
 * every request and the hello frame (e.g. { entitlement_id }); its shape is
 * owned by the caller, not by this adapter.
 */
export class WebConversationTransport extends ConversationTransport {
  constructor(request, scope) {
    super();
    this.request = request;
    this.scope = scope;
  }

  url(path = "", parameters = {}) {
    return `${API}${path}?${new URLSearchParams({ ...this.scope, ...parameters })}`;
  }

  conversationUrl(conversationId, path = "", parameters) {
    return this.url(`/${encodeURIComponent(conversationId)}${path}`, parameters);
  }

  list(cursor) {
    return this.request(this.url("", cursor ? { cursor } : {}));
  }

  create({ briefAnswers } = {}) {
    return this.request(this.url(), {
      method: "POST",
      body: JSON.stringify({ client_request_id: crypto.randomUUID(), ...(briefAnswers ? { brief_answers: briefAnswers } : {}) })
    });
  }

  snapshot(conversationId) {
    return this.request(this.conversationUrl(conversationId, "/snapshot", { view: "page" }));
  }

  history(conversationId, { beforeCursor }) {
    return this.request(this.conversationUrl(conversationId, "/history", { before_cursor: beforeCursor }));
  }

  events(conversationId, { afterCursor, throughCursor }) {
    return this.request(this.conversationUrl(conversationId, "/events", {
      view: "page", after_cursor: String(afterCursor ?? 0), limit: "100",
      ...(throughCursor != null ? { through_cursor: String(throughCursor) } : {})
    }));
  }

  async run(conversationId, runId) {
    const payload = await this.request(this.conversationUrl(conversationId, `/runs/${encodeURIComponent(runId)}`));
    return payload.run;
  }

  toolDetail(conversationId, { run_id: runId, tool_call_id: toolCallId }) {
    return this.request(this.conversationUrl(conversationId, `/tools/${encodeURIComponent(runId)}/${encodeURIComponent(toolCallId)}`));
  }

  assetUrl(conversationId, assetId) {
    return this.conversationUrl(conversationId, `/assets/${encodeURIComponent(assetId)}`);
  }

  connect(conversationId, handlers) {
    return new BrowserRuntimeConnection(conversationId, this.scope, handlers);
  }
}

export class BrowserRuntimeConnection extends RuntimeConnection {
  constructor(conversationId, scope, { onOpen, onEvent, onClose }) {
    super();
    this.conversationId = conversationId;
    this.scope = scope;
    this.socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/v1/web-chat/runtime`);
    this.socket.onopen = onOpen;
    this.socket.onmessage = event => onEvent(JSON.parse(event.data));
    this.socket.onclose = onClose;
  }

  hello(localTools) {
    this.frame({ type: "client.hello", protocol_version: "0.8", conversation_id: this.conversationId, ...this.scope, client_version: "hatch-web", local_tools: localTools, time_zone: browserTimeZone() });
  }

  send({ runId, clientMessageId, content = "", attachments = [], taskStart = false, localTools }) {
    this.frame({
      type: "client.message", run_id: runId, client_message_id: clientMessageId,
      conversation_id: this.conversationId, local_tools: localTools, time_zone: browserTimeZone(),
      ...(taskStart ? { task_start: true } : {}),
      message: { role: "user", content, ...(attachments.length ? { attachments } : {}) }
    });
  }

  toolResult(runId, toolCallId, result) {
    this.frame({ type: "tool_call.result", run_id: runId, tool_call_id: toolCallId, ...result });
  }

  cancel(runId) { this.frame({ type: "turn.cancel", run_id: runId }); }
  frame(message) { this.socket.send(JSON.stringify(message)); }
  get ready() { return this.socket.readyState === WebSocket.OPEN; }
  close() { this.socket.close(); }
}

/** Browsers attach images only, uploaded inline as content-addressed assets. */
export class BrowserImageAttachments extends AttachmentSource {
  accepts(mediaType) { return IMAGE_TYPES.has(mediaType); }

  async prepareAll(files) {
    if (files.length > this.limit) throw new WebChatClientError("imageCountLimit");
    if (files.reduce((total, file) => total + file.size, 0) > MAX_IMAGE_BYTES) {
      throw new WebChatClientError("imageTotalSizeLimit");
    }
    return Promise.all(files.map(file => this.prepare(file)));
  }

  async prepare(file) {
    if (!this.accepts(file.type) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      throw new WebChatClientError("imageFormatInvalid");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const dataBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const id = `asset_${crypto.randomUUID().replaceAll("-", "")}`;
    return { kind: "asset", attachment_id: id, asset_id: id, display_name: file.name, media_type: file.type, source_bytes: file.size, sha256, data_base64: dataBase64 };
  }
}

/** A browser cannot run local tools or grant approvals; it says so to the Runtime. */
export class UnavailableToolExecutor extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "web_local_tool_unavailable" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false, error: { code: "browser_approval_unavailable" } }); }
}
