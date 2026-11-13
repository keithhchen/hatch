import { AttachmentSource, ConversationTransport, PendingStore, RuntimeConnection } from "@hatch/chat";
import { BrowserImageAttachments } from "./webChatClient.js";

/** The conversation API, the same one the Hatch CLI and every outside client use. */
const ROOT = "/v1/creator/assistant/conversation";
/** The Assistant is one conversation per Expert; the page names it, the server knows it by the account. */
export const ASSISTANT_CONVERSATION = "assistant";

const RUN_END_ERRORS = {
  failed: { code: "run_failed", message: "The reply failed. Send the message again." },
  cancelled: { code: "run_cancelled", message: "The reply was stopped." },
  interrupted: { code: "run_interrupted", message: "The reply was interrupted. Answer again." }
};

/** What the Assistant page's event stream says, as the Runtime's wire events the shared reducer already understands. */
export function wireEventsOf(event) {
  const run = event.run_id ? { run_id: event.run_id } : {};
  switch (event.type) {
    case "delta": return [{ type: "assistant.delta", ...run, delta: { kind: "text", content: event.text, ...(typeof event.offset === "number" ? { offset: event.offset } : {}) } }];
    case "thinking": return [{ type: "assistant.delta", ...run, delta: { kind: "thinking_start", contentIndex: event.contentIndex } }];
    case "thinking_delta": return [{ type: "assistant.delta", ...run, delta: { kind: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta } }];
    case "thinking_end": return [{ type: "assistant.delta", ...run, delta: { kind: "thinking_end", contentIndex: event.contentIndex, content: event.content } }];
    case "tool":
    case "tool_end": return [{
      type: "tool_call.delta", ...run, tool_call_id: event.id, name: event.name, activity_message: event.activity, locality: "server",
      status: event.type === "tool" ? "requested" : event.cancelled ? "cancelled" : event.isError ? "failed" : "completed"
    }];
    case "message": return [{ type: "conversation.changed", committed: "user", ...(event.message_id ? { message_id: event.message_id } : {}) }];
    case "message_end": return [{ type: "conversation.changed", committed: "assistant" }];
    // A queued message was taken up, a Run changed stage, or something no Run shows changed (a chat was linked).
    case "state": return [{ type: "conversation.changed", committed: "claimed" }];
    case "compacting": return [{ type: "turn.state", ...run, status: "compacting" }];
    // The history is being summarized, in a Run or after a reply: the page waits for the end.
    case "compaction_start": return [{ type: "conversation.compaction", active: true }];
    case "compaction_end": return [{ type: "conversation.compaction", active: false }];
    // Only a completed Run is a reply. A cancelled or interrupted one saved none: it ends as a failure the page need not wait on
    // (the server lets an interrupted Run be answered again, which the failed state offers).
    case "run_end": return event.status === "completed"
      ? [{ type: "turn.completed", ...run, finish_reason: event.status }]
      : [{ type: "turn.failed", ...run, error: event.error ?? RUN_END_ERRORS[event.status] ?? RUN_END_ERRORS.failed }];
    default: return [];
  }
}

const isImage = mediaType => String(mediaType ?? "").startsWith("image/");

/** A message of the conversation API, as the shared chat reads a message. The id of a reply is `<run_id>:<n>`. */
function messageOf(line) {
  const attachments = (line.attachments ?? []).map(file => ({
    attachment_id: file.asset_id ?? file.name, asset_id: file.asset_id, display_name: file.name,
    media_type: file.type === "image" ? "image/jpeg" : "application/octet-stream", ...(file.bytes ? { source_bytes: file.bytes } : {})
  }));
  return {
    id: line.id, role: line.role, content: line.text, timestamp: line.created_at,
    ...(line.role === "assistant" ? { run_id: line.id.split(":")[0] } : {}),
    ...(line.state ? { state: line.state } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(line.steps ? { parts: line.steps.parts, tool_calls: line.steps.tool_calls } : {})
  };
}

/** What a message says to the API: its text, then each file by the id the upload returned. */
const contentOf = (content, attachments) => attachments.length
  ? [...(content ? [{ type: "text", text: content }] : []), ...attachments.map(({ asset_id, type }) => ({ type, assetId: asset_id }))]
  : content;

/**
 * The Studio Assistant as a Conversation, over the conversation API: the page's view (with the journal cursor and the running
 * turn's partial text), older pages, the event stream resumed by cursor, and a send that carries the message's key as its Idempotency-Key.
 * `view` is what the page shows beside the chat (tasks, channels); it changes with every snapshot.
 */
export class StudioAssistantTransport extends ConversationTransport {
  /** @param {(path: string, init?: object) => Promise<any>} request @param {{stream?: (url: string) => EventSource, timeZone?: string}} [options] */
  constructor(request, { stream = url => new EventSource(url), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    super();
    this.request = request;
    this.openStream = stream;
    this.timeZone = timeZone;
    this.cursor = 0;
    this.view = null;
    this.listeners = new Set();
  }

  get steerable() { return true; }
  get journal() { return false; }
  get retriesRun() { return true; }

  /** Answers the Assistant again after a failed Run; the key is the Idempotency-Key, so a repeat is the same Run. */
  retryRun(_conversationId, key) {
    return this.request(`${ROOT}/retry`, { method: "POST", headers: { "idempotency-key": key }, body: "{}" });
  }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getView = () => this.view;

  /** The journal cursor this client has heard to: the snapshot's, or a later one the stream delivered. */
  advance(cursor) {
    const next = Number(cursor);
    if (Number.isSafeInteger(next) && next > this.cursor) this.cursor = next;
  }

  /** The Expert's timezone, told once per page and never by reading. A refusal is not the page's problem. */
  announceTimeZone() {
    this.timeZoneSent ??= this.request(`${ROOT}/timezone`, { method: "PUT", body: JSON.stringify({ timezone: this.timeZone }) }).catch(() => undefined);
  }

  async snapshot() {
    this.announceTimeZone();
    const view = await this.request(`${ROOT}/view`);
    this.view = view;
    this.advance(view.cursor);
    for (const listener of this.listeners) listener();
    const failed = view.status?.state === "failed" && view.status.runId;
    return {
      conversation: { id: ASSISTANT_CONVERSATION },
      messages: view.messages.map(messageOf), events: [], cursor: Number(view.cursor),
      compacting: view.status?.compacting === true, has_more: view.has_more, ...(view.before_cursor ? { before_cursor: view.before_cursor } : {}),
      // The page lists the Run in progress, or the last one when it failed; a Run it does not list has ended well.
      runs: view.status?.state === "running" ? [{ id: view.run_id, status: "running", ...(view.partial ? { partial_output: view.partial } : {}) }]
        : failed ? [{ id: view.status.runId, status: "failed", failure: view.status.error }] : []
    };
  }

  async history(_conversationId, { beforeCursor }) {
    const page = await this.request(`${ROOT}/messages?before=${encodeURIComponent(beforeCursor)}`);
    return { messages: page.messages.map(messageOf), has_more: page.has_more, ...(page.before_cursor ? { before_cursor: page.before_cursor } : {}) };
  }

  run(_conversationId, runId) {
    const failure = this.view?.status?.state === "failed" ? this.view.status.error : undefined;
    return Promise.resolve({ id: runId, status: failure ? "failed" : "completed", ...(failure ? { failure } : {}) });
  }

  assetUrl(_conversationId, assetId) { return `${ROOT}/assets/${encodeURIComponent(assetId)}`; }

  connect(conversationId, handlers) { return new StudioConnection(this, conversationId, handlers); }
}

/** One event stream, resumed from the cursor; a send is a request whose answer says whether it started the Run or joined it. */
export class StudioConnection extends RuntimeConnection {
  constructor(transport, conversationId, { onOpen, onEvent, onClose }) {
    super();
    Object.assign(this, { transport, conversationId, onEvent, opened: false, closed: false });
    this.source = transport.openStream(`${ROOT}/events?after_cursor=${transport.cursor}`);
    this.source.onopen = () => { this.opened = true; onOpen(); };
    this.source.onmessage = message => {
      transport.advance(message.lastEventId);
      for (const event of wireEventsOf(JSON.parse(message.data))) onEvent(event);
    };
    this.source.onerror = () => {
      if (this.closed) return;
      this.close();
      onClose();
    };
  }

  hello() { this.onEvent({ type: "session.ready", conversation_id: this.conversationId }); }

  async send({ runId, clientMessageId, content = "", attachments = [] }) {
    const receipt = await this.transport.request(`${ROOT}/messages`, {
      method: "POST", headers: { "idempotency-key": clientMessageId }, body: JSON.stringify({ content: contentOf(content, attachments) })
    });
    // A message that joined the running turn is queued until the turn takes it up.
    this.onEvent({ type: "message.accepted", conversation_id: this.conversationId, run_id: receipt.run_id ?? runId, client_message_id: clientMessageId, outcome: receipt.queued ? "steered" : "started" });
  }

  toolResult() {}
  /** Asks the server to stop the Run; the stream then says how it ended. */
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

/** Unacknowledged messages kept in the tab's session storage: a reload sends them again under the same key. */
export class SessionPendingStore extends PendingStore {
  constructor(storage = () => globalThis.sessionStorage, key = "hatch.studio.assistant.pending") { super(); this.storage = storage; this.key = key; }

  all() {
    try { return JSON.parse(this.storage()?.getItem(this.key) ?? "[]"); } catch { return []; }
  }

  write(records) {
    try { this.storage()?.setItem(this.key, JSON.stringify(records)); } catch { /* storage unavailable: the message is pending for this page only */ }
  }

  load(conversationId) { return this.all().filter(record => record.conversationId === conversationId); }
  save(record) { this.write([...this.all().filter(entry => entry.clientMessageId !== record.clientMessageId), record]); }
  settle(clientMessageId) { this.write(this.all().filter(entry => entry.clientMessageId !== clientMessageId)); }
}
