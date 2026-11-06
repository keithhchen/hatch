import { listen } from "@tauri-apps/api/event";
import { ScrollPositions } from "@hatch/chat";
import { ConversationLibrary } from "../agents/conversation-library.js";
import { ApprovalCenter } from "../chat/approvals.js";
import { ConversationSessions } from "../chat/conversation-sessions.js";
import { NativeAttachmentSource } from "../chat/native-attachments.js";
import { HATCH_ORIGIN } from "../config.js";
import { errorText } from "../i18n.js";
import { isUuidV4 } from "../identity.js";
import { ApprovalAttention } from "../native/attention.js";
import { emitNativeEventTo, isNative, nativeInvoke, nativeWindow, onNativeEvent } from "../native/bridge.js";
import { COMMAND, publishCommandState } from "../native/commands.js";
import { createConversationOwner } from "../native/conversation-owner.js";
import { normalizeWorkspaceGrant } from "../chat/workspace.js";
import { DESKTOP_WINDOW_FRAME } from "../native/window-frame.js";
import { WindowController } from "./window-controller.js";

const NARROW = "(max-width: 760px)";

/** The Agent binding a Chat window was opened for (`?window=chat&product_id=…|entitlement_id=…`). */
export function chatWindowBinding(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  const productId = params.get("product_id") ?? "";
  const entitlementId = params.get("entitlement_id") ?? "";
  if (isUuidV4(entitlementId) && !productId) return Object.freeze({ entitlementId });
  if (isUuidV4(productId) && !entitlementId) return Object.freeze({ productId });
  return null;
}

/** Same key as AgentAccess.key. */
export const agentKeyFor = binding => binding?.entitlementId ? `entitlement:${binding.entitlementId}` : binding?.productId ? `product:${binding.productId}` : "";

/**
 * Which conversation an Agent's window returns to: the one last used in it
 * (saved per window, i.e. per Agent) while it is still listed or may be on a
 * later page; otherwise the newest; otherwise none.
 */
export function resumeConversation({ saved, conversations, hasMore }) {
  if (saved && (conversations.some(item => item.id === saved) || hasMore)) return saved;
  return conversations[0]?.id ?? "";
}

/**
 * Application service for one Agent's Chat window: its conversation library,
 * the live conversations it keeps, approvals, the selected conversation, the
 * new-conversation folder gate, chrome state and every command it handles.
 * React components only render its state and call its methods.
 *
 * state.composing: a new conversation being prepared (folder, brief) before it exists.
 */
export class ChatWindow extends WindowController {
  constructor({ binding = chatWindowBinding() } = {}) {
    const narrow = Boolean(window.matchMedia?.(NARROW).matches);
    super({ conversationId: "", composing: null, renaming: null, openError: null, sidebarOpen: !narrow, narrow }, { frameConstraints: DESKTOP_WINDOW_FRAME });
    this.binding = binding;
    this.agentKey = agentKeyFor(binding);
    this.attention = new ApprovalAttention();
    this.approvals = new ApprovalCenter({ onRequest: entry => this.announceApproval(entry) });
    this.owner = isNative() ? createConversationOwner({
      invoke: nativeInvoke, listen,
      onActivate: payload => { if (payload.accessKey === this.agentKey) void this.select(payload.conversationId); },
      onError: () => {}
    }) : { claim: async () => async () => {}, dispose() {} };
    this.sessions = new ConversationSessions({
      invoke: nativeInvoke,
      owner: this.owner,
      approvals: this.approvals,
      clientVersion: "",
      describeError: error => errorText(this.preferences.t, error),
      isVisible: (_agent, conversationId) => this.state.conversationId === conversationId
    });
    this.attachments = this.sessions.attachments;
    this.library = null;
    this.restored = false;
    // Where each conversation was left, persisted per window across relaunch.
    this.scrollPositions = new ScrollPositions({ onChange: positions => this.persistScrollPositions(positions) });
  }

  persistScrollPositions(positions) {
    if (!isNative()) return;
    clearTimeout(this.scrollPersistTimer);
    this.scrollPersistTimer = setTimeout(() => {
      void nativeInvoke("patch_window_settings", { patch: { layout: { scrollPositions: positions } } }).catch(() => {});
    }, 500);
  }

  // Lifecycle ------------------------------------------------------------------

  async start() {
    this.disposers.push(
      this.approvals.subscribe(() => this.attention.setPendingCount(this.approvals.getState().pending.length)),
      onNativeEvent("hatch://native-drop", payload => void this.acceptDrop(payload)),
      nativeWindow.onCloseRequested(async event => {
        event.preventDefault();
        await this.sessions.closeAll();
        await nativeWindow.destroy();
      })
    );
    const narrow = window.matchMedia?.(NARROW);
    const onNarrow = event => this.setState({ narrow: event.matches, sidebarOpen: !event.matches });
    narrow?.addEventListener?.("change", onNarrow);
    this.disposers.push(() => narrow?.removeEventListener?.("change", onNarrow));
    await super.start();
    this.sessions.clientVersion = this.state.version;
  }

  dispose() {
    super.dispose();
    this.owner.dispose();
    void this.sessions.closeAll();
  }

  restoredLayout(layout) {
    this.scrollPositions.restore(layout.scrollPositions);
    this.setState({ sidebarOpen: !this.state.narrow && layout.sidebarPreference !== "closed" });
  }

  get agent() {
    return this.agents.find(agent => agent.key === this.agentKey) ?? null;
  }

  async onSessionChange() {
    const { phase, account, token, agentsStatus } = this.session.getState();
    if (phase === "signed-out") {
      await this.sessions.closeAll();
      void nativeWindow.close();
      return;
    }
    if (phase !== "signed-in" || !account) return;
    if (this.boundToken !== token) {
      this.boundToken = token;
      this.library = null;
      this.restored = false;
      await this.sessions.bind(account, token);
    }
    const agent = this.agent;
    if (agent && !this.library) this.library = new ConversationLibrary(agent, this.sessions.transportFor(agent));
    if (agentsStatus === "ready" && agent && !this.restored) {
      this.restored = true;
      void this.resume();
    }
    this.afterSelection();
  }

  /** Opening an Agent returns to its last conversation. */
  async resume() {
    await this.library.ensureLoaded();
    const { conversations, cursor } = this.library.getState();
    const id = resumeConversation({ saved: this.savedWindow?.context?.conversationId, conversations, hasMore: Boolean(cursor) });
    if (id) await this.select(id);
    else this.afterSelection();
  }

  // Selection -------------------------------------------------------------------

  async select(conversationId) {
    const agent = this.agent;
    if (!agent || !conversationId) return;
    this.setState({ conversationId, composing: null, openError: null, ...(this.state.narrow ? { sidebarOpen: false } : {}) });
    this.afterSelection();
    try {
      const session = await this.sessions.open(agent, conversationId);
      if (this.state.conversationId !== conversationId) return;
      if (!session) return;
      this.watchTitle(session);
      this.setState({ openedKey: session.key });
      this.afterSelection();
    } catch (error) {
      if (this.state.conversationId === conversationId) this.setState({ openError: error });
    }
  }

  get currentSession() {
    const agent = this.agent;
    return agent && this.state.conversationId ? this.sessions.get(agent, this.state.conversationId) : null;
  }

  get selectedConversation() {
    return this.state.conversationId ? this.library?.find(this.state.conversationId) ?? null : null;
  }

  afterSelection() {
    const agent = this.agent;
    const title = this.selectedConversation?.title;
    nativeWindow.setTitle(agent ? title ? `${title} — ${agent.name}` : agent.name : "Hatch");
    const conversationId = this.state.conversationId;
    if (agent && conversationId && isNative()) {
      void nativeInvoke("patch_window_settings", { patch: { context: { conversationId, ...(agent.entitlementId ? { entitlementId: agent.entitlementId } : { entitlementId: null, productId: agent.productId }), creatorId: agent.creatorId } } }).catch(() => {});
    }
    this.publishCommands();
  }

  /** Keep the library row (sidebar, window title) in step with snapshot titles. */
  watchTitle(session) {
    if (session.titleWatch) return;
    session.titleWatch = session.controller.subscribe(() => {
      const conversation = session.controller.getState().conversations.find(item => item.id === session.conversationId);
      if (conversation && conversation.title !== this.library?.find(session.conversationId)?.title) {
        this.library?.merge(conversation);
        if (this.currentSession === session) this.afterSelection();
      }
      this.publishCommands();
    });
  }

  step(direction) {
    const list = this.library?.getState().conversations ?? [];
    if (!list.length) return;
    const index = list.findIndex(item => item.id === this.state.conversationId);
    void this.select(list[(index + direction + list.length) % list.length].id);
  }

  // New conversations: a folder first --------------------------------------------

  /** The folder the current conversation works in, offered to the next one. */
  get lastGrant() {
    return this.currentSession?.workspace.grant ?? this.state.composing?.grant ?? null;
  }

  /**
   * New conversation in this Agent. It starts only with a folder: without a
   * brief and with a known folder it is created at once; otherwise the pane
   * shows the folder (and brief) step first.
   */
  newConversation() {
    const agent = this.agent;
    // Once free messages are used up the dock shows the paywall instead.
    if (!agent || agent.freeChat.getSnapshot().locked) return;
    const grant = this.lastGrant;
    if (grant && !agent.briefFields.length) {
      void this.createConversation({ grant });
      return;
    }
    this.setState({ conversationId: "", composing: { grant, busy: false, error: null }, openError: null });
    this.afterSelection();
  }

  /** Pick the new conversation's folder; a cancelled picker changes nothing. */
  async chooseComposingFolder() {
    try {
      const grant = normalizeWorkspaceGrant(await nativeInvoke("pick_workspace_folder"));
      if (!grant || !this.state.composing) return;
      this.setState({ composing: { ...this.state.composing, grant, error: null } });
      if (!this.agent?.briefFields.length) await this.createConversation({ grant });
    } catch (error) {
      if (this.state.composing) this.setState({ composing: { ...this.state.composing, error } });
    }
  }

  cancelComposing() {
    this.setState({ composing: null });
    if (!this.state.conversationId) void this.resume();
  }

  async createConversation({ grant, briefAnswers }) {
    const agent = this.agent;
    if (!agent || !grant) return;
    const permissionMode = this.currentSession?.workspace.permission;
    try {
      if (this.state.composing) this.setState({ composing: { ...this.state.composing, busy: true, error: null } });
      const conversation = await this.library.create(briefAnswers);
      this.setState({ conversationId: conversation.id, composing: null, openError: null });
      this.afterSelection();
      const session = await this.sessions.open(agent, conversation.id, { startTask: Boolean(briefAnswers), inheritWorkspace: { workspaceGrant: grant, permissionMode } });
      if (session && this.state.conversationId === conversation.id) {
        this.watchTitle(session);
        this.setState({ openedKey: session.key });
        this.afterSelection();
      }
    } catch (error) {
      if (this.state.composing) this.setState({ composing: { ...this.state.composing, busy: false, error } });
      else this.setState({ openError: error });
    }
  }

  // Conversations -----------------------------------------------------------------

  beginRename(conversationId = this.state.conversationId) {
    if (conversationId) this.setState({ renaming: conversationId });
  }

  async commitRename(conversationId, title) {
    this.setState({ renaming: null });
    const next = String(title ?? "").trim();
    if (!next || next === this.library?.find(conversationId)?.title) return;
    try {
      await this.library.rename(conversationId, next);
      if (this.state.conversationId === conversationId) this.afterSelection();
    } catch (error) {
      this.setState({ openError: error });
    }
  }

  async archive(conversationId) {
    try {
      await this.library.archive(conversationId);
      void this.sessions.close(this.agent, conversationId);
      if (this.state.conversationId === conversationId) {
        const next = this.library.getState().conversations[0];
        if (next) await this.select(next.id);
        else { this.setState({ conversationId: "" }); this.afterSelection(); }
      }
    } catch (error) {
      this.setState({ openError: error });
    }
  }

  // Native input -------------------------------------------------------------------

  async acceptDrop(payload) {
    const directory = Array.isArray(payload?.directories) ? payload.directories[0] : null;
    if (this.state.composing && directory) {
      const grant = normalizeWorkspaceGrant(directory);
      if (grant) this.setState({ composing: { ...this.state.composing, grant } });
      if (grant && !this.agent?.briefFields.length) await this.createConversation({ grant });
      return;
    }
    const session = this.currentSession;
    if (!session) return;
    const files = NativeAttachmentSource.dropped(payload);
    if (files.length) session.controller.addImages(files);
    if (directory) await session.workspace.adopt(directory).catch(error => session.controller.fail(error));
  }

  announceApproval(entry) {
    const conversation = this.library?.find(entry.conversationId);
    if (this.state.conversationId === entry.conversationId && document.hasFocus()) return;
    const t = this.preferences.t;
    void this.attention.announce({
      title: t("approval.notificationTitle"),
      body: t("approval.notificationBody", { agent: this.agent?.name ?? "Hatch", conversation: conversation?.title || t("conversation.untitled") })
    });
  }

  /** ChatView's inline Allow / Deny for a call the native gate holds. */
  decideApproval(conversationId, toolCallId, decision) {
    const entry = this.approvals.getState().pending.find(item => item.conversationId === conversationId && item.request.tool_call_id === toolCallId);
    entry?.decide(decision === "allow");
  }

  // Chrome ----------------------------------------------------------------------------

  toggleSidebar() {
    const sidebarOpen = !this.state.sidebarOpen;
    this.setState({ sidebarOpen });
    if (!this.state.narrow && isNative()) void nativeInvoke("patch_window_settings", { patch: { layout: { sidebarPreference: sidebarOpen ? "open" : "closed" } } }).catch(() => {});
    this.publishCommands();
  }

  /** Same as Window › Library: the Library shows itself (or the sign-in window). */
  showLibrary() {
    void emitNativeEventTo("main", "hatch://reopen");
  }

  viewOnWeb() {
    if (this.agent) void this.openWeb(`${HATCH_ORIGIN}/products/${this.agent.productId}`);
  }

  async signOut() {
    await this.sessions.closeAll();
    await super.signOut();
  }

  /** Project enablement into the native menu bar. */
  publishCommands() {
    const signedIn = this.session.getState().phase === "signed-in";
    const session = this.currentSession;
    publishCommandState({
      newConversationEnabled: signedIn && Boolean(this.agent),
      workspaceEnabled: Boolean(session || this.state.composing),
      runStopEnabled: Boolean(session?.busy),
      sidebarVisible: this.state.sidebarOpen,
      conversationEnabled: Boolean(session)
    });
  }

  commandHandlers() {
    const selected = () => this.state.conversationId;
    return {
      ...super.commandHandlers(),
      [COMMAND.NEW_CONVERSATION]: () => this.newConversation(),
      [COMMAND.FIND]: () => this.openOverlay("find"),
      [COMMAND.RENAME]: () => this.beginRename(),
      [COMMAND.ARCHIVE]: () => selected() && void this.archive(selected()),
      [COMMAND.PREVIOUS]: () => this.step(-1),
      [COMMAND.NEXT]: () => this.step(1),
      [COMMAND.TOGGLE_SIDEBAR]: () => this.toggleSidebar(),
      [COMMAND.STOP]: () => this.currentSession?.controller.cancel(),
      [COMMAND.CHOOSE_WORKSPACE]: () => {
        if (this.state.composing) return void this.chooseComposingFolder();
        const session = this.currentSession;
        void session?.workspace.choose().catch(error => session.controller.fail(error));
      }
    };
  }
}
