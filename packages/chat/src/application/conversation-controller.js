import { ChatTimeline, PendingSubmission } from "../domain/timeline.js";
import { RuntimeEventReducer, toolEventFromApproval } from "../domain/runtime-events.js";
import { activeSnapshotRun, mergeConversationPage, validateHistoryPage, ConversationSnapshotError } from "../domain/snapshot.js";
import { createImmediateTextReveal, textRevealBoundary } from "../domain/text-reveal.js";
import { MemoryDraftStore } from "../ports/index.js";
import { ConversationSync } from "./conversation-sync.js";
import { ChatError } from "./errors.js";

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
  session: null
});

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
   * @param {string} [options.draftScope]
   * @param {(error: object) => string} [options.describeError] localized text sent back with tool errors
   * @param {(options: {onReveal: Function}) => object} [options.textReveal] text pacing policy factory
   */
  constructor({ transport, attachments, tools, drafts = new MemoryDraftStore(), draftScope = "default", describeError = error => error?.message ?? String(error), textReveal = createImmediateTextReveal, reconnectAttempts = 3, pollMs = 2000 }) {
    Object.assign(this, { transport, attachments, tools, drafts, draftScope, describeError, reconnectAttempts, pollMs });
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
    this.pending = null;
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
    this.updateMessages(current => current.map(message => message.transient && message.run_id === runId ? { ...message, timeline: items } : message));
  }

  resetTimeline() {
    this.timeline.reset();
  }

  fail = cause => this.setState({ error: cause });

  // Library ---------------------------------------------------------------

  async loadLibrary() {
    const page = await this.transport.list(null);
    const conversations = page.conversations ?? [];
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
    this.terminalRun = null;
    this.sync.reset();
    this.reveal.discard();
    this.resetTimeline();
    this.setState({ conversationId: id, historyCursor: null, snapshotConversationId: null, messages: [], activeRun: null, runState: null, session: null, error: null, ...(id ? { status: { key: "loadingConversation" } } : {}) });
    if (!id) return;
    void this.refresh(id).catch(cause => {
      if (generation === this.generation) this.fail(cause);
    });
  }

  async refresh(id) {
    const generation = this.generation;
    const result = await this.sync.refresh(id, {
      current: () => this.state.messages,
      activeRunId: () => this.run?.id ?? null,
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
    let projected = result.messages;
    if (running && !projected.some(message => message.run_id === running.id && message.role === "assistant")) {
      projected = [...projected, ChatTimeline.streamingAssistantMessage(running.id)];
      if (this.run?.id !== running.id) this.run = { id: running.id };
    }
    this.updateMessages(projected);
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
      this.setState({ activeRun: running?.id ?? null, status: { key: running ? "agentReplying" : "connected" } });
    }
    if (firstSnapshot) this.connect();
    return { stale: false };
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
    if (this.pending?.conversationId === conversationId) this.restoreSubmission(this.pending, true);
    if (this.connection === connection) this.connection = null;
    if (this.attempts >= this.reconnectAttempts) return;
    const attempt = ++this.attempts;
    const delay = Math.round(400 * (2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (link.live && this.state.conversationId === conversationId) this.reconnect();
    }, delay);
  }

  /** Prepare client authority for the run, then hand the frame to the Runtime. */
  async dispatch(connection, message) {
    await this.tools.prepareRun({ conversationId: this.state.conversationId, runId: message.runId });
    connection.send({ ...message, localTools: this.tools.localTools });
  }

  async handleEvent(event, connection, link, conversationId) {
    if (!link.live) return;
    const boundary = textRevealBoundary(event);
    if (boundary === "flush") this.reveal.flush(event.run_id);
    else if (boundary === "discard") this.reveal.discard(event.run_id);
    const outcome = this.reducer.reduce(this.timeline, event, this.run?.id ?? null);
    const handler = this.outcomes[outcome.kind];
    if (handler) await handler.call(this, outcome, { event, connection, link, conversationId });
  }

  outcomes = {
    text(outcome, { event }) {
      this.reveal.enqueue({ runId: event.run_id, assistantId: event.run_id, content: outcome.content });
      this.setState({ status: outcome.status });
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
    ready(outcome, { connection, conversationId }) {
      const session = outcome.session;
      if (session.conversation_id !== conversationId) {
        connection.close();
        this.fail(new ChatError("conversationIdentityMismatch"));
        return;
      }
      this.attempts = 0;
      this.setState({ session });
      const pending = this.pending;
      if (pending?.conversationId === conversationId) {
        this.updateMessages(current => {
          const withUser = current.some(entry => entry.run_id === pending.runId && entry.role === "user") ? current : [...current, pending.optimisticMessage()];
          return withUser.some(entry => entry.transient && entry.run_id === pending.runId && entry.role === "assistant")
            ? withUser : [...withUser, ChatTimeline.streamingAssistantMessage(pending.runId)];
        });
        this.run = { id: pending.runId };
        this.setState({ activeRun: pending.runId, status: { key: "sending" } });
        void this.dispatch(connection, { runId: pending.runId, clientMessageId: pending.clientMessageId, content: pending.content, attachments: pending.attachments })
          .catch(cause => { this.restoreSubmission(pending); this.fail(cause); });
      }
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
    accepted() {
      const submission = this.pending;
      this.pending = null;
      if (submission) this.updateMessages(current => current.map(entry => entry.id === submission.optimisticMessageId ? { ...entry, optimistic: false, provisional: true } : entry));
      this.writeDraft({ draft: "", images: [] });
    },
    async terminal(outcome, { event, conversationId, link }) {
      await new Promise(resolve => this.reveal.complete(event.run_id, resolve));
      if (!link.live) return;
      const pending = this.pending;
      if (pending?.runId === event.run_id) this.restoreSubmission(pending);
      else this.terminalRun = { id: event.run_id, failed: outcome.failed };
      this.run = null;
      if (outcome.failed) this.fail(outcome.error ?? new ChatError("replyFailed"));
      if (!pending) this.setState({ activeRun: event.run_id, status: { key: "syncingReply" } });
      await this.refresh(conversationId);
    },
    session_error(outcome) {
      const pending = this.pending;
      if (pending && pending.runId === this.run?.id) this.restoreSubmission(pending);
      this.fail(outcome.error ?? new ChatError("connectionFailed"));
    }
  };

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
    this.pending = null;
    this.writeDraft({ draft });
  }

  addImages(files) {
    if (this.state.images.length + files.length > this.attachments.limit) {
      this.fail(new ChatError("imageCountLimit"));
      return;
    }
    this.pending = null;
    this.writeDraft({ images: [...this.state.images, ...files] });
  }

  removeImage(file) {
    this.pending = null;
    this.writeDraft({ images: this.state.images.filter(entry => entry !== file) });
  }

  restoreSubmission(submission, preservePending = false) {
    if (!submission) return;
    this.updateMessages(current => current.filter(message => message.id !== submission.optimisticMessageId
      && !(message.transient && message.run_id === submission.runId && message.role === "assistant")));
    this.writeDraft({ draft: submission.content, images: submission.files });
    if (this.run?.id === submission.runId) this.run = null;
    if (!preservePending && this.pending === submission) this.pending = null;
    this.resetTimeline();
    this.setState({ activeRun: null });
  }

  async send() {
    const { conversationId, activeRun, draft, images } = this.state;
    if (!conversationId || this.snapshotPending || activeRun || (!draft.trim() && images.length === 0)) return;
    const connection = this.connection;
    this.setState({ error: null });
    try {
      const pending = this.pending?.conversationId === conversationId ? this.pending : null;
      const files = pending?.files ?? [...images];
      const attachments = pending ? pending.attachments : await this.attachments.prepareAll(files);
      const submission = pending ?? new PendingSubmission({
        conversationId, runId: newId("run"), clientMessageId: newId("message"), content: draft, attachments, files
      });
      const { runId, clientMessageId, content } = submission;
      this.run = { id: runId };
      this.pending = submission;
      this.updateMessages(current => {
        const next = current.some(message => message.id === submission.optimisticMessageId) ? current : [...current, submission.optimisticMessage()];
        return next.some(message => message.transient && message.run_id === runId && message.role === "assistant")
          ? next : [...next, ChatTimeline.streamingAssistantMessage(runId)];
      });
      this.resetTimeline();
      this.writeDraft({ draft: "", images: [] });
      this.setState({ activeRun: runId, status: { key: "sending" } });
      if (connection?.ready) {
        await this.dispatch(connection, { runId, clientMessageId, content, attachments });
      } else {
        this.attempts = 0;
        this.reconnect();
      }
    } catch (cause) {
      if (this.pending?.conversationId === conversationId) this.restoreSubmission(this.pending);
      this.fail(cause);
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
