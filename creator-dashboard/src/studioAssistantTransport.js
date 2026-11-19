import { AttachmentSource, ConversationTransport, RuntimeConnection, SessionPendingStore as SharedSessionPendingStore } from "@hatch/chat";
import { BrowserImageAttachments } from "./webChatClient.js";

/** The conversation API, the same one the Hatch CLI and every outside client use. */
const ROOT = "/v1/creator/assistant/conversation";
/** The Assistant is one conversation per Expert; the page names it, the server knows it by the account. */
export const ASSISTANT_CONVERSATION = "assistant";

const isImage = mediaType => String(mediaType ?? "").startsWith("image/");

/** A file of a message as the shared chat reads it (the Assistant names files by `name`, `type` and `bytes`). */
const fileOf = file => file.display_name ? file : {
  attachment_id: file.asset_id ?? file.name, asset_id: file.asset_id, display_name: file.name,
  media_type: file.media_type ?? (file.type === "image" ? "image/jpeg" : "application/octet-stream"), ...(file.bytes ? { source_bytes: file.bytes } : {})
};
const publicEvent = event => event.attachments?.length ? { ...event, attachments: event.attachments.map(fileOf) } : event;

/** What a message says to the API: its text, then each file by the id the upload returned. */
const contentOf = (content, attachments) => attachments.length
  ? [...(content ? [{ type: "text", text: content }] : []), ...attachments.map(({ asset_id, type }) => ({ type, assetId: asset_id }))]
  : content;

/**
 * The Studio Assistant as a Conversation, over the conversation API: its log (the same events and pages as Product Chat:
 * `<ROOT>/log` by position, or by turns), its event stream, and a send that carries the message's key as its Idempotency-Key.
 * `view` is what the page shows beside the chat (tasks, channels); it is read with the first page and when something it
 * shows may have changed.
 */
export class StudioAssistantTransport extends ConversationTransport {
  /** @param {(path: string, init?: object) => Promise<any>} request @param {{stream?: (url: string) => EventSource, timeZone?: string}} [options] */
  constructor(request, { stream = url => new EventSource(url), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    super();
    this.request = request;
    this.openStream = stream;
    this.timeZone = timeZone;
    this.view = null;
    this.listeners = new Set();
  }

  get steerable() { return true; }
  get retriesRun() { return true; }

  /** Answers the Assistant again after a failed Run; the key is the Idempotency-Key, so a repeat is the same Run. */
  retryRun(_conversationId, key) {
    return this.request(`${ROOT}/retry`, { method: "POST", headers: { "idempotency-key": key }, body: "{}" });
  }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getView = () => this.view;

  /** The Expert's timezone, told once per page and never by reading. A refusal is not the page's problem. */
  announceTimeZone() {
    this.timeZoneSent ??= this.request(`${ROOT}/timezone`, { method: "PUT", body: JSON.stringify({ timezone: this.timeZone }) }).catch(() => undefined);
  }

  /** The tasks and channels beside the chat. */
  async loadView() {
    this.view = await this.request(`${ROOT}/view`);
    for (const listener of this.listeners) listener();
    return this.view;
  }

  /** A page of the log: events after a position, or the latest turns (before a position). The first page also brings the view. */
  async log(_conversationId, { after, limit, turns, before }) {
    const query = new URLSearchParams({ ...(after != null ? { after: String(after) } : {}), ...(limit != null ? { limit: String(limit) } : {}), ...(turns != null ? { turns: String(turns) } : {}), ...(before != null ? { before: String(before) } : {}) });
    const first = turns != null && before == null;
    if (first) this.announceTimeZone();
    const [page] = await Promise.all([this.request(`${ROOT}/log?${query}`), first ? this.loadView() : undefined]);
    return { ...page, events: page.events.map(publicEvent) };
  }

  assetUrl(_conversationId, assetId) { return `${ROOT}/assets/${encodeURIComponent(assetId)}`; }

  connect(conversationId, handlers) { return new StudioConnection(this, conversationId, handlers); }
}

/**
 * The live session: the event stream says when the log has moved, and the log is read from the position the page holds
 * (so nothing is missed or told twice); a send is a request whose answer says whether it started the Run or joined it.
 */
export class StudioConnection extends RuntimeConnection {
  constructor(transport, conversationId, { onOpen, onEvent, onClose }) {
    super();
    Object.assign(this, { transport, conversationId, onEvent, onClose, opened: false, closed: false, cursor: null, pulling: false, again: false });
    this.source = transport.openStream(`${ROOT}/events`);
    this.source.onopen = () => { this.opened = true; onOpen(); };
    this.source.onmessage = message => {
      this.pull();
      // The tasks and channels beside the chat change with the Assistant's own state.
      try { if (JSON.parse(message.data)?.type === "state") transport.loadView().catch(() => undefined); } catch { /* an event that is not JSON only moved the log */ }
    };
    this.source.onerror = () => this.lose();
  }

  lose() {
    if (this.closed) return;
    this.close();
    this.onClose();
  }

  /** The server's side of a hello is this client's own read: the session is ready, then the log after the position held. */
  hello(_localTools, after) {
    this.cursor = after ?? 0;
    this.onEvent({ type: "session.ready", conversation_id: this.conversationId });
    this.pull();
  }

  /** Read what the log holds past the cursor, one read at a time and one more when the stream said so meanwhile. */
  pull() {
    if (this.cursor === null || this.closed) return;
    if (this.pulling) { this.again = true; return; }
    this.pulling = true;
    void (async () => {
      try {
        do {
          this.again = false;
          for (let more = true; more && !this.closed;) {
            const page = await this.transport.request(`${ROOT}/log?after=${this.cursor}&limit=200`);
            if (this.closed) return;
            for (const event of page.events) {
              this.cursor = Math.max(this.cursor, event.position);
              this.onEvent({ type: "log.event", event: publicEvent(event) });
              if (event.type === "run.state" && ["completed", "failed", "cancelled", "interrupted"].includes(event.status)) this.transport.loadView().catch(() => undefined);
            }
            if (!page.has_more) this.cursor = Math.max(this.cursor, page.head ?? 0);
            more = page.has_more === true && page.events.length > 0;
          }
        } while (this.again && !this.closed);
      } catch { this.lose(); }
      finally { this.pulling = false; }
    })();
  }

  async send({ runId, clientMessageId, content = "", attachments = [] }) {
    const receipt = await this.transport.request(`${ROOT}/messages`, {
      method: "POST", headers: { "idempotency-key": clientMessageId }, body: JSON.stringify({ content: contentOf(content, attachments) })
    });
    // A message that joined the running turn is queued until the turn takes it up.
    this.onEvent({ type: "message.accepted", conversation_id: this.conversationId, run_id: receipt.run_id ?? runId, client_message_id: clientMessageId, outcome: receipt.queued ? "steered" : "started" });
    this.pull();
  }

  toolResult() {}
  /** Asks the server to stop the Run; the log then says how it ended. */
  cancel() {
    this.transport.request(`${ROOT}/stop`, { method: "POST", body: "{}" }).catch(() => undefined);
  }
  get ready() { return this.opened && !this.closed; }

  close() {
    this.closed = true;
    this.source.onopen = this.source.onmessage = this.source.onerror = null;
    this.source.close();
  }
}

/** Files and pictures the Expert attaches: each is uploaded when the message is sent, and the message then names it. */
export class StudioAttachments extends AttachmentSource {
  constructor(request) { super(); this.request = request; }
  get limit() { return 8; }
  accepts(mediaType) { return isImage(mediaType); }

  prepareAll(files) { return Promise.all(files.map(file => this.upload(file))); }

  async upload(file) {
    const ready = isImage(file.type) ? await BrowserImageAttachments.compress(file) : file;
    // The file is the request body, as it is; its name is the query.
    const { asset_id, kind } = await this.request(`${ROOT}/assets?name=${encodeURIComponent(ready.name)}`, { method: "POST", headers: { "content-type": ready.type || "application/octet-stream" }, body: ready });
    return { attachment_id: asset_id, asset_id, type: kind, display_name: ready.name, media_type: ready.type, source_bytes: ready.size };
  }
}

/** The Assistant's unacknowledged messages, in the tab's session storage. */
export class SessionPendingStore extends SharedSessionPendingStore {
  constructor(storage = () => globalThis.sessionStorage, key = "hatch.studio.assistant.pending") { super(storage, key); }
}

