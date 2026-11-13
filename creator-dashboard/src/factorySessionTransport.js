import { AttachmentSource, ConversationTransport, DraftStore, RuntimeConnection } from "@hatch/chat";
import { toolResultText } from "./factoryMessages.js";

/**
 * A Studio workbench session (one Agent's build chat) as a Conversation of the shared chat: the session's saved messages are the
 * snapshot, its event stream is the live feed, and a send is the session's message request. One Run at a time, so the composer
 * waits for a reply to end (or the Expert stops it).
 */
const textOf = content => typeof content === "string" ? content : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("");

/** The session's messages, as the shared chat reads them: each user message opens a Run, and its replies and tool results follow. */
export function messagesOf(session, activityOf, runIdOf = index => `run_u${index}`) {
  const raw = session.messages ?? [];
  const results = new Map(raw.filter(message => message.role === "toolResult" && message.toolCallId).map(message => [message.toolCallId, message]));
  const out = [];
  let runId = "run_u0";
  raw.forEach((message, index) => {
    if (message.role === "user") {
      runId = runIdOf(index);
      const content = textOf(message.content);
      if (content) out.push({ id: `u${index}`, role: "user", content, run_id: runId, timestamp: message.timestamp });
    } else if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: textOf(message.content) }];
      let content = "";
      const parts = [];
      const tool_calls = [];
      blocks.forEach((block, position) => {
        if (block.type === "text" && block.text) { parts.push({ type: "text", start: content.length, end: content.length + block.text.length }); content += block.text; }
        else if (block.type === "thinking") { const thought = block.thinking ?? block.text ?? ""; if (thought.trim()) parts.push({ type: "thinking", contentIndex: position, content: thought }); }
        else if (block.type === "toolCall") {
          const result = results.get(block.id);
          parts.push({ type: "tool_call", tool_call_id: block.id });
          tool_calls.push({
            tool_call_id: block.id, run_id: runId, name: block.name, arguments: block.arguments ?? {}, activity_message: activityOf(block.name), locality: "server",
            status: result ? (result.isError ? "failed" : "completed") : "requested",
            ...(result ? (result.isError ? { error: { code: "tool_failed", message: toolResultText(result) } } : { result: toolResultText(result) }) : {})
          });
        }
      });
      if (content || parts.length) out.push({ id: `a${index}`, role: "assistant", content, run_id: runId, timestamp: message.timestamp, parts, tool_calls });
    }
  });
  return out;
}

export class FactorySessionTransport extends ConversationTransport {
  /** @param {(path: string, init?: object) => Promise<any>} request @param {{root: string, id: string, activityOf: (name: string) => string, stream?: (url: string) => EventSource}} options */
  constructor(request, { root, id, activityOf, stream = url => new EventSource(url) }) {
    super();
    Object.assign(this, { request, base: `${root}/sessions/${id}`, activityOf, openStream: stream, session: null, listeners: new Set(), runId: null, users: 0, reading: null });
  }

  get steerable() { return false; }
  get journal() { return false; }
  get retriesRun() { return false; }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSession = () => this.session;

  /** The session as the workbench shows it beside the chat (files, todos, status); read on every snapshot and when they change. */
  async reload() {
    this.session = await this.request(this.base);
    for (const listener of this.listeners) listener();
    return this.session;
  }

  /** What the page sends is the Run's id for as long as the session still holds that message's turn. */
  bind(runId) { this.runId = runId; this.runUsers = this.users + 1; }

  async snapshot() {
    const session = await this.reload();
    const users = (session.messages ?? []).filter(message => message.role === "user").length;
    this.users = users;
    let seen = 0;
    const messages = messagesOf(session, this.activityOf, index => {
      seen += 1;
      return this.runId && this.runUsers === seen && seen === users ? this.runId : `run_u${index}`;
    });
    const last = messages.findLast(message => message.role === "user");
    // A message sent and not yet saved still names the Run; otherwise the Run is the last message's.
    if (!(this.runId && this.runUsers >= users)) this.runId = last?.run_id ?? null;
    const running = session.status === "running" && this.runId;
    const failed = session.status === "failed" && this.runId;
    return {
      conversation: { id: session.id }, messages, events: [], cursor: 0, has_more: false,
      runs: running ? [{ id: this.runId, status: "running" }] : failed ? [{ id: this.runId, status: "failed", failure: { code: session.errorCode ?? "run_failed", message: session.error } }] : []
    };
  }

  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: this.session?.status === "running" ? "running" : "completed" }); }
  toolDetail() { return Promise.reject(new Error("unavailable")); }
  connect(conversationId, handlers) { return new FactoryConnection(this, conversationId, handlers); }
}

/** The session's event stream: the live feed of one Run, as the Runtime's wire events the shared reducer already understands. */
export class FactoryConnection extends RuntimeConnection {
  constructor(transport, conversationId, { onOpen, onEvent, onClose }) {
    super();
    Object.assign(this, { transport, conversationId, onEvent, opened: false, closed: false, thought: null, thoughts: 0, calls: [], sequence: 0 });
    this.source = transport.openStream(`${transport.base}/events`);
    this.source.onopen = () => { this.opened = true; onOpen(); };
    this.source.onmessage = message => { for (const event of this.wire(JSON.parse(message.data))) onEvent(event); };
    this.source.onerror = () => { if (this.closed) return; this.close(); onClose(); };
  }

  /** What one workbench event says, as wire events of the current Run. */
  wire(event) {
    const run = this.transport.runId ? { run_id: this.transport.runId } : {};
    const closing = () => {
      if (this.thought === null) return [];
      const index = this.thought; this.thought = null;
      return [{ type: "assistant.delta", ...run, delta: { kind: "thinking_end", contentIndex: index, content: "" } }];
    };
    switch (event.type) {
      case "delta": return [...closing(), { type: "assistant.delta", ...run, delta: { kind: "text", content: event.text } }];
      case "thinking": return [...closing(), { type: "assistant.delta", ...run, delta: { kind: "thinking_start", contentIndex: this.thought = ++this.thoughts } }];
      case "tool": {
        const id = `live-${++this.sequence}`;
        this.calls.push({ id, name: event.name });
        return [...closing(), { type: "tool_call.delta", ...run, tool_call_id: id, name: event.name, activity_message: this.transport.activityOf(event.name), locality: "server", status: "requested" }];
      }
      case "tool_end": {
        const index = this.calls.findIndex(call => call.name === event.name);
        const [call] = index < 0 ? [{ id: `live-${++this.sequence}`, name: event.name }] : this.calls.splice(index, 1);
        return [{ type: "tool_call.delta", ...run, tool_call_id: call.id, name: call.name, activity_message: this.transport.activityOf(call.name), locality: "server", status: event.isError ? "failed" : "completed" }];
      }
      case "message_end": this.calls = []; return [...closing(), { type: "conversation.changed", committed: "assistant" }];
      case "message": return [{ type: "conversation.changed", committed: "user" }];
      case "state": return [{ type: "conversation.changed", committed: "claimed" }];
      case "compacting": return [{ type: "conversation.compaction", active: true }];
      case "compacted": case "compaction_degraded": return [{ type: "conversation.compaction", active: false }];
      case "files": case "todos": void this.transport.reload().catch(() => undefined); return [];
      case "error": return [{ type: "turn.failed", ...run, error: { code: "run_failed", message: event.message } }];
      case "run_end": {
        const ended = event.status === "completed"
          ? [{ type: "turn.completed", ...run, finish_reason: "completed" }]
          : event.status === "interrupted" || event.status === "cancelled"
            ? [{ type: "turn.failed", ...run, error: { code: "run_cancelled", message: "The reply was stopped." } }]
            : [{ type: "turn.failed", ...run, error: event.error ?? { code: "run_failed", message: "The reply failed." } }];
        return [...closing(), { type: "conversation.compaction", active: false }, ...ended];
      }
      default: return [];
    }
  }

  hello() { this.onEvent({ type: "session.ready", conversation_id: this.conversationId }); }

  async send({ runId, clientMessageId, content = "" }) {
    this.transport.bind(runId);
    await this.transport.request(`${this.transport.base}/message`, { method: "POST", headers: { "Idempotency-Key": clientMessageId }, body: JSON.stringify({ content }) });
    this.onEvent({ type: "message.accepted", conversation_id: this.conversationId, run_id: runId, client_message_id: clientMessageId, outcome: "started" });
  }

  toolResult() {}
  cancel() { this.transport.request(`${this.transport.base}/stop`, { method: "POST", body: "{}" }).catch(() => undefined); }
  get ready() { return this.opened && !this.closed; }

  close() {
    this.closed = true;
    this.source.onopen = this.source.onmessage = this.source.onerror = null;
    this.source.close();
  }
}

/** The workbench chat takes words only: files go in through the workbench's own upload. */
export class NoAttachments extends AttachmentSource {
  get limit() { return 0; }
  accepts() { return false; }
  prepareAll() { return Promise.resolve([]); }
}

/** The unsent draft, kept in the tab's session storage per session. */
export class SessionDraftStore extends DraftStore {
  constructor(key, storage = () => globalThis.sessionStorage) { super(); this.key = key; this.storage = storage; }
  read() { try { return { text: this.storage()?.getItem(this.key) ?? "", files: [] }; } catch { return { text: "", files: [] }; } }
  write(_scope, draft) { try { this.storage()?.setItem(this.key, draft.text); } catch { /* storage unavailable: the draft lives for this page only */ } }
}
