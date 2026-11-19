import { AttachmentSource, ConversationTransport, DraftStore, RuntimeConnection } from "@hatch/chat";
import { toolResultText } from "./factoryMessages.js";

/**
 * A Studio workbench session (one Agent's build chat) as a Conversation of the shared chat. The session has no event log of
 * its own: its saved messages are turned into the public events of the log (position = the order they come in), and its
 * event stream continues the same numbering, so the one fold renders it like any conversation. One Run at a time, so the
 * composer waits for a reply to end (or the Expert stops it).
 */
const textOf = content => typeof content === "string" ? content : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("");
const isoOf = timestamp => { const date = new Date(timestamp); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); };

/**
 * The session's messages as public log events, in order: each user message opens a Run, and its replies and tool results follow.
 * A Run that is going has no end; a failed one says why. `partial` is what the running reply has said so far.
 */
export function eventsOf(session, activityOf, runIdOf = index => `run_u${index}`) {
  const raw = session.messages ?? [];
  const results = new Map(raw.filter(message => message.role === "toolResult" && message.toolCallId).map(message => [message.toolCallId, message]));
  const events = [];
  const push = (type, fields, at) => events.push({ position: events.length + 1, type, ...(at ? { at } : {}), ...fields });
  let runId = null;
  const end = (status, fields = {}) => { if (runId) push("run.state", { run_id: runId, status, ...fields }); };
  raw.forEach((message, index) => {
    const at = isoOf(message.timestamp);
    if (message.role === "user") {
      end("completed");
      runId = runIdOf(index);
      const content = textOf(message.content);
      if (content) push("user.message", { id: `u${index}`, run_id: runId, content }, at);
    } else if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: textOf(message.content) }];
      blocks.forEach((block, position) => {
        if (block.type === "text" && block.text) push("assistant.text", { run_id: runId, content: block.text }, at);
        else if (block.type === "thinking") { const thought = block.thinking ?? block.text ?? ""; if (thought.trim()) push("assistant.thinking", { run_id: runId, index: position, phase: "end", content: thought }, at); }
        else if (block.type === "toolCall") {
          const result = results.get(block.id);
          push("tool.call", {
            run_id: runId, tool_call_id: block.id, name: block.name, arguments: block.arguments ?? {}, activity_message: activityOf(block.name), locality: "server",
            status: result ? (result.isError ? "failed" : "completed") : "requested",
            ...(result ? (result.isError ? { error: { code: "tool_failed", message: toolResultText(result) } } : { result: toolResultText(result) }) : {})
          }, at);
        }
      });
    }
  });
  const partial = typeof session.partial === "string" ? session.partial : "";
  if (session.status === "running") {
    if (runId) push("run.state", { run_id: runId, status: "running" });
    if (runId && partial) push("assistant.text", { run_id: runId, content: partial });
  } else if (session.status === "failed") end("failed", { failure: { code: session.errorCode ?? "run_failed", message: session.error } });
  else end("completed");
  return events;
}

export class FactorySessionTransport extends ConversationTransport {
  /** @param {(path: string, init?: object) => Promise<any>} request @param {{root: string, id: string, activityOf: (name: string) => string, stream?: (url: string) => EventSource}} options */
  constructor(request, { root, id, activityOf, stream = url => new EventSource(url) }) {
    super();
    Object.assign(this, { request, base: `${root}/sessions/${id}`, activityOf, openStream: stream, session: null, listeners: new Set(), runId: null, users: 0, runUsers: 0, position: 0, helloed: false, sending: null });
  }

  get steerable() { return false; }
  get retriesRun() { return false; }

  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSession = () => this.session;

  /** The session as the workbench shows it beside the chat (files, todos, status); read on every first page and when they change. */
  async reload() {
    // Only the messages after the ones the page holds come down; the server sends them all when its copy no longer matches.
    const known = this.session?.messages ?? [];
    const tail = known.at(-1)?.timestamp;
    const read = await this.request(tail === undefined ? this.base : `${this.base}?after=${known.length}&tail=${encodeURIComponent(tail)}`);
    this.session = { ...read, messages: [...known.slice(0, read.messagesFrom ?? 0), ...(read.messages ?? [])] };
    for (const listener of this.listeners) listener();
    return this.session;
  }

  /** What the page sends is the Run's id for as long as the session still holds that message's turn. */
  bind(runId, clientMessageId, content) { this.runId = runId; this.runUsers = this.users + 1; this.sending = { clientMessageId, content, runId }; }

  /**
   * The whole session as the log: the session keeps no older turns apart, and its stream is not a log to resume, so a read
   * after a position brings nothing (the stream says what is new, and a session that was lost is read whole again).
   */
  async log(_conversationId, { after } = {}) {
    if (after != null) return { events: [], head: this.position, has_more: false };
    const session = await this.reload();
    const users = (session.messages ?? []).filter(message => message.role === "user").length;
    this.users = users;
    let seen = 0;
    const events = eventsOf(session, this.activityOf, index => {
      seen += 1;
      return this.runId && this.runUsers === seen && seen === users ? this.runId : `run_u${index}`;
    });
    // A message sent and not yet saved still names the Run; otherwise the Run is the last message's.
    if (!(this.runId && this.runUsers >= users)) this.runId = events.findLast(event => event.type === "user.message")?.run_id ?? null;
    this.position = events.length;
    this.helloed = false;
    return { events, head: this.position, start: events[0]?.position ?? 0, has_more_before: false };
  }

  toolDetail() { return Promise.reject(new Error("unavailable")); }
  connect(conversationId, handlers) { return new FactoryConnection(this, conversationId, handlers); }
}

/** The session's event stream: the live feed of one Run, as events of the log, numbered on from where the page's read ended. */
export class FactoryConnection extends RuntimeConnection {
  constructor(transport, conversationId, { onOpen, onEvent, onClose }) {
    super();
    Object.assign(this, { transport, conversationId, onEvent, opened: false, closed: false, thought: null, thoughts: 0, calls: [], sequence: 0, over: false, running: false, compaction: null, compactions: 0 });
    this.source = transport.openStream(`${transport.base}/events`);
    this.source.onopen = () => { this.opened = true; onOpen(); };
    this.source.onmessage = message => { for (const event of this.wire(JSON.parse(message.data))) this.deliver(event); };
    this.source.onerror = () => { if (this.closed) return; this.close(); onClose(); };
  }

  /** Public events (without a position) become frames; a control frame goes as it is. */
  deliver(event) {
    if (event.type === "log.reset") { this.onEvent(event); return; }
    this.onEvent({ type: "log.event", event: { position: ++this.transport.position, at: new Date().toISOString(), ...event } });
  }

  /** What one workbench event says, as public events of the current Run. */
  wire(event) {
    const runId = this.transport.runId;
    const run = { run_id: runId };
    const closing = () => {
      if (this.thought === null) return [];
      const index = this.thought; this.thought = null;
      return [{ type: "assistant.thinking", ...run, index, phase: "end", content: "" }];
    };
    // A Run is going from its first word, step or saved message: the log says so once.
    const starting = () => this.running ? [] : (this.running = true, [{ type: "run.state", ...run, status: "running" }]);
    const endCompaction = degraded => {
      if (!this.compaction) return [];
      const id = this.compaction; this.compaction = null;
      return [{ type: "compaction.ended", ...run, compaction_id: id, ...(degraded ? { degraded: true } : {}) }];
    };
    // A Run ends once: its failure is told by `error` and by `run_end`, and the page hears whichever comes first.
    const ending = events => this.over ? [] : (this.over = true, this.running = false, events);
    if (["delta", "thinking", "tool", "tool_end"].includes(event.type)) this.over = false;
    switch (event.type) {
      case "delta": return [...starting(), ...closing(), { type: "assistant.text", ...run, content: event.text }];
      case "thinking": return [...starting(), ...closing(), { type: "assistant.thinking", ...run, index: this.thought = ++this.thoughts, phase: "start" }];
      case "tool": {
        const id = `live-${++this.sequence}`;
        this.calls.push({ id, name: event.name });
        return [...starting(), ...closing(), { type: "tool.call", ...run, tool_call_id: id, name: event.name, activity_message: this.transport.activityOf(event.name), locality: "server", status: "requested" }];
      }
      case "tool_end": {
        const index = this.calls.findIndex(call => call.name === event.name);
        const [call] = index < 0 ? [{ id: `live-${++this.sequence}`, name: event.name }] : this.calls.splice(index, 1);
        return [{ type: "tool.call", ...run, tool_call_id: call.id, name: call.name, activity_message: this.transport.activityOf(event.name), locality: "server", status: event.isError ? "failed" : "completed" }];
      }
      case "message_end": this.calls = []; void this.transport.reload().catch(() => undefined); return closing();
      case "message": {
        void this.transport.reload().catch(() => undefined);
        const sending = this.transport.sending;
        // The message this page sent is the log's now (once); any other is read with the session again.
        if (!sending || sending.told) return [{ type: "log.reset" }];
        sending.told = true;
        return [...starting(), { type: "user.message", id: sending.clientMessageId, run_id: sending.runId, content: sending.content }];
      }
      case "state": void this.transport.reload().catch(() => undefined); return [];
      case "compacting": return [{ type: "compaction.started", ...run, compaction_id: this.compaction = `c${++this.compactions}` }];
      case "compacted": case "compaction_degraded": return endCompaction(event.type === "compaction_degraded");
      case "files": case "todos": void this.transport.reload().catch(() => undefined); return [];
      case "error": return ending([{ type: "run.state", ...run, status: "failed", failure: { code: "run_failed", message: event.message } }]);
      case "run_end": {
        // A Run a restart interrupted (or one the user stopped) ends with that status and no failure: the page shows none.
        const ended = event.status === "completed" || event.status === "interrupted" || event.status === "cancelled"
          ? [{ type: "run.state", ...run, status: event.status }]
          : [{ type: "run.state", ...run, status: "failed", failure: event.error ?? { code: "run_failed", message: "The reply failed." } }];
        return [...closing(), ...endCompaction(), ...ending(ended)];
      }
      default: return [];
    }
  }

  /** The stream is not a log to resume: a session that comes back after a gap reads the session whole again. */
  hello(_localTools, _after) {
    this.onEvent({ type: "session.ready", conversation_id: this.conversationId });
    if (this.transport.helloed) this.onEvent({ type: "log.reset" });
    this.transport.helloed = true;
  }

  async send({ runId, clientMessageId, content = "" }) {
    this.transport.bind(runId, clientMessageId, content);
    this.over = false;
    await this.transport.request(`${this.transport.base}/message`, { method: "POST", headers: { "Idempotency-Key": clientMessageId }, body: JSON.stringify({ content, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
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
