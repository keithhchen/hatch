import { Observable } from "../observable.js";

const isServerConversation = conversation => /^conv_[a-z0-9]+$/i.test(String(conversation?.id ?? ""));

/**
 * One Agent's conversations (newest first), loaded lazily when its sidebar
 * group expands. Refreshes keep the current rows on screen; a failed load
 * keeps them too and records the error for an inline retry.
 *
 * status: "idle" | "loading" | "ready" | "error"
 */
export class ConversationLibrary extends Observable {
  constructor(agent, transport) {
    super({ status: "idle", conversations: [], cursor: null, error: null });
    this.agent = agent;
    this.transport = transport;
    this.loading = null;
  }

  load() {
    this.loading ??= (async () => {
      this.setState({ status: this.state.status === "ready" ? "ready" : "loading", error: null });
      try {
        const page = await this.transport.list(null);
        this.setState({ status: "ready", conversations: (page.conversations ?? []).filter(isServerConversation), cursor: page.next_cursor ?? null });
      } catch (error) {
        this.setState({ status: this.state.conversations.length ? "ready" : "error", error });
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  ensureLoaded() {
    return this.state.status === "idle" || this.state.status === "error" ? this.load() : this.loading ?? Promise.resolve();
  }

  async loadMore() {
    if (!this.state.cursor) return;
    const page = await this.transport.list(this.state.cursor);
    const known = new Set(this.state.conversations.map(item => item.id));
    this.setState(state => ({
      conversations: [...state.conversations, ...(page.conversations ?? []).filter(item => isServerConversation(item) && !known.has(item.id))],
      cursor: page.next_cursor ?? null
    }));
  }

  /** Create a conversation; with brief answers Runtime starts the task on connect. */
  async create(briefAnswers) {
    const { conversation } = await this.transport.create({ briefAnswers });
    this.upsert(conversation);
    return conversation;
  }

  upsert(conversation) {
    if (!isServerConversation(conversation)) return;
    this.setState(state => ({
      conversations: [conversation, ...state.conversations.filter(item => item.id !== conversation.id)]
    }));
  }

  /** Merge a fresher projection (e.g. a snapshot's title) without reordering. */
  merge(conversation) {
    if (!this.state.conversations.some(item => item.id === conversation?.id)) return;
    this.setState(state => ({ conversations: state.conversations.map(item => item.id === conversation.id ? { ...item, ...conversation } : item) }));
  }

  find(conversationId) {
    return this.state.conversations.find(item => item.id === conversationId) ?? null;
  }

  async rename(conversationId, title) {
    const current = this.find(conversationId);
    const { conversation } = await this.transport.update(conversationId, { title, version: current?.version });
    this.merge(conversation);
  }

  async archive(conversationId) {
    const current = this.find(conversationId);
    await this.transport.update(conversationId, { status: "archived", version: current?.version });
    this.setState(state => ({ conversations: state.conversations.filter(item => item.id !== conversationId) }));
  }
}
