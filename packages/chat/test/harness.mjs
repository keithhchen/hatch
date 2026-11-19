import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";
import { ConversationController } from "../src/application/conversation-controller.js";

// In-memory doubles for the automated tests only: a Runtime whose conversation log is an array, and its socket.

export const flush = () => new Promise(resolve => setImmediate(resolve));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The wire a session speaks: hello declares the position it resumes from, the server answers session.ready and then the log after it. */
export class LogConnection extends RuntimeConnection {
  constructor(transport, handlers) {
    super();
    Object.assign(this, { transport, handlers, sent: [], open: true, after: null });
    if (transport.autoOpen) queueMicrotask(() => handlers.onOpen());
  }
  hello(localTools, after) {
    this.sent.push({ type: "client.hello", localTools, after });
    this.after = after;
    if (this.transport.autoReady) this.serve();
  }
  /** The server's side of a hello: session.ready, then every event after the position the client asked from. */
  serve() {
    this.emit({ type: "session.ready", conversation_id: this.transport.conversationId });
    for (const event of this.transport.events) if (event.position > (this.after ?? this.transport.position)) this.emit({ type: "log.event", event });
  }
  send(message) { this.sent.push({ type: "client.message", ...message }); }
  toolResult(runId, toolCallId, result) { this.sent.push({ type: "tool_call.result", runId, toolCallId, ...result }); }
  cancel(runId) { this.sent.push({ type: "turn.cancel", runId }); }
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
  get messages() { return this.sent.filter(frame => frame.type === "client.message"); }
}

export class LogTransport extends ConversationTransport {
  constructor({ steerable = false, autoOpen = false, autoReady = false, adoptsForeignRuns = false, retriesRun = false, conversationId = "conv" } = {}) {
    super();
    Object.assign(this, { mode: { steerable, adoptsForeignRuns, retriesRun }, autoOpen, autoReady, conversationId, events: [], position: 0, connections: [], reads: [], retries: [] });
  }
  get steerable() { return this.mode.steerable; }
  get requestsOutliveStream() { return false; }
  get adoptsForeignRuns() { return this.mode.adoptsForeignRuns; }
  get retriesRun() { return this.mode.retriesRun; }
  list() { return Promise.resolve({ conversations: [{ id: this.conversationId }] }); }
  retryRun(_id, key) { this.retries.push(key); return Promise.resolve({ run_id: "run_retry" }); }

  /** Events as the server writes them: one position each, rising. Returns them. */
  push(...specs) {
    const events = specs.map(([type, fields]) => ({ position: ++this.position, type, at: "2026-01-01T00:00:00Z", ...fields }));
    this.events.push(...events);
    return events;
  }
  /** Written and told to every open session. */
  stream(...specs) {
    const events = this.push(...specs);
    for (const connection of this.connections) if (connection.open) for (const event of events) connection.emit({ type: "log.event", event });
    return events;
  }
  /** Rows the server writes that no client renders: the position advances over a gap. */
  skip(count = 1) { this.position += count; }

  log(_id, options) {
    this.reads.push(options);
    if (this.readError) return Promise.reject(this.readError);
    if (options.turns) {
      const before = options.before ?? Infinity;
      const runs = [...new Set(this.events.filter(event => event.position < before && event.run_id).map(event => event.run_id))];
      const kept = new Set(runs.slice(-options.turns));
      const events = this.events.filter(event => event.position < before && (!event.run_id || kept.has(event.run_id)));
      return Promise.resolve({ events, head: this.position, start: events[0]?.position ?? 0, has_more_before: kept.size < runs.length });
    }
    const after = options.after ?? 0;
    const later = this.events.filter(event => event.position > after);
    const events = later.slice(0, options.limit ?? later.length);
    return Promise.resolve({ events, head: this.position, has_more: events.length < later.length });
  }

  connect(_id, handlers) { const connection = new LogConnection(this, handlers); this.connections.push(connection); return connection; }
  get connection() { return this.connections.at(-1); }
}

export class NoAttachments extends AttachmentSource {
  accepts() { return false; }
  prepareAll() { return Promise.resolve([]); }
}

export class RefusingTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "local_tool_unavailable" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false, error: { code: "approval_unavailable" } }); }
}

export const user = (id, run, content = id) => ["user.message", { id, run_id: run, content }];
export const queued = (id, run, content = id) => ["message.queued", { id, run_id: run, content }];
export const runState = (run, status, fields = {}) => ["run.state", { run_id: run, status, ...fields }];
export const text = (run, content) => ["assistant.text", { run_id: run, content }];
export const tool = (run, id, status, fields = {}) => ["tool.call", { run_id: run, tool_call_id: id, name: "box.bash", status, locality: "server", ...fields }];
export const ready = conversationId => ({ type: "session.ready", conversation_id: conversationId });

/** A controller over a LogTransport, opened and settled; `controller.options` can be overridden. */
export async function openController({ transport = new LogTransport(), tools = new RefusingTools(), id = "conv", ...options } = {}) {
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools, describeError: error => `text:${error.code}`, pollMs: 60_000, ...options });
  controller.open(id);
  await flush();
  return { transport, controller, connection: transport.connection };
}

/** The session the controller opened, brought up: socket open, session.ready, and the server's replay. */
export const bringUp = async connection => { connection.handlers.onOpen(); connection.serve(); await flush(); };

export const rows = controller => controller.getState().messages.map(message => message.role === "user"
  ? `user:${message.content}${message.state ? `(${message.state})` : ""}`
  : `assistant:${message.timeline?.filter(entry => entry.kind === "text").map(entry => entry.content).join("") ?? ""}${message.transient ? "*" : ""}`);

export const say = async (controller, content) => { controller.setDraft(content); await controller.send(); await flush(); };
