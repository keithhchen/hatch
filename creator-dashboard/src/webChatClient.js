const API = "/v1/web-chat/conversations";
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2048;
const COMPRESS_ABOVE_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export class WebChatClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebChatClientError";
    this.code = code;
  }
}
export class WebChatClient {
  constructor(request, entitlementId) {
    this.request = request;
    this.entitlementId = entitlementId;
  }

  url(path = "", parameters = {}) {
    const query = new URLSearchParams({ entitlement_id: this.entitlementId, ...parameters });
    return `${API}${path}?${query}`;
  }

  list(cursor) {
    return this.request(this.url("", cursor ? { cursor } : {}));
  }

  create(briefAnswers) {
    return this.request(this.url(), {
      method: "POST",
      body: JSON.stringify({
        client_request_id: crypto.randomUUID(),
        ...(briefAnswers ? { brief_answers: briefAnswers } : {})
      })
    });
  }

  snapshot(conversationId) {
    return this.request(this.url(`/${encodeURIComponent(conversationId)}/snapshot`, { view: "page" }));
  }

  history(conversationId, cursor) {
    return this.request(this.url(`/${encodeURIComponent(conversationId)}/history`, { before_cursor: cursor }));
  }

  toolDetail(conversationId, runId, toolCallId) {
    const path = [conversationId, "tools", runId, toolCallId].map(encodeURIComponent).join("/");
    return this.request(this.url(`/${path}`));
  }
  assetUrl(conversationId, assetId) {
    return this.url(`/${encodeURIComponent(conversationId)}/assets/${encodeURIComponent(assetId)}`);
  }

  openRuntime(conversationId) {
    return new BrowserRuntimeConnection(conversationId, this.entitlementId);
  }
}

export class BrowserRuntimeConnection {
  constructor(conversationId, entitlementId) {
    this.conversationId = conversationId;
    this.entitlementId = entitlementId;
    this.socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/v1/web-chat/runtime`);
  }

  hello() {
    this.send({
      type: "client.hello", protocol_version: "0.8", conversation_id: this.conversationId,
      entitlement_id: this.entitlementId, client_version: "hatch-web", local_tools: []
    });
  }

  message({ runId, clientMessageId, content = "", attachments = [], taskStart = false }) {
    this.send({
      type: "client.message", run_id: runId, client_message_id: clientMessageId,
      conversation_id: this.conversationId, local_tools: [],
      ...(taskStart ? { task_start: true } : {}),
      message: { role: "user", content, ...(attachments.length ? { attachments } : {}) }
    });
  }

  toolResult(runId, toolCallId, error) {
    this.send({
      type: "tool_call.result",
      run_id: runId,
      tool_call_id: toolCallId,
      status: "error",
      error
    });
  }
  cancel(runId) { this.send({ type: "turn.cancel", run_id: runId }); }
  send(message) { this.socket.send(JSON.stringify(message)); }
  get ready() { return this.socket.readyState === WebSocket.OPEN; }
  close() { this.socket.close(); }
}

export class BrowserImageAttachments {
  static accepts(mediaType) { return IMAGE_TYPES.has(mediaType); }

  static async prepareAll(files) {
    if (files.length > 8) throw new WebChatClientError("imageCountLimit");
    if (files.reduce((total, file) => total + file.size, 0) > MAX_IMAGE_BYTES) {
      throw new WebChatClientError("imageTotalSizeLimit");
    }
    return Promise.all(files.map(file => this.prepare(file)));
  }

  /** Shrink a photo before upload: long edge at most 2048 px, JPEG. GIFs stay as they are, they may be animated. */
  static async compress(file) {
    if (file.type === "image/gif") return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= COMPRESS_ABOVE_BYTES) { bitmap.close(); return file; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new WebChatClientError("imageFormatInvalid");
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
  }

  static async prepare(original) {
    if (!this.accepts(original.type) || original.size < 1 || original.size > MAX_IMAGE_BYTES) {
      throw new WebChatClientError("imageFormatInvalid");
    }
    const file = await this.compress(original);
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
