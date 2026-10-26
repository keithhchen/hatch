import { ConversationController, createTextRevealController } from "@hatch/chat";
import { DesktopConversationTransport } from "./desktop-transport.js";
import { NativeAttachmentSource } from "./native-attachments.js";
import { NativeToolExecutor } from "./native-tools.js";
import { WorkspaceAccess } from "./workspace.js";

const MAX_IDLE_SESSIONS = 6;

/**
 * The Desktop folder gate on the shared controller: a conversation sends
 * (and starts its brief task) only while it has a granted folder. Unsent
 * text and files stay in the controller's memory until then.
 */
export class FolderGatedController extends ConversationController {
  constructor({ workspace, ...options }) {
    super(options);
    this.workspace = workspace;
  }

  get canSend() {
    return Boolean(this.workspace.grant);
  }

  send() {
    return this.canSend ? super.send() : Promise.resolve();
  }

  /** Start the brief's first turn once a folder is granted (now or later). */
  startTaskWhenGranted(conversationId) {
    const start = () => {
      this.taskStart = conversationId;
      if (this.connection?.ready) this.reconnect();
    };
    if (this.canSend) return start();
    const stop = this.workspace.subscribe(() => {
      if (!this.canSend) return;
      stop();
      start();
    });
  }
}

/** One live conversation in this window: its controller and native resources. */
export class ConversationSession {
  constructor({ agent, conversationId, controller, tools, workspace, release }) {
    Object.assign(this, { agent, conversationId, controller, tools, workspace, release });
    this.key = ConversationSessions.key(agent, conversationId);
    this.lastUsed = Date.now();
  }

  get busy() {
    return Boolean(this.controller.getState().activeRun);
  }

  async dispose() {
    this.controller.dispose();
    await this.tools.dispose();
    await this.release().catch(() => {});
  }
}

/**
 * The conversations this window keeps alive. Conversations keep running in
 * the background when the user switches away (their local tools and approvals
 * still work); idle ones beyond a small budget are closed. Opening one first
 * claims native ownership: if another window owns it, native focuses that
 * window and `open` resolves to null.
 */
export class ConversationSessions {
  static key(agent, conversationId) {
    return `${agent.key}|${conversationId}`;
  }

  constructor({ invoke, owner, approvals, clientVersion, describeError, isVisible }) {
    Object.assign(this, { invoke, owner, approvals, clientVersion, describeError, isVisible });
    this.sessions = new Map();
    this.opening = new Map();
    this.transports = new Map();
    this.attachments = new NativeAttachmentSource(invoke);
    this.account = null;
    this.token = null;
  }

  /** Bind to a signed-in account; any previous account's sessions are closed. */
  bind(account, token) {
    if (this.account?.id === account?.id && this.token === token) return Promise.resolve();
    // closeAll drops the old transports synchronously, so nothing created
    // from here on can carry the previous account's token.
    const closing = this.closeAll();
    this.account = account;
    this.token = token;
    return closing;
  }

  transportFor(agent) {
    if (!this.transports.has(agent.key)) {
      this.transports.set(agent.key, new DesktopConversationTransport({ token: this.token, binding: agent.binding, clientVersion: this.clientVersion }));
    }
    return this.transports.get(agent.key);
  }

  get(agent, conversationId) {
    return this.sessions.get(ConversationSessions.key(agent, conversationId)) ?? null;
  }

  all() {
    return [...this.sessions.values()];
  }

  open(agent, conversationId, { inheritWorkspace, startTask = false } = {}) {
    const key = ConversationSessions.key(agent, conversationId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return Promise.resolve(existing);
    }
    if (!this.opening.has(key)) {
      this.opening.set(key, this.create(agent, conversationId, inheritWorkspace, startTask).finally(() => this.opening.delete(key)));
    }
    return this.opening.get(key);
  }

  async create(agent, conversationId, inheritWorkspace, startTask) {
    const accountId = this.account.id;
    const release = await this.owner.claim({ accountId, conversationId, accessKey: agent.key });
    if (!release) return null;
    const workspace = new WorkspaceAccess(this.invoke, conversationId);
    // The folder is known before the live session says hello.
    await workspace.restore(inheritWorkspace ?? {});
    const tools = new NativeToolExecutor({ invoke: this.invoke, conversationId, workspace, approvals: this.approvals, agentKey: agent.key });
    const visible = () => this.isVisible(agent, conversationId);
    const controller = new FolderGatedController({
      workspace,
      transport: this.transportFor(agent),
      attachments: this.attachments,
      tools,
      describeError: this.describeError,
      textReveal: ({ onReveal }) => createTextRevealController({
        onReveal,
        shouldRevealImmediately: () => !visible() || document.visibilityState !== "visible"
          || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      })
    });
    tools.projectApproval = (toolCallId, decision) => controller.markApproval(toolCallId, decision);
    const session = new ConversationSession({ agent, conversationId, controller, tools, workspace, release });
    this.sessions.set(session.key, session);
    if (startTask) controller.startTaskWhenGranted(conversationId);
    controller.open(conversationId);
    this.evictIdle(session.key);
    return session;
  }

  /** Close one conversation here (archived, or moving to another window). */
  async close(agent, conversationId) {
    const session = this.get(agent, conversationId);
    if (!session) return;
    this.sessions.delete(session.key);
    await session.dispose();
  }

  evictIdle(keepKey) {
    const idle = this.all()
      .filter(session => session.key !== keepKey && !session.busy && !this.approvals.countFor(session.conversationId))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const session of idle.slice(0, Math.max(0, this.sessions.size - MAX_IDLE_SESSIONS))) {
      this.sessions.delete(session.key);
      void session.dispose();
    }
  }

  /** Close everything; the maps are emptied synchronously, disposal follows. */
  async closeAll() {
    const opening = [...this.opening.values()];
    const sessions = this.all();
    this.sessions.clear();
    for (const transport of this.transports.values()) transport.dispose();
    this.transports.clear();
    await Promise.allSettled(sessions.map(session => session.dispose()));
    // Sessions still opening land in the map later; close those as well.
    for (const result of await Promise.allSettled(opening)) {
      if (result.status !== "fulfilled" || !result.value) continue;
      if (this.sessions.get(result.value.key) === result.value) this.sessions.delete(result.value.key);
      await result.value.dispose();
    }
  }
}
