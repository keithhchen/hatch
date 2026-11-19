import { PendingSubmission } from "../domain/timeline.js";
import { emptyLog, foldLog, mergeOlderLog, projectLog } from "../domain/chat-log.js";
import { MemoryDraftStore, MemoryPendingStore } from "../ports/index.js";
import { ChatError } from "./errors.js";
import { OPEN_FREE_CHAT } from "../domain/free-chat.js";

const newId = prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

/** How many turns a conversation opens on, and each earlier page brings. */
export const HISTORY_TURNS = 20;
/** Events per page when the page reads what a stream did not bring. */
const TAIL_LIMIT = 200;

export const INITIAL_CHAT_STATE = Object.freeze({
  conversations: [],
  conversationCursor: null,
  conversationId: "",
  /** The conversation whose log has been read: the page is loaded once it is the open one. */
  snapshotConversationId: null,
  messages: [],
  /** Position of the oldest event held while there is more before it; null when the whole log is held. */
  historyCursor: null,
  draft: "",
  images: [],
  status: Object.freeze({ key: "loading" }),
  error: null,
  activeRun: null,
  /** The Run that ended failed and has not been answered again or dismissed: `{ id }`. */
  failedRun: null,
  runState: null,
  session: null,
  connection: "idle",
  approvals: Object.freeze({}),
  compactions: Object.freeze([]),
  /** The history is being summarized (in a Run or after a reply): the composer waits. */
  compacting: false
});

/**
 * `state.connection`: "connecting" while a live session is being opened or
 * retried, "open" once session.ready arrived, "idle" when there is no live
 * session — no Conversation, or the automatic retries ran out. Idle is not an
 * error: the next send reconnects.
 */
/** How long a lost session is retried without saying so. */
export const QUIET_OUTAGE_MS = 8000;

export const CONNECTION_STATES = Object.freeze(["idle", "connecting", "open"]);
export const APPROVAL_DECISIONS = Object.freeze(["pending", "allowed", "denied"]);

/**
 * Application service for one Agent's conversations: library, the conversation log (read in pages and followed live, one
 * fold), the live Runtime session, submission lifecycle, tool and approval requests. Observable (subscribe/getState) so any
 * view layer can render it; every external effect goes through a port. The thread is `projectLog` of the log plus the
 * messages the log does not carry yet.
 */
export class ConversationController {
  /**
   * @param {object} options
   * @param {import("../ports/index.js").ConversationTransport} options.transport
   * @param {import("../ports/index.js").AttachmentSource} options.attachments
   * @param {import("../ports/index.js").ToolExecutor} options.tools
   * @param {import("../ports/index.js").DraftStore} [options.drafts]
   * @param {import("../ports/index.js").PendingStore} [options.pendingStore] sent messages the log does not carry yet
   * @param {string} [options.draftScope]
   * @param {number} [options.ackTimeoutMs] how long a message sent over a socket waits for the server's answer before it goes back to the composer
   * @param {number} [options.stallMs] a session that says nothing for this long is dead without having closed (0: the host sends no heartbeat, so silence means nothing)
   * @param {(error: object) => string} [options.describeError] localized text sent back with tool errors
   */
  constructor({ transport, attachments, tools, drafts = new MemoryDraftStore(), draftScope = "default", describeError = error => error?.message ?? String(error), reconnectAttempts = 3, ackTimeoutMs = 20_000, stallMs = 0, pollMs = 2000, freeChat = OPEN_FREE_CHAT, pendingStore = new MemoryPendingStore() }) {
    Object.assign(this, { transport, attachments, tools, drafts, draftScope, describeError, reconnectAttempts, ackTimeoutMs, stallMs, pollMs, freeChat, pendingStore });
    const draft = drafts.read(draftScope);
    this.state = { ...INITIAL_CHAT_STATE, draft: draft.text, images: draft.files };
    this.listeners = new Set();
    this.generation = 0;
    this.attempts = 0;
    /** The conversation's log as folded so far, and what it shows. */
    this.log = emptyLog();
    this.projection = projectLog(this.log);
    /** Messages sent and the log does not carry yet, by clientMessageId. */
    this.pendings = new Map();
    /** Runs whose failure the page has already told (or the user dismissed). */
    this.reportedFailures = new Set();
    this.taskStart = null;
    this.lastFrameAt = 0;
    this.stallTimer = null;
    /** Local tool executions by tool_call_id: one call is executed once, however often the Runtime asks. */
    this.toolRuns = new Map();
    this.connection = null;
    this.link = null;
    /** When the live session was lost and has not come back; a status shows only once a send meets a session down this long. */
    this.downSince = null;
    this.reading = Promise.resolve();
    this.reconnectTimer = null;
    this.lapseTimer = null;
    this.pollTimer = null;
    this.pollKey = null;
  }

  subscribe = listener => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  /** Whether the composer takes a message while a Run is active. */
  get steerable() { return this.transport.steerable; }

  get snapshotPending() {
    return Boolean(this.state.conversationId && this.state.snapshotConversationId !== this.state.conversationId);
  }

  setState(patch) {
    this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
    this.syncPolling();
    for (const listener of this.listeners) listener();
  }

  fail = cause => this.setState({ error: cause });

  /** A background read that failed: shown, and taken back by the next read that succeeds. */
  failRead = cause => { this.readFailure = cause; this.fail(cause); };

  // Library ---------------------------------------------------------------

  async loadLibrary() {
    const page = await this.transport.list(null);
    const conversations = page.conversations ?? [];
    this.freeChat.sync(page.sent_message_count);
    this.setState({
      conversations,
      conversationCursor: page.next_cursor ?? null,
      ...(this.state.conversationId ? {} : { status: { key: conversations.length ? "loadingConversation" : "startChatToBegin" } })
    });
  }

  async loadMoreConversations() {
    const cursor = this.state.conversationCursor;
    if (!cursor) return;
    const page = await this.transport.list(cursor);
    this.setState(state => ({
      conversations: [...state.conversations, ...(page.conversations ?? []).filter(entry => !state.conversations.some(existing => existing.id === entry.id))],
      conversationCursor: page.next_cursor ?? null
    }));
  }

  /** Create a Conversation; with brief answers the first turn starts on connect. */
  async createConversation(briefAnswers) {
    this.setState({ error: null });
    const { conversation } = await this.transport.create({ briefAnswers });
    this.setState(state => ({ conversations: [conversation, ...state.conversations] }));
    if (briefAnswers) this.taskStart = conversation.id;
    return conversation;
  }

  // Conversation lifecycle -------------------------------------------------

  open(conversationId, { force = false } = {}) {
    const id = conversationId ?? "";
    if (!force && id === this.state.conversationId) return;
    this.closeConnection();
    const generation = ++this.generation;
    this.attempts = 0;
    for (const submission of this.pendings.values()) clearTimeout(submission.ackTimer);
    this.pendings.clear();
    this.reportedFailures.clear();
    this.toolRuns.clear();
    this.downSince = null;
    this.reading = Promise.resolve();
    this.log = emptyLog();
    this.projection = projectLog(this.log);
    clearTimeout(this.lapseTimer);
    this.setState({ conversationId: id, historyCursor: null, snapshotConversationId: null, messages: [], activeRun: null, failedRun: null, runState: null, session: null, connection: "idle", error: null, compacting: false, compactions: [], ...(id ? { status: { key: "loadingConversation" } } : {}) });
    if (!id) return;
    void this.load(id, generation).catch(cause => {
      if (generation === this.generation) this.fail(cause);
    });
  }

  /** The latest turns of the log, then the live session from where they end. */
  async load(id, generation) {
    const page = await this.transport.log(id, { turns: HISTORY_TURNS });
    if (generation !== this.generation) return;
    this.log = this.fold(emptyLog(), page.events, page.head);
    this.setState({ snapshotConversationId: id, historyCursor: page.has_more_before ? page.start ?? null : null });
    this.render();
    this.resumePending(id);
    this.connect();
  }

  /** Events into a log, in order; a read that is whole (no more to come) also says how far the log goes, internal rows included. */
  fold(log, events, head) {
    const next = events.reduce(foldLog, log);
    return Number.isFinite(head) && head > next.position ? { ...next, position: head } : next;
  }

  /** What the log holds that this page has not read, read in pages and folded: a stream that was down, or a transport without one. One read at a time. */
  refresh(id = this.state.conversationId) {
    const generation = this.generation;
    const read = async () => {
      for (;;) {
        if (generation !== this.generation || this.state.conversationId !== id) return;
        const after = this.log.position;
        const page = await this.transport.log(id, { after, limit: TAIL_LIMIT });
        if (generation !== this.generation) return;
        this.apply(page.events, page.has_more ? undefined : page.head);
        if (!page.has_more || this.log.position === after) break;
      }
      if (this.readFailure && this.state.error === this.readFailure) this.setState({ error: null });
      this.readFailure = null;
    };
    const task = this.reading.then(read);
    this.reading = task.catch(() => {});
    return task;
  }

  /** Fold events into the page's log and show the result. An event the log already holds changes nothing. */
  apply(events, head) {
    const before = this.log;
    this.log = this.fold(before, events, head);
    if (this.log !== before) this.render();
  }

  /** The thread: the log, then what was sent and the log does not carry yet. Also what follows from it: failure, lock, status. */
  render() {
    const conversationId = this.state.conversationId;
    const projection = this.projection = projectLog(this.log);
    this.settlePending(projection);
    const pending = [...this.pendings.values()].filter(submission => submission.conversationId === conversationId && !submission.hidden);
    const leading = pending.find(submission => submission.leadsRun && !projection.activeRun);
    const messages = [...projection.messages];
    for (const submission of pending) messages.push(this.rowOf(submission));
    if (leading) messages.push(this.typingRowOf(leading));
    const activeRun = projection.activeRun ?? leading?.runId ?? null;
    const failure = projection.failed && !this.reportedFailures.has(projection.failed.runId) ? projection.failed : null;
    if (failure) this.reportedFailures.add(failure.runId);
    this.setState(state => ({
      messages, activeRun, runState: projection.runState, compacting: projection.compacting,
      compactions: projection.compactions.map(entry => ({ ...entry, conversationId })),
      status: this.statusOf(state, projection, activeRun, leading),
      ...(failure ? { failedRun: { id: failure.runId }, error: failure.failure ?? new ChatError("replyFailed") } : {})
    }));
    // An interrupted Run the server is answering again counts as working until its time lapses; the page shows the lapse when it comes.
    clearTimeout(this.lapseTimer);
    this.lapseTimer = undefined;
    if (projection.retryingUntil) {
      this.lapseTimer = setTimeout(() => { if (this.state.conversationId === conversationId) this.render(); }, Math.max(0, projection.retryingUntil - Date.now()) + 5);
      this.lapseTimer.unref?.();
    }
  }

  statusOf(state, projection, activeRun, leading) {
    const key = state.status.key;
    if (!state.snapshotConversationId || state.snapshotConversationId !== state.conversationId) return state.status;
    if (key === "reconnecting" && state.connection !== "open") return state.status;
    if (key === "stopping" && projection.activeRun) return state.status;
    const next = activeRun ? (leading ? "sending" : "agentReplying") : "connected";
    return key === next ? state.status : { key: next };
  }

  rowOf(submission) {
    const state = submission.queued ? "queued" : "sending";
    if (submission.row?.state !== state) submission.row = { ...submission.optimisticMessage(), state };
    return submission.row;
  }

  typingRowOf(submission) {
    submission.typing ??= { id: `${submission.runId}-assistant`, renderKey: `${submission.runId}-assistant`, run_id: submission.runId, role: "assistant", content: "", timestamp: new Date().toISOString(), transient: true, timeline: [] };
    return submission.typing;
  }

  /** The log is the authority: a message it holds is taken up or queued, and no longer pending. A Run that ended before the server took its message sends the words back. */
  settlePending(projection) {
    for (const [id, submission] of [...this.pendings]) {
      if (projection.known.has(id)) {
        clearTimeout(submission.ackTimer);
        this.pendings.delete(id);
        this.pendingStore.settle(id);
        if (submission.awaitingUser) this.writeDraft({ draft: "", images: [] });
      } else if (!this.transport.steerable && !submission.accepted && isEnded(this.log.runs[submission.runId]?.status)) {
        this.restoreSubmission(submission);
      }
    }
  }

  /** After a reload: what the log does not carry is sent again, under the same key. */
  resumePending(conversationId) {
    for (const record of this.pendingStore.load(conversationId)) {
      if (record.kind === "retry" || this.pendings.has(record.clientMessageId)) continue;
      if (this.projection.known.has(record.clientMessageId)) { this.pendingStore.settle(record.clientMessageId); continue; }
      const submission = PendingSubmission.fromRecord(record, { runId: this.projection.activeRun ?? newId("run") });
      submission.leadsRun = !this.projection.activeRun;
      this.pendings.set(submission.clientMessageId, submission);
    }
    this.render();
  }

  /** Whether the failed reply can be answered again here. */
  get canRetryRun() { return this.transport.retriesRun; }

  /**
   * Answer the failed reply again: a new Run over the same conversation. The key is minted at the click and kept until the
   * server answers, so an ambiguous failure and a click again are one Run.
   */
  async retryRun() {
    const conversationId = this.state.conversationId;
    if (!conversationId || !this.state.failedRun || !this.canRetryRun) return;
    const kept = this.pendingStore.load(conversationId).find(record => record.kind === "retry");
    const record = kept ?? { conversationId, clientMessageId: newId("retry"), kind: "retry" };
    if (!kept) this.pendingStore.save(record);
    this.setState({ error: null });
    try {
      await this.transport.retryRun(conversationId, record.clientMessageId);
      this.pendingStore.settle(record.clientMessageId);
      if (this.state.conversationId !== conversationId) return;
      this.setState({ failedRun: null, status: { key: "sending" } });
      await this.refresh(conversationId);
    } catch (cause) {
      // A refusal is the server's answer: the key is spent. Anything else may have reached it, so the key stays.
      if (Number.isInteger(cause?.status) && cause.status >= 400 && cause.status < 500) this.pendingStore.settle(record.clientMessageId);
      this.fail(cause);
    }
  }

  /** Retry whatever failed in the connection: the first read, or the live session. */
  retry() {
    this.setState({ error: null });
    if (this.snapshotPending) this.open(this.state.conversationId, { force: true });
    else this.reconnect();
  }

  dismissError() {
    this.setState({ error: null, failedRun: null });
  }

  /** The turns before the ones held. */
  async loadHistory() {
    const { conversationId, historyCursor } = this.state;
    if (!historyCursor) return;
    const generation = this.generation;
    const page = await this.transport.log(conversationId, { turns: HISTORY_TURNS, before: historyCursor });
    if (generation !== this.generation) return;
    if (page.has_more_before && !(page.start < historyCursor)) throw new ChatError("historyIdentityMismatch");
    this.log = mergeOlderLog(this.log, this.fold(emptyLog(), page.events));
    this.setState({ historyCursor: page.has_more_before ? page.start : null });
    this.render();
  }

  dispose() {
    clearTimeout(this.lapseTimer);
    this.generation += 1;
    this.closeConnection();
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollKey = null;
    this.listeners.clear();
  }

  // Live session -----------------------------------------------------------

  connect() {
    const conversationId = this.state.conversationId;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const link = { live: true };
    const connection = this.transport.connect(conversationId, {
      // The session resumes the log where this page's fold ends: what it missed while it was down comes first, then what is new.
      onOpen: () => connection.hello(this.tools.localTools, this.log.position),
      onEvent: event => void this.handleEvent(event, connection, link, conversationId).catch(cause => { if (link.live) this.fail(cause); }),
      onClose: () => this.handleClose(connection, link, conversationId)
    });
    this.connection = connection;
    this.link = link;
    this.watch(connection, link, conversationId);
    this.setState({ connection: "connecting" });
  }

  /** The network or the tab came back: a session that is down is retried now, not after its backoff; one that went quiet is judged now. */
  nudge() {
    const id = this.state.conversationId;
    if (!id || this.snapshotPending) return;
    if (this.state.connection !== "open") { this.attempts = 0; this.reconnect(); }
    else if (this.stallMs && Date.now() - this.lastFrameAt > this.stallMs / 2) this.stalled(id);
  }

  /** Any frame is a sign of life, and the host's bridge sends one on a beat: a session silent for `stallMs` is dead without having closed. */
  watch(connection, link, conversationId) {
    clearInterval(this.stallTimer);
    this.stallTimer = null;
    this.lastFrameAt = Date.now();
    if (!this.stallMs) return;
    this.stallTimer = setInterval(() => {
      if (!link.live || this.connection !== connection) return;
      if (Date.now() - this.lastFrameAt >= this.stallMs) this.stalled(conversationId);
    }, Math.max(10, Math.round(this.stallMs / 4)));
    this.stallTimer.unref?.();
  }

  /** Open a new session: its hello resumes the log from this page's position. */
  stalled(conversationId) {
    this.releaseDispatched(conversationId);
    this.attempts = 0;
    this.reconnect();
  }

  /** A message sent over a session that is gone goes again on the next one, under the same key. */
  releaseDispatched(conversationId) {
    if (this.transport.requestsOutliveStream) return;
    for (const submission of this.pendings.values()) {
      if (submission.conversationId !== conversationId || submission.accepted) continue;
      clearTimeout(submission.ackTimer);
      submission.dispatched = false;
    }
  }

  /** The frame went out on a live session: the server owes its answer, `message.accepted` or `message.rejected`, within `ackTimeoutMs`. */
  markDispatched(submission) {
    submission.dispatched = true;
    if (this.transport.requestsOutliveStream || !this.ackTimeoutMs) return;
    clearTimeout(submission.ackTimer);
    submission.ackTimer = setTimeout(() => {
      if (this.pendings.get(submission.clientMessageId) !== submission || submission.conversationId !== this.state.conversationId) return;
      // The session said nothing to it: the words go back to the composer (same key on a resend), and the session is judged dead.
      this.refuse(submission, new ChatError("sendNotConfirmed"));
      this.stalled(submission.conversationId);
    }, this.ackTimeoutMs);
    submission.ackTimer.unref?.();
  }

  reconnect() {
    if (this.snapshotPending || !this.state.conversationId) return;
    this.closeConnection();
    this.connect();
  }

  closeConnection() {
    clearInterval(this.stallTimer);
    this.stallTimer = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.link) this.link.live = false;
    this.connection?.close();
    this.connection = null;
    this.link = null;
  }

  handleClose(connection, link, conversationId) {
    if (!link.live) return;
    // A socket that dies takes an unacknowledged message with it; a request that outlives its stream does not.
    const mine = [...this.pendings.values()].filter(submission => submission.conversationId === conversationId && !submission.accepted);
    if (!this.transport.steerable) for (const submission of mine) this.restoreSubmission(submission, true);
    // A message sent over the socket may have died with it: it goes again when the session is back, under the same key.
    else this.releaseDispatched(conversationId);
    if (this.connection === connection) this.connection = null;
    this.downSince ??= Date.now();
    if (this.attempts >= this.reconnectAttempts) {
      this.setState({ connection: "idle" });
      return;
    }
    const attempt = ++this.attempts;
    this.setState({ connection: "connecting" });
    const delay = Math.round(Math.min(30_000, 400 * (2 ** (attempt - 1))) * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (link.live && this.state.conversationId === conversationId) this.reconnect();
    }, delay);
  }

  /** Prepare client authority for the run, then hand the frame to the Runtime. */
  async dispatch(connection, message) {
    await this.tools.prepareRun({ conversationId: this.state.conversationId, runId: message.runId });
    await connection.send({ ...message, localTools: this.tools.localTools });
  }

  /** Hand every message the server has not acknowledged to the connection, once. */
  dispatchPending(connection, conversationId) {
    for (const submission of [...this.pendings.values()]) {
      if (submission.conversationId !== conversationId || submission.awaitingUser || submission.accepted || (this.transport.steerable && submission.dispatched)) continue;
      submission.hidden = false;
      this.markDispatched(submission);
      void this.dispatch(connection, { runId: submission.runId, clientMessageId: submission.clientMessageId, content: submission.content, attachments: submission.attachments })
        .catch(cause => this.refuse(submission, cause));
    }
    this.render();
  }

  /** A send that did not go through. An ambiguous failure keeps the key, so sending again is the same message. */
  refuse(submission, cause) {
    const ambiguous = this.transport.steerable && !(Number.isInteger(cause?.status) && cause.status >= 400 && cause.status < 500);
    this.restoreSubmission(submission, ambiguous);
    if (ambiguous) submission.awaitingUser = true;
    this.fail(cause);
  }

  /** Drop what a retry would have reused: the user changed the draft. */
  discardRetry() {
    let dropped = false;
    for (const [id, submission] of this.pendings) {
      if (submission.accepted || (this.transport.steerable && !submission.awaitingUser)) continue;
      this.pendings.delete(id);
      this.pendingStore.settle(id);
      dropped = true;
    }
    if (dropped) this.render();
  }

  async handleEvent(event, connection, link, conversationId) {
    if (!link.live) return;
    this.lastFrameAt = Date.now();
    const handler = this.frames[event?.type];
    if (handler) await handler.call(this, event, { connection, link, conversationId });
  }

  frames = {
    // The log, one event at a time, as the HTTP pages carry it.
    "log.event"(frame) { this.apply([frame.event]); },
    // A session that cannot resume the log from a position (a build workbench) says so: the latest turns are read again.
    "log.reset"(_frame, { conversationId }) { this.open(conversationId, { force: true }); },
    "tool_call.request": async function (request, { connection }) {
      // A Runtime that replays an unanswered request (after a reconnect) gets the one execution's result, never a second execution.
      if (!this.toolRuns.has(request.tool_call_id)) this.toolRuns.set(request.tool_call_id, Promise.resolve(this.tools.execute(request)));
      await this.reportToolResult(request, connection, await this.toolRuns.get(request.tool_call_id));
    },
    "approval.request": async function (request, { connection }) {
      const decision = await this.tools.requestApproval(request);
      if (!decision.approved) await this.reportToolResult(request, connection, { status: "error", error: decision.error ?? { code: "approval_denied" } });
    },
    "session.ready"(session, { connection, conversationId }) {
      if (session.conversation_id !== conversationId) {
        connection.close();
        this.fail(new ChatError("conversationIdentityMismatch"));
        return;
      }
      this.attempts = 0;
      this.downSince = null;
      this.setState(state => ({ session, connection: "open", ...(state.status.key === "reconnecting" ? { status: { key: "connected" } } : {}) }));
      this.dispatchPending(connection, conversationId);
      if (this.taskStart === conversationId) {
        this.taskStart = null;
        void this.dispatch(connection, { runId: newId("run"), clientMessageId: newId("message"), taskStart: true }).catch(cause => {
          this.taskStart = conversationId;
          this.fail(cause);
        });
      }
    },
    "message.accepted"(receipt) {
      this.freeChat.record();
      const submission = this.pendings.get(receipt.client_message_id) ?? (receipt.client_message_id || this.pendings.size !== 1 ? undefined : [...this.pendings.values()][0]);
      if (!submission) return;
      clearTimeout(submission.ackTimer);
      // The server has it now: a reload does not send it again, and the log shows it, queued when it joined a running Run, until then.
      submission.accepted = true;
      submission.queued = receipt.outcome === "steered";
      this.pendingStore.settle(submission.clientMessageId);
      // Only the copy of the message restored into the composer is cleared: a draft typed since is the user's.
      if (this.state.draft === submission.content) this.writeDraft({ draft: "", images: [] });
      this.render();
    },
    // The server refused one message: its words go back to the composer, and a Run it did not start goes on as it was.
    "message.rejected"(frame) {
      const submission = this.pendings.get(frame.client_message_id);
      if (!submission) return;
      this.restoreSubmission(submission);
      this.fail(frame.error ?? new ChatError("connectionFailed"));
    },
    "session.error"(frame) {
      const unaccepted = this.transport.steerable ? undefined : [...this.pendings.values()].find(submission => submission.leadsRun && !submission.accepted);
      if (unaccepted) this.restoreSubmission(unaccepted);
      this.fail(frame.error ?? new ChatError("connectionFailed"));
    }
  };

  /**
   * Record the user's approval state for a tool call so its row shows the
   * controls ("pending") or the outcome ("allowed" / "denied"). The host's
   * gate owns the actual decision; this is its projection into the thread.
   */
  markApproval(toolCallId, decision) {
    if (!APPROVAL_DECISIONS.includes(decision)) throw new RangeError(`Unknown approval decision: ${decision}`);
    if (this.state.approvals[toolCallId] === decision) return;
    this.setState(state => ({ approvals: { ...state.approvals, [toolCallId]: decision } }));
  }

  /** The answer to a Runtime request goes back on the session; the log carries what it did to the step. */
  async reportToolResult(request, connection, result) {
    const failed = result.status === "error";
    const error = failed ? { ...result.error, message: this.describeError(result.error) } : undefined;
    connection.toolResult(request.run_id, request.tool_call_id, failed ? { status: "error", error } : result);
  }

  // Composer ---------------------------------------------------------------

  writeDraft(patch) {
    this.setState(patch);
    this.drafts.write(this.draftScope, { text: this.state.draft, files: this.state.images });
  }

  setDraft(draft) {
    this.discardRetry();
    this.writeDraft({ draft });
  }

  addImages(files) {
    if (this.state.images.length + files.length > this.attachments.limit) {
      this.fail(new ChatError("imageCountLimit"));
      return;
    }
    this.discardRetry();
    this.writeDraft({ images: [...this.state.images, ...files] });
  }

  removeImage(file) {
    this.discardRetry();
    this.writeDraft({ images: this.state.images.filter(entry => entry !== file) });
  }

  restoreSubmission(submission, preservePending = false) {
    if (!submission) return;
    this.writeDraft({ draft: submission.content, images: submission.files });
    submission.dispatched = false;
    // Its words are back in the composer; a kept key is for a resend, and the thread shows the message again when it goes out.
    submission.hidden = true;
    clearTimeout(submission.ackTimer);
    if (!preservePending) {
      this.pendings.delete(submission.clientMessageId);
      this.pendingStore.settle(submission.clientMessageId);
    }
    this.render();
  }

  async send() {
    const { conversationId, activeRun, draft, images } = this.state;
    if (conversationId && (draft.trim() || images.length)) this.setState({ failedRun: null });
    const steering = this.transport.steerable && Boolean(activeRun);
    // A page still reading its first page takes the message too: it shows at once and is sent when the session is up.
    if (!conversationId || (activeRun && !this.transport.steerable) || (!draft.trim() && images.length === 0)) return;
    const connection = this.connection;
    // Only a send that meets a session down for a while says so; until then the retries are silent.
    if (this.downSince && Date.now() - this.downSince > QUIET_OUTAGE_MS && this.state.connection !== "open") this.setState({ status: { key: "reconnecting" } });
    this.setState({ error: null });
    let submission = null;
    try {
      const retry = [...this.pendings.values()].find(entry => entry.conversationId === conversationId && !entry.accepted && (!this.transport.steerable || entry.awaitingUser));
      // The message's id is minted here, when the user sends, and a retry of the same message keeps it.
      const clientMessageId = retry?.clientMessageId ?? newId("message");
      const files = retry?.files ?? [...images];
      const attachments = retry ? retry.attachments : await this.attachments.prepareAll(files);
      submission = retry ?? new PendingSubmission({
        conversationId, runId: steering ? activeRun : newId("run"), clientMessageId, content: draft, attachments, files
      });
      submission.leadsRun = !steering;
      submission.awaitingUser = false;
      submission.hidden = false;
      const { runId, content } = submission;
      this.pendings.set(clientMessageId, submission);
      this.pendingStore.save(submission.record());
      this.writeDraft({ draft: "", images: [] });
      this.render();
      // Only a session the server has answered with session.ready takes run messages; a socket that is merely open is still saying hello.
      if (connection?.ready && this.state.connection === "open") {
        this.markDispatched(submission);
        await this.dispatch(connection, { runId, clientMessageId, content, attachments });
      } else if (!connection) {
        this.attempts = 0;
        this.reconnect();
      }
      // Otherwise the session is on its way up: its session.ready dispatches every pending submission.
    } catch (cause) {
      if (submission) this.refuse(submission, cause);
      else this.fail(cause);
    }
  }

  cancel() {
    const runId = this.projection.activeRun;
    if (!runId || !this.connection?.ready) return;
    this.connection.cancel(runId);
    this.tools.cancel(runId);
    this.setState({ status: { key: "stopping" } });
  }

  // Polling while there is no live stream ---------------------------------

  syncPolling() {
    const { activeRun, conversationId, compacting, connection, snapshotConversationId } = this.state;
    // A session that is not open (an outage that outlasted the retries) brings nothing: while something is going on, the log is read instead.
    const key = conversationId && snapshotConversationId === conversationId && connection !== "open" && (activeRun || compacting) ? `${conversationId}:${activeRun ?? ""}:${compacting}` : null;
    if (key === this.pollKey) return;
    this.pollKey = key;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!key) return;
    this.pollTimer = setInterval(() => void this.refresh(conversationId).catch(this.failRead), this.pollMs);
  }
}

const isEnded = status => ["completed", "failed", "cancelled", "interrupted"].includes(status);
