import { ChatTimeline, PendingSubmission } from "../domain/timeline.js";
import { RuntimeEventReducer, isRunEvent, toolEventFromApproval } from "../domain/runtime-events.js";
import { activeSnapshotRun, isPlaceholderMessage, isTerminalRunStatus, mergeConversationPage, runId as idOfRun, validateHistoryPage, ConversationSnapshotError } from "../domain/snapshot.js";
import { RunText } from "../domain/run-text.js";
import { createImmediateTextReveal, textRevealBoundary } from "../domain/text-reveal.js";
import { MemoryDraftStore, MemoryPendingStore } from "../ports/index.js";
import { ConversationSync } from "./conversation-sync.js";
import { ChatError } from "./errors.js";
import { OPEN_FREE_CHAT } from "../domain/free-chat.js";

const newId = prefix => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export const INITIAL_CHAT_STATE = Object.freeze({
  conversations: [],
  conversationCursor: null,
  conversationId: "",
  snapshotConversationId: null,
  messages: [],
  historyCursor: null,
  draft: "",
  images: [],
  status: Object.freeze({ key: "loading" }),
  error: null,
  activeRun: null,
  runState: null,
  session: null,
  connection: "idle",
  approvals: Object.freeze({}),
  compactions: Object.freeze([])
});

/**
 * `state.connection`: "connecting" while a live session is being opened or
 * retried, "open" once session.ready arrived, "idle" when there is no live
 * session — no Conversation, or the automatic retries ran out. Idle is not an
 * error: the next send reconnects.
 */
export const CONNECTION_STATES = Object.freeze(["idle", "connecting", "open"]);
export const APPROVAL_DECISIONS = Object.freeze(["pending", "allowed", "denied"]);

/**
 * Application service for one Agent's conversations: library, durable
 * snapshot sync, the live Runtime session, submission lifecycle, tool and
 * approval requests. Observable (subscribe/getState) so any view layer can
 * render it; every external effect goes through a port.
 */
export class ConversationController {
  /**
   * @param {object} options
   * @param {import("../ports/index.js").ConversationTransport} options.transport
   * @param {import("../ports/index.js").AttachmentSource} options.attachments
   * @param {import("../ports/index.js").ToolExecutor} options.tools
   * @param {import("../ports/index.js").DraftStore} [options.drafts]
   * @param {import("../ports/index.js").PendingStore} [options.pendingStore] sent messages the server has not acknowledged
   * @param {string} [options.draftScope]
   * @param {(error: object) => string} [options.describeError] localized text sent back with tool errors
   * @param {(options: {onReveal: Function}) => object} [options.textReveal] text pacing policy factory
   */
  constructor({ transport, attachments, tools, drafts = new MemoryDraftStore(), draftScope = "default", describeError = error => error?.message ?? String(error), textReveal = createImmediateTextReveal, reconnectAttempts = 3, pollMs = 2000, freeChat = OPEN_FREE_CHAT, pendingStore = new MemoryPendingStore() }) {
    Object.assign(this, { transport, attachments, tools, drafts, draftScope, describeError, reconnectAttempts, pollMs, freeChat, pendingStore });
    const draft = drafts.read(draftScope);
    this.state = { ...INITIAL_CHAT_STATE, draft: draft.text, images: draft.files };
    this.listeners = new Set();
    this.reducer = new RuntimeEventReducer();
    this.timeline = new ChatTimeline();
    this.sync = new ConversationSync(transport);
    this.reveal = textReveal({ onReveal: ({ content }) => this.publishTimeline(timeline => timeline.appendText(content)) });
    this.generation = 0;
    this.attempts = 0;
    this.run = null;
    /** Messages sent and not yet acknowledged, by clientMessageId. */
    this.pendings = new Map();
    this.runText = new RunText();
    this.hasBeenReady = false;
    this.settleNext = false;
    this.taskStart = null;
    this.terminalRun = null;
    this.connection = null;
    this.link = null;
    this.reconnectTimer = null;
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

  updateMessages(update) {
    const messages = typeof update === "function" ? update(this.state.messages) : update;
    this.setState({ messages });
    return messages;
  }

  publishTimeline(apply) {
    const items = apply(this.timeline);
    const runId = this.run?.id;
    this.updateMessages(current => !runId || current.some(message => message.transient && message.run_id === runId)
      ? current.map(message => message.transient && message.run_id === runId ? { ...message, timeline: items } : message)
      : [...current, { ...ChatTimeline.streamingAssistantMessage(runId), timeline: items }]);
  }

  resetTimeline() {
    this.timeline.reset();
  }

  fail = cause => this.setState({ error: cause });

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
    this.run = null;
    this.pendings.clear();
    this.runText.reset();
    this.hasBeenReady = false;
    this.terminalRun = null;
    this.sync.reset();
    this.reveal.discard();
    this.resetTimeline();
    this.setState({ conversationId: id, historyCursor: null, snapshotConversationId: null, messages: [], activeRun: null, runState: null, session: null, connection: "idle", error: null, ...(id ? { status: { key: "loadingConversation" } } : {}) });
    if (!id) return;
    void this.refresh(id).catch(cause => {
      if (generation === this.generation) this.fail(cause);
    });
  }

  async refresh(id) {
    const generation = this.generation;
    const result = await this.sync.refresh(id, {
      current: () => this.state.messages,
      activeRunId: () => this.run && !this.run.provisional ? this.run.id : null,
      isCurrent: () => generation === this.generation && this.state.conversationId === id
    });
    if (!result) return { stale: true };
    const { snapshot } = result;
    const firstSnapshot = this.state.snapshotConversationId !== id;
    const conversation = snapshot.conversation;
    this.setState(state => ({
      snapshotConversationId: id,
      conversations: !conversation ? state.conversations : state.conversations.some(item => item.id === id)
        ? state.conversations.map(item => item.id === id ? { ...item, ...conversation } : item)
        : [conversation, ...state.conversations],
      historyCursor: state.historyCursor ?? snapshot.before_cursor ?? null
    }));
    const running = activeSnapshotRun(snapshot);
    this.endRunLostWhileAway(snapshot, running);
    if (running && this.run?.id !== running.id) this.adoptRun(running.id);
    let projected = result.messages;
    if (this.settleNext) {
      // The reply the live row was showing is now a saved message: the live row starts again from the next words.
      this.settleNext = false;
      this.resetTimeline();
    }
    if (running) {
      const tail = typeof running.partial_output === "string" ? this.runText.tail(running.id, running.partial_output, this.savedText(projected, running.id)) : "";
      if (tail) this.timeline.appendText(tail);
      if (!projected.some(message => message.transient && message.run_id === running.id)) {
        projected = [...projected, { ...ChatTimeline.streamingAssistantMessage(running.id), timeline: this.timeline.snapshot() }];
      } else if (tail) {
        projected = projected.map(message => message.transient && message.run_id === running.id ? { ...message, timeline: this.timeline.snapshot() } : message);
      }
    }
    this.updateMessages(projected);
    const awaited = this.awaitedRunId();
    const terminal = this.terminalRun;
    const settled = terminal && projected.some(message => message.run_id === terminal.id && message.role === "assistant" && !message.transient);
    if (settled || terminal?.failed) {
      this.terminalRun = null;
      if (!settled) this.updateMessages(current => current.filter(message => !(message.transient && message.run_id === terminal.id && message.role === "assistant")));
      this.resetTimeline();
      this.setState({ activeRun: running?.id ?? null, status: { key: running ? "agentReplying" : "connected" } });
    } else if (terminal) {
      this.setState({ activeRun: terminal.id, status: { key: "syncingReply" } });
    } else {
      this.setState({ activeRun: running?.id ?? awaited, status: { key: running ? "agentReplying" : awaited ? "sending" : "connected" } });
    }
    if (firstSnapshot) { this.resumePending(id, projected); this.connect(); }
    this.reconcilePending(projected);
    return { stale: false };
  }

  /** The text of this Run already in saved messages. */
  savedText(messages, runId) {
    return messages.filter(message => message.run_id === runId && message.role === "assistant" && !message.transient).reduce((total, message) => total + (message.content?.length ?? 0), 0);
  }

  /** The Run a sent message is still waiting to start, while the server has not said it is running. */
  awaitedRunId() {
    return this.run && (this.run.provisional || [...this.pendings.values()].some(submission => submission.leadsRun)) ? this.run.id : null;
  }

  /** A Run that ended while no stream was listening: its terminal event is lost, but its record says how it ended. */
  endRunLostWhileAway(snapshot, running) {
    const run = this.run;
    if (!run || running || run.provisional || this.terminalRun) return;
    const record = snapshot.runs.find(entry => idOfRun(entry) === run.id);
    if (!record || !isTerminalRunStatus(record.status)) return;
    this.run = null;
    this.updateMessages(current => current.filter(message => !(message.transient && message.run_id === run.id)));
    this.resetTimeline();
    if (record.status === "failed") this.fail(record.failure ?? new ChatError("replyFailed"));
  }

  /**
   * A Run the server named while the client held another id for it (the client's was provisional, or it joined a Run it did
   * not know): everything the client keyed by the old id moves to the real one.
   */
  adoptRun(runId) {
    const old = this.run?.id;
    this.run = { id: runId };
    if (!old || old === runId) return;
    this.updateMessages(current => current.map(message => message.run_id === old ? { ...message, run_id: runId, ...(message.transient ? { id: `stream-${runId}` } : {}) } : message));
    for (const submission of this.pendings.values()) if (submission.runId === old) submission.runId = runId;
    if (this.state.activeRun === old) this.setState({ activeRun: runId });
  }

  /** After a reload: what the server did not acknowledge is sent again, under the same key. */
  resumePending(conversationId, messages) {
    for (const record of this.pendingStore.load(conversationId)) {
      if (messages.some(message => message.id === record.clientMessageId)) { this.pendingStore.settle(record.clientMessageId); continue; }
      const submission = PendingSubmission.fromRecord(record, { runId: this.run?.id ?? newId("run"), stableId: this.transport.steerable });
      submission.leadsRun = !this.run;
      this.pendings.set(submission.clientMessageId, submission);
    }
  }

  /** The server's page is the authority: a message it holds is acknowledged, queued or taken up, and no longer pending. */
  reconcilePending(messages) {
    for (const [id, submission] of this.pendings) {
      if (!messages.some(message => message.id === id && !isPlaceholderMessage(message))) continue;
      this.pendings.delete(id);
      this.pendingStore.settle(id);
      if (submission.awaitingUser) this.writeDraft({ draft: "", images: [] });
    }
  }

  /** Retry whatever failed: the first snapshot, or the live session. */
  retry() {
    this.setState({ error: null });
    if (this.snapshotPending) this.open(this.state.conversationId, { force: true });
    else this.reconnect();
  }

  dismissError() {
    this.setState({ error: null });
  }

  async loadHistory() {
    const { conversationId, historyCursor } = this.state;
    if (!historyCursor) return;
    const generation = this.generation;
    const page = validateHistoryPage(await this.transport.history(conversationId, { beforeCursor: historyCursor }));
    if (generation !== this.generation) return;
    if (page.has_more && page.before_cursor === historyCursor) throw new ConversationSnapshotError("History cursor did not advance.");
    this.updateMessages(current => mergeConversationPage(current, page.messages, { older: true }));
    this.setState({ historyCursor: page.has_more ? page.before_cursor : null });
  }

  dispose() {
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
      onOpen: () => connection.hello(this.tools.localTools),
      onEvent: event => void this.handleEvent(event, connection, link, conversationId).catch(cause => { if (link.live) this.fail(cause); }),
      onClose: () => this.handleClose(connection, link, conversationId)
    });
    this.connection = connection;
    this.link = link;
    this.setState({ connection: "connecting" });
  }

  reconnect() {
    if (this.snapshotPending || !this.state.conversationId) return;
    this.closeConnection();
    this.connect();
  }

  closeConnection() {
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
    if (!this.transport.steerable) for (const submission of [...this.pendings.values()]) if (submission.conversationId === conversationId) this.restoreSubmission(submission, true);
    if (this.connection === connection) this.connection = null;
    if (this.attempts >= this.reconnectAttempts) {
      this.setState({ connection: "idle" });
      return;
    }
    const attempt = ++this.attempts;
    this.setState({ connection: "connecting" });
    const delay = Math.round(400 * (2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
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
      if (submission.conversationId !== conversationId || submission.awaitingUser || (this.transport.steerable && submission.dispatched)) continue;
      this.showSubmission(submission);
      submission.dispatched = true;
      void this.dispatch(connection, { runId: submission.runId, clientMessageId: submission.clientMessageId, content: submission.content, attachments: submission.attachments })
        .catch(cause => this.refuse(submission, cause));
    }
  }

  /** The message on the page, and, when it starts the Run, the reply that is coming. */
  showSubmission(submission) {
    const { runId } = submission;
    this.updateMessages(current => {
      const withUser = current.some(entry => entry.id === submission.optimisticMessageId || (!submission.stableId && entry.run_id === runId && entry.role === "user")) ? current : [...current, submission.optimisticMessage()];
      return !submission.leadsRun || withUser.some(entry => entry.transient && entry.run_id === runId && entry.role === "assistant")
        ? withUser : [...withUser, ChatTimeline.streamingAssistantMessage(runId)];
    });
    if (submission.leadsRun && !this.run) {
      this.run = { id: runId, provisional: this.transport.steerable };
      this.setState({ activeRun: runId, status: { key: "sending" } });
    }
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
    for (const [id, submission] of this.pendings) {
      if (this.transport.steerable && !submission.awaitingUser) continue;
      this.pendings.delete(id);
      this.pendingStore.settle(id);
    }
  }

  async handleEvent(event, connection, link, conversationId) {
    if (!link.live) return;
    if (this.run?.provisional && event.run_id && event.run_id !== this.run.id && isRunEvent(event)) this.adoptRun(event.run_id);
    const boundary = textRevealBoundary(event);
    if (boundary === "flush") this.reveal.flush(event.run_id);
    else if (boundary === "discard") this.reveal.discard(event.run_id);
    const outcome = this.reducer.reduce(this.timeline, event, this.run?.id ?? null);
    const handler = this.outcomes[outcome.kind];
    if (handler) await handler.call(this, outcome, { event, connection, link, conversationId });
  }

  outcomes = {
    text(outcome, { event }) {
      const content = this.runText.take(event.run_id, outcome.content, outcome.offset);
      if (!content) return;
      this.reveal.enqueue({ runId: event.run_id, assistantId: event.run_id, content });
      this.setState({ status: outcome.status });
    },
    changed(outcome, { conversationId }) {
      if (outcome.committed === "assistant") this.settleNext = true;
      void this.refresh(conversationId).catch(cause => { if (this.state.conversationId === conversationId) this.fail(cause); });
    },
    timeline(outcome) {
      this.publishTimeline(timeline => timeline.snapshot());
      if (outcome.status) this.setState({ status: outcome.status });
    },
    async tool_request(outcome, { connection }) {
      const request = outcome.request;
      this.publishTimeline(timeline => timeline.upsertTool({ ...request, locality: "client", status: "requested" }));
      await this.reportToolResult(request, connection, await this.tools.execute(request));
    },
    async approval_request(outcome, { connection }) {
      const request = outcome.request;
      this.publishTimeline(timeline => timeline.snapshot());
      const decision = await this.tools.requestApproval(request);
      if (!decision.approved) await this.reportToolResult(request, connection, { status: "error", error: decision.error ?? { code: "approval_denied" } }, toolEventFromApproval(request));
    },
    turn_state(outcome) {
      this.setState({ runState: outcome.state });
    },
    compacted(outcome, { conversationId }) {
      const { run_id: runId, window_id: windowId } = outcome.compaction;
      const id = `compaction-${runId}-${windowId}`;
      this.setState(state => state.compactions.some(entry => entry.id === id) ? {}
        : { compactions: [...state.compactions, { id, conversationId, runId }] });
    },
    ready(outcome, { connection, conversationId }) {
      const session = outcome.session;
      if (session.conversation_id !== conversationId) {
        connection.close();
        this.fail(new ChatError("conversationIdentityMismatch"));
        return;
      }
      this.attempts = 0;
      this.setState({ session, connection: "open" });
      this.dispatchPending(connection, conversationId);
      // Whatever happened while the session was down was not heard: read it.
      if (this.hasBeenReady) void this.refresh(conversationId).catch(cause => { if (this.state.conversationId === conversationId) this.fail(cause); });
      this.hasBeenReady = true;
      if (this.taskStart === conversationId) {
        this.taskStart = null;
        const runId = newId("run");
        this.run = { id: runId };
        this.resetTimeline();
        this.updateMessages(current => [...current, ChatTimeline.streamingAssistantMessage(runId)]);
        this.setState({ activeRun: runId, status: { key: "sending" } });
        void this.dispatch(connection, { runId, clientMessageId: newId("message"), taskStart: true }).catch(cause => {
          this.run = null;
          this.taskStart = conversationId;
          this.updateMessages(current => current.filter(message => !(message.transient && message.run_id === runId)));
          this.setState({ activeRun: null });
          this.fail(cause);
        });
      }
    },
    accepted(outcome) {
      this.freeChat.record();
      const receipt = outcome.receipt;
      const submission = this.pendings.get(receipt.client_message_id) ?? (receipt.client_message_id || this.pendings.size !== 1 ? undefined : [...this.pendings.values()][0]);
      if (!submission) return;
      // The server has it now, and says whether it started a Run or joined the running one (queued until it takes it up).
      this.pendings.delete(submission.clientMessageId);
      this.pendingStore.settle(submission.clientMessageId);
      this.updateMessages(current => current.map(entry => {
        if (entry.id !== submission.optimisticMessageId) return entry;
        const { state: _sending, ...rest } = entry;
        return { ...rest, optimistic: false, provisional: true, ...(receipt.outcome === "steered" ? { state: "queued" } : {}) };
      }));
      // Only the copy of the message restored into the composer is cleared: a draft typed since is the user's.
      if (this.state.draft === submission.content) this.writeDraft({ draft: "", images: [] });
    },
    async terminal(outcome, { event, conversationId, link }) {
      await new Promise(resolve => this.reveal.complete(event.run_id, resolve));
      if (!link.live) return;
      // A Run that ended before the server took the message that started it sends the words back; a server that steers keeps them.
      const unaccepted = this.transport.steerable ? undefined : [...this.pendings.values()].find(submission => submission.runId === event.run_id);
      if (unaccepted) this.restoreSubmission(unaccepted);
      else this.terminalRun = { id: event.run_id, failed: outcome.failed };
      this.run = null;
      this.setState({ runState: null });
      if (outcome.failed) this.fail(outcome.error ?? new ChatError("replyFailed"));
      if (!unaccepted) this.setState({ activeRun: event.run_id, status: { key: "syncingReply" } });
      await this.refresh(conversationId);
    },
    session_error(outcome) {
      const unaccepted = this.transport.steerable ? undefined : [...this.pendings.values()].find(submission => submission.runId === this.run?.id);
      if (unaccepted) this.restoreSubmission(unaccepted);
      this.fail(outcome.error ?? new ChatError("connectionFailed"));
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

  async reportToolResult(request, connection, result, base = request) {
    const failed = result.status === "error";
    const error = failed ? { ...result.error, message: this.describeError(result.error) } : undefined;
    this.publishTimeline(timeline => timeline.upsertTool({
      ...base, locality: "client", status: failed ? "failed" : "completed",
      ...(failed ? { error: result.error } : { result: result.result })
    }));
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
    this.updateMessages(current => current.filter(message => message.id !== submission.optimisticMessageId
      && !(submission.leadsRun && message.transient && message.run_id === submission.runId && message.role === "assistant")));
    this.writeDraft({ draft: submission.content, images: submission.files });
    if (submission.leadsRun && this.run?.id === submission.runId) {
      this.run = null;
      this.resetTimeline();
      this.setState({ activeRun: null });
    }
    submission.dispatched = false;
    if (!preservePending) {
      this.pendings.delete(submission.clientMessageId);
      this.pendingStore.settle(submission.clientMessageId);
    }
  }

  async send() {
    const { conversationId, activeRun, draft, images } = this.state;
    const steering = this.transport.steerable && Boolean(this.run);
    if (!conversationId || this.snapshotPending || (activeRun && !this.transport.steerable) || (!draft.trim() && images.length === 0)) return;
    const connection = this.connection;
    this.setState({ error: null });
    let submission = null;
    try {
      const retry = [...this.pendings.values()].find(entry => entry.conversationId === conversationId && (!this.transport.steerable || entry.awaitingUser));
      // The message's id is minted here, when the user sends, and a retry of the same message keeps it.
      const clientMessageId = retry?.clientMessageId ?? newId("message");
      const files = retry?.files ?? [...images];
      const attachments = retry ? retry.attachments : await this.attachments.prepareAll(files);
      submission = retry ?? new PendingSubmission({
        conversationId, runId: steering ? this.run.id : newId("run"), clientMessageId, content: draft, attachments, files, stableId: this.transport.steerable
      });
      submission.leadsRun = !steering;
      submission.awaitingUser = false;
      const { runId, content } = submission;
      this.pendings.set(clientMessageId, submission);
      this.pendingStore.save(submission.record());
      if (submission.leadsRun) { this.run = null; this.resetTimeline(); }
      this.showSubmission(submission);
      this.writeDraft({ draft: "", images: [] });
      if (connection?.ready) {
        submission.dispatched = true;
        await this.dispatch(connection, { runId, clientMessageId, content, attachments });
      } else {
        this.attempts = 0;
        this.reconnect();
      }
    } catch (cause) {
      if (submission) this.refuse(submission, cause);
      else this.fail(cause);
    }
  }

  cancel() {
    if (!this.run || !this.connection?.ready) return;
    this.connection.cancel(this.run.id);
    this.tools.cancel(this.run.id);
    this.setState({ status: { key: "stopping" } });
  }

  // Polling while a reply settles without a live stream ------------------

  syncPolling() {
    const { activeRun, conversationId } = this.state;
    const key = activeRun && conversationId ? `${conversationId}:${activeRun}` : null;
    if (key === this.pollKey) return;
    this.pollKey = key;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!key || this.run?.id === activeRun) return;
    this.pollTimer = setInterval(() => void this.refresh(conversationId).catch(this.fail), this.pollMs);
  }
}
