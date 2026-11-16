import { WebConversationTransport } from "./webChatClient.js";

const SEND_TIMEOUT_MS = 30_000;

/** The scope every artifact call carries, like chat: an entitlement for buyers, the product for its owner. */
export const accessScope = (access, productId) => access.entitlement_id ? { entitlement_id: access.entitlement_id } : { product_id: productId };

/**
 * Artifact-mode calls through the Dashboard proxy. `request` is the page's cookie-authenticated request;
 * conversations are created and listed by the same transport chat uses.
 */
export class ArtifactApi {
  constructor(request, scope) {
    this.request = request;
    this.scope = scope;
    this.transport = new WebConversationTransport(request, scope);
  }

  query(extra = {}) { return `?${new URLSearchParams({ ...this.scope, ...extra })}`; }

  /** The intake definition, or null when the product is not in artifact mode. */
  async definition(productId) {
    try { return await this.request(`/v1/web-chat/products/${encodeURIComponent(productId)}/artifact${this.query()}`); }
    catch (error) { if (error?.status === 404) return null; throw error; }
  }

  conversationsUrl(productId) {
    return `/v1/web-chat/products/${encodeURIComponent(productId)}/artifact/conversations${this.query()}`;
  }

  /** The buyer's reports for this product, newest first. */
  listConversations(productId) {
    return this.request(this.conversationsUrl(productId));
  }

  /** A new artifact conversation, its report in 'draft'. The same key is the same conversation, however often it is sent. */
  async createConversation(productId, submissionKey) {
    const { conversation_id: conversationId } = await this.request(this.conversationsUrl(productId), { method: "POST", body: "{}", headers: { "idempotency-key": submissionKey } });
    return conversationId;
  }

  report(conversationId) {
    return this.request(this.transport.conversationUrl(conversationId, "/report"));
  }

  reportFileUrl(conversationId, name) {
    return this.transport.conversationUrl(conversationId, `/report/files/${encodeURIComponent(name)}`);
  }

  /** Raw bytes to the conversation's asset route under `name`, with byte progress. Resolves to the runtime's asset record. */
  upload(conversationId, file, name, mediaType, onProgress) {
    const url = this.transport.conversationUrl(conversationId, "/assets", { name });
    const csrf = decodeURIComponent(document.cookie.split("; ").find(entry => entry.startsWith("hatch_web_csrf="))?.split("=")[1] ?? "");
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      xhr.setRequestHeader("content-type", mediaType);
      if (csrf) xhr.setRequestHeader("x-csrf-token", csrf);
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
      xhr.onerror = () => reject(Object.assign(new Error("Network error"), { code: "network" }));
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
        else reject(Object.assign(new Error(body?.error?.message ?? `Upload failed (${xhr.status})`), { status: xhr.status, code: body?.error?.code }));
      };
      xhr.send(file);
    });
  }

  /** The first message of the conversation, form text only (files live in the conversation, not on the message), which starts the run. Resolves when the Runtime accepted it. */
  sendFirstMessage(conversationId, content, { clientMessageId, runId }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action, value) => { if (settled) return; settled = true; clearTimeout(timer); connection.close(); action(value); };
      const timer = setTimeout(() => finish(reject, new Error("The Runtime did not accept the message.")), SEND_TIMEOUT_MS);
      const connection = this.transport.connect(conversationId, {
        onOpen: () => connection.hello([]),
        onEvent: event => {
          if (event.type === "session.ready") connection.send({ runId, clientMessageId, content, localTools: [] });
          else if (event.type === "message.accepted" && event.client_message_id === clientMessageId) finish(resolve);
          else if (event.type === "session.error" || event.type === "frame.rejected") finish(reject, Object.assign(new Error(event.error?.message ?? "The message was refused."), { code: event.error?.code }));
        },
        onClose: () => finish(reject, new Error("Connection closed before the message was accepted."))
      });
    });
  }
}

/** The product's artifact definition and the buyer's reports, or null when the product is not in artifact mode. */
export async function loadArtifact(request, access, productId) {
  const api = new ArtifactApi(request, accessScope(access, productId));
  const definition = await api.definition(productId);
  if (!definition) return null;
  return { api, definition, conversations: await api.listConversations(productId) };
}
