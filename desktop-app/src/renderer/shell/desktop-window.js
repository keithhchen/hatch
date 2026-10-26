import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { restoreAndTrackFrame } from "../native/window-frame.js";
import { RegistryAccountClient, NativeTokenStore } from "../auth/account.js";
import { DesktopSession } from "../auth/desktop-session.js";
import { ConversationLibrary } from "../agents/conversation-library.js";
import { ApprovalCenter } from "../chat/approvals.js";
import { ConversationSessions } from "../chat/conversation-sessions.js";
import { NativeAttachmentSource } from "../chat/native-attachments.js";
import { EXPLORE_URL, HATCH_ORIGIN } from "../config.js";
import { errorText } from "../i18n.js";
import { ApprovalAttention } from "../native/attention.js";
import { currentWindowLabel, emitNativeEvent, isNative, nativeInvoke, nativeWindow, onNativeEvent, openInBrowser } from "../native/bridge.js";
import { COMMAND, publishCommandState } from "../native/commands.js";
import { createConversationOwner } from "../native/conversation-owner.js";
import { normalizeProductOpenPayload, PRODUCT_OPEN_EVENT } from "../native/product-open.js";
import { Observable } from "../observable.js";
import { DESKTOP_ZOOM, nextZoom, normalizeZoom } from "./layout.js";
import { AppPreferences } from "./preferences.js";

export const AUTH_SESSION_EVENT = "hatch://auth-session";
const NARROW = "(max-width: 760px)";

function launchHint(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);
  const conversationId = params.get("conversation_id") ?? "";
  return {
    conversationId: /^conv_[a-z0-9]+$/i.test(conversationId) ? conversationId : "",
    productId: params.get("product_id") ?? "",
    entitlementId: params.get("entitlement_id") ?? "",
    startTask: params.get("task_start") === "1"
  };
}

function readExpanded(label) {
  try {
    const value = JSON.parse(localStorage.getItem(`hatch.sidebar.expanded.${label}`) ?? "null");
    return Array.isArray(value) ? value.filter(item => typeof item === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Application service for one native window: account session, Agent list,
 * per-Agent conversation libraries, live conversations, approvals, the
 * window's selection and chrome state, and every native command it handles.
 * React components only render its state and call its methods.
 */
export class DesktopWindow extends Observable {
  constructor() {
    const label = currentWindowLabel();
    const narrow = Boolean(window.matchMedia?.(NARROW).matches);
    super({
      selection: null,
      expanded: readExpanded(label),
      sidebarOpen: !narrow,
      narrow,
      zoom: DESKTOP_ZOOM.default,
      overlay: null,
      brief: null,
      renaming: null,
      openError: null,
      version: ""
    });
    this.label = label;
    this.isConversationWindow = label.startsWith("conversation-");
    this.hint = launchHint();
    this.invoke = nativeInvoke;
    this.preferences = new AppPreferences({ invoke: nativeInvoke, emit: emitNativeEvent, onEvent: onNativeEvent });
    this.session = new DesktopSession({ tokens: new NativeTokenStore(nativeInvoke), accounts: new RegistryAccountClient() });
    this.attention = new ApprovalAttention();
    this.approvals = new ApprovalCenter({ onRequest: entry => this.announceApproval(entry) });
    this.owner = isNative() ? createConversationOwner({
      invoke: nativeInvoke, listen,
      onActivate: payload => this.activateOwned(payload),
      onError: () => {}
    }) : { claim: async () => async () => {}, dispose() {} };
    this.sessions = new ConversationSessions({
      invoke: nativeInvoke,
      owner: this.owner,
      approvals: this.approvals,
      clientVersion: "",
      describeError: error => errorText(this.preferences.t, error),
      isVisible: (agent, conversationId) => this.state.selection?.agentKey === agent.key && this.state.selection?.conversationId === conversationId
    });
    this.attachments = this.sessions.attachments;
    this.libraries = new Map();
    this.disposers = [];
  }

  // Lifecycle ------------------------------------------------------------------

  async start() {
    this.disposers.push(
      this.session.subscribe(() => this.onSessionChange()),
      this.approvals.subscribe(() => this.attention.setPendingCount(this.approvals.getState().pending.length)),
      onNativeEvent(AUTH_SESSION_EVENT, payload => this.onAuthEvent(payload)),
      onNativeEvent(PRODUCT_OPEN_EVENT, payload => this.openProductLink(payload)),
      onNativeEvent("hatch://native-drop", payload => void this.acceptDrop(payload)),
      onNativeEvent("hatch://reopen", () => this.reopen())
    );
    const narrow = window.matchMedia?.(NARROW);
    const onNarrow = event => this.setState({ narrow: event.matches, sidebarOpen: !event.matches });
    narrow?.addEventListener?.("change", onNarrow);
    this.disposers.push(() => narrow?.removeEventListener?.("change", onNarrow));
    const refresh = () => { if (document.visibilityState === "visible") void this.session.refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    this.disposers.push(() => { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); });
    this.disposers.push(nativeWindow.onCloseRequested(async event => {
      event.preventDefault();
      await this.sessions.closeAll();
      await nativeWindow.destroy();
    }));

    const version = isNative() ? await getVersion().catch(() => "") : "";
    this.sessions.clientVersion = version;
    this.setState({ version });
    await Promise.all([this.preferences.load(), this.restoreWindowLayout()]);
    await this.session.launch();
    if (isNative()) void nativeInvoke("read_product_open_links").then(links => this.openProductLink(links)).catch(() => {});
  }

  dispose() {
    for (const dispose of this.disposers) dispose();
    this.owner.dispose();
    void this.sessions.closeAll();
  }

  async restoreWindowLayout() {
    if (!isNative()) return;
    try {
      const saved = await nativeInvoke("read_window_settings");
      this.savedContext = saved?.context ?? {};
      const stopFrame = await restoreAndTrackFrame({ invoke: nativeInvoke, savedFrame: saved?.frame, appWindow: getCurrentWindow(), availableMonitors, PhysicalPosition, PhysicalSize });
      this.disposers.push(stopFrame);
      const zoom = normalizeZoom(saved?.layout?.zoom);
      this.setState({ zoom, sidebarOpen: !this.state.narrow && saved?.layout?.sidebarPreference !== "closed" });
      this.applyZoom(zoom);
    } catch {
      this.savedContext = {};
    }
  }

  async onSessionChange() {
    const { phase, account, token, agents, agentsStatus } = this.session.getState();
    if (phase === "signed-out") {
      if (this.boundToken) {
        this.boundToken = null;
        this.libraries.clear();
        await this.sessions.closeAll();
        this.setState({ selection: null, brief: null, overlay: null });
      }
      if (this.isConversationWindow) void nativeWindow.close();
      else {
        await nativeWindow.hide().catch(() => {});
        void nativeInvoke("open_welcome_window").catch(() => {});
      }
      return;
    }
    if (phase !== "signed-in" || !account) return;
    if (this.boundToken !== token) {
      this.boundToken = token;
      this.libraries.clear();
      await this.sessions.bind(account, token);
    }
    if (agentsStatus === "ready" && !this.state.selection) this.restoreSelection(agents);
    this.publishCommands();
  }

  onAuthEvent(payload) {
    if (payload?.kind === "signed-in") void this.session.launch();
    if (payload?.kind === "cleared" && payload.sourceWindow !== this.label && this.session.getState().token) this.session.toSignedOut();
  }

  reopen() {
    if (this.session.getState().phase === "signed-in") void nativeInvoke("app_ready").catch(() => {});
    else void nativeInvoke("open_welcome_window").catch(() => {});
  }

  // Agents and libraries --------------------------------------------------------

  get agents() {
    return this.session.getState().agents;
  }

  agent(key) {
    return this.agents.find(agent => agent.key === key) ?? null;
  }

  library(agent) {
    if (!this.libraries.has(agent.key)) this.libraries.set(agent.key, new ConversationLibrary(agent, this.sessions.transportFor(agent)));
    return this.libraries.get(agent.key);
  }

  isExpanded(agent) {
    const expanded = this.state.expanded;
    return expanded ? expanded.includes(agent.key) : true;
  }

  setExpanded(agent, open) {
    const current = this.state.expanded ?? this.agents.map(item => item.key);
    const expanded = open ? [...new Set([...current, agent.key])] : current.filter(key => key !== agent.key);
    this.setState({ expanded });
    try { localStorage.setItem(`hatch.sidebar.expanded.${this.label}`, JSON.stringify(expanded)); } catch { /* per-window convenience only */ }
    if (open) void this.library(agent).ensureLoaded();
  }

  // Selection -------------------------------------------------------------------

  /** Launch selection: the window's URL (conversation windows), else its saved context. */
  restoreSelection(agents) {
    const fromUrl = Boolean(this.hint.conversationId);
    const hint = fromUrl ? this.hint : this.savedContext ?? {};
    const hinted = agents.find(item => hint.entitlementId
      ? item.entitlementId === hint.entitlementId
      : Boolean(hint.productId) && !item.entitlementId && item.productId === hint.productId);
    const startTask = fromUrl && this.hint.startTask;
    this.hint = { ...this.hint, startTask: false };
    if (hinted && hint.conversationId) {
      void this.select(hinted, hint.conversationId, { startTask });
      return;
    }
    const agent = hinted ?? agents[0];
    if (agent) void this.selectAgent(agent);
  }

  /** Select an Agent: its latest conversation, or its welcome surface. */
  async selectAgent(agent) {
    this.setExpanded(agent, true);
    const library = this.library(agent);
    await library.ensureLoaded();
    const latest = library.getState().conversations[0];
    if (latest) return this.select(agent, latest.id);
    this.setState({ selection: { agentKey: agent.key, conversationId: "" }, brief: null, openError: null });
    this.afterSelection();
  }

  async select(agent, conversationId, { startTask = false } = {}) {
    const previous = this.currentSession;
    this.setState({ selection: { agentKey: agent.key, conversationId }, brief: null, openError: null, ...(this.state.narrow ? { sidebarOpen: false } : {}) });
    this.afterSelection();
    try {
      const session = await this.sessions.open(agent, conversationId, { startTask, inheritWorkspace: previous?.workspace.getState().grant ? { workspaceGrant: previous.workspace.getState().grant, permissionMode: previous.workspace.permission } : undefined });
      if (this.state.selection?.conversationId !== conversationId) return;
      if (!session) {
        // Another window owns it and was focused; keep this window where it was.
        this.setState({ selection: previous ? { agentKey: previous.agent.key, conversationId: previous.conversationId } : { agentKey: agent.key, conversationId: "" } });
        this.afterSelection();
        return;
      }
      this.watchTitle(session);
      this.setState({ openedKey: session.key });
      this.afterSelection();
    } catch (error) {
      if (this.state.selection?.conversationId === conversationId) this.setState({ openError: error });
    }
  }

  get selectedAgent() {
    return this.state.selection ? this.agent(this.state.selection.agentKey) : null;
  }

  get currentSession() {
    const agent = this.selectedAgent;
    const id = this.state.selection?.conversationId;
    return agent && id ? this.sessions.get(agent, id) : null;
  }

  get selectedConversation() {
    const agent = this.selectedAgent;
    const id = this.state.selection?.conversationId;
    return agent && id ? this.library(agent).find(id) : null;
  }

  afterSelection() {
    const agent = this.selectedAgent;
    const conversation = this.selectedConversation;
    nativeWindow.setTitle(conversation?.title || (agent ? agent.name : "Hatch"));
    const conversationId = this.state.selection?.conversationId;
    if (agent && conversationId && isNative()) {
      void nativeInvoke("patch_window_settings", { patch: { context: { conversationId, ...(agent.entitlementId ? { entitlementId: agent.entitlementId } : { entitlementId: null, productId: agent.productId }), creatorId: agent.creatorId } } }).catch(() => {});
    }
    this.publishCommands();
  }

  /** Keep the library row (sidebar, window title) in step with snapshot titles. */
  watchTitle(session) {
    if (session.titleWatch) return;
    const library = this.library(session.agent);
    session.titleWatch = session.controller.subscribe(() => {
      const conversation = session.controller.getState().conversations.find(item => item.id === session.conversationId);
      if (conversation && conversation.title !== library.find(session.conversationId)?.title) {
        library.merge(conversation);
        if (this.currentSession === session) this.afterSelection();
      }
      this.publishCommands();
    });
  }

  /** Conversations in sidebar order across expanded Agents (for Previous/Next). */
  visibleConversations() {
    return this.agents.filter(agent => this.isExpanded(agent))
      .flatMap(agent => this.library(agent).getState().conversations.map(conversation => ({ agent, conversation })));
  }

  step(direction) {
    const list = this.visibleConversations();
    if (!list.length) return;
    const index = list.findIndex(item => item.conversation.id === this.state.selection?.conversationId);
    const next = list[(index + direction + list.length) % list.length];
    void this.select(next.agent, next.conversation.id);
  }

  activateOwned({ accountId, accessKey, conversationId }) {
    if (accountId !== this.session.getState().account?.id) return;
    const agent = this.agent(accessKey);
    if (agent) void this.select(agent, conversationId);
  }

  openProductLink(payload) {
    const link = normalizeProductOpenPayload(payload)[0];
    if (!link) return;
    const agent = this.agents.find(item => item.productId === link.productId && (!link.entitlementId || item.entitlementId === link.entitlementId));
    if (agent) void this.selectAgent(agent);
    else void this.session.refresh().then(() => {
      const refreshed = this.agents.find(item => item.productId === link.productId);
      if (refreshed) void this.selectAgent(refreshed);
    });
  }

  // Conversations -----------------------------------------------------------------

  /** New conversation for an Agent: its brief first when it has one. */
  newConversation(agent = this.selectedAgent, { inNewWindow = false } = {}) {
    if (!agent) return;
    if (agent.briefFields.length) {
      this.setState({ selection: { agentKey: agent.key, conversationId: "" }, brief: { agentKey: agent.key, inNewWindow, error: null, busy: false } });
      this.afterSelection();
      return;
    }
    void this.createConversation(agent, undefined, inNewWindow);
  }

  async createConversation(agent, briefAnswers, inNewWindow = false) {
    try {
      if (this.state.brief) this.setState({ brief: { ...this.state.brief, busy: true, error: null } });
      const conversation = await this.library(agent).create(briefAnswers);
      this.setExpanded(agent, true);
      if (inNewWindow) {
        this.setState({ brief: null });
        await this.openInNewWindow(agent, conversation.id, { startTask: Boolean(briefAnswers) });
      } else {
        await this.select(agent, conversation.id, { startTask: Boolean(briefAnswers) });
      }
    } catch (error) {
      if (this.state.brief) this.setState({ brief: { ...this.state.brief, busy: false, error } });
      else this.setState({ openError: error });
    }
  }

  async openInNewWindow(agent, conversationId, { startTask = false } = {}) {
    // Ownership moves with the conversation: release it here first.
    await this.sessions.close(agent, conversationId);
    if (this.state.selection?.conversationId === conversationId) await this.selectAgentWithout(agent, conversationId);
    await nativeInvoke("open_conversation_window", { conversationId, ...agent.binding, startTask });
  }

  async selectAgentWithout(agent, conversationId) {
    const other = this.library(agent).getState().conversations.find(item => item.id !== conversationId);
    if (other) await this.select(agent, other.id);
    else {
      this.setState({ selection: { agentKey: agent.key, conversationId: "" } });
      this.afterSelection();
    }
  }

  beginRename(conversationId = this.state.selection?.conversationId) {
    if (conversationId) this.setState({ renaming: conversationId });
  }

  async commitRename(agent, conversationId, title) {
    this.setState({ renaming: null });
    const next = String(title ?? "").trim();
    if (!next || next === this.library(agent).find(conversationId)?.title) return;
    try {
      await this.library(agent).rename(conversationId, next);
      if (this.state.selection?.conversationId === conversationId) this.afterSelection();
    } catch (error) {
      this.setState({ openError: error });
    }
  }

  async archive(agent, conversationId) {
    try {
      await this.library(agent).archive(conversationId);
      void this.sessions.close(agent, conversationId);
      if (this.state.selection?.conversationId === conversationId) await this.selectAgentWithout(agent, conversationId);
    } catch (error) {
      this.setState({ openError: error });
    }
  }

  // Native input -------------------------------------------------------------------

  async acceptDrop(payload) {
    const session = this.currentSession;
    if (!session) return;
    const files = NativeAttachmentSource.dropped(payload);
    if (files.length) session.controller.addImages(files);
    const directory = Array.isArray(payload?.directories) ? payload.directories[0] : null;
    if (directory) await session.workspace.adopt(directory).catch(error => session.controller.fail(error));
  }

  announceApproval(entry) {
    const agent = this.agent(entry.agentKey);
    const conversation = agent ? this.library(agent).find(entry.conversationId) : null;
    const visible = this.state.selection?.conversationId === entry.conversationId && document.hasFocus();
    if (visible) return;
    const t = this.preferences.t;
    void this.attention.announce({
      title: t("approval.notificationTitle"),
      body: t("approval.notificationBody", { agent: agent?.name ?? "Hatch", conversation: conversation?.title || t("conversation.untitled") })
    });
  }

  // Chrome ----------------------------------------------------------------------------

  toggleSidebar() {
    const sidebarOpen = !this.state.sidebarOpen;
    this.setState({ sidebarOpen });
    if (!this.state.narrow && isNative()) void nativeInvoke("patch_window_settings", { patch: { layout: { sidebarPreference: sidebarOpen ? "open" : "closed" } } }).catch(() => {});
    this.publishCommands();
  }

  setZoom(zoom) {
    const next = normalizeZoom(zoom);
    this.setState({ zoom: next });
    this.applyZoom(next);
    if (isNative()) void nativeInvoke("patch_window_settings", { patch: { layout: { zoom: next } } }).catch(() => {});
  }

  applyZoom(zoom) {
    if (isNative()) void getCurrentWebview().setZoom(zoom).catch(() => {});
    else document.documentElement.style.zoom = String(zoom);
  }

  openOverlay(overlay) {
    if (overlay === "search") for (const agent of this.agents) void this.library(agent).ensureLoaded();
    this.setState({ overlay });
  }

  closeOverlay() {
    this.setState({ overlay: null });
  }

  browseAgents() {
    void openInBrowser(EXPLORE_URL);
  }

  viewOnWeb(agent) {
    void openInBrowser(`${HATCH_ORIGIN}/products/${agent.productId}`);
  }

  async signOut() {
    this.setState({ overlay: null });
    await this.sessions.closeAll();
    await this.session.signOut();
  }

  /** Project enablement and Agent names into the native menu bar. */
  publishCommands() {
    const signedIn = this.session.getState().phase === "signed-in";
    const session = this.currentSession;
    publishCommandState({
      newConversationEnabled: signedIn && Boolean(this.selectedAgent),
      newWindowEnabled: signedIn && Boolean(this.selectedAgent),
      workspaceEnabled: Boolean(session),
      runStopEnabled: Boolean(session?.busy),
      sidebarVisible: this.state.sidebarOpen,
      conversationEnabled: Boolean(session),
      agents: this.agents.slice(0, 9).map(agent => agent.name.slice(0, 120))
    });
  }

  commandHandlers() {
    const agent = () => this.selectedAgent;
    const selected = () => this.state.selection?.conversationId;
    return {
      [COMMAND.NEW_CONVERSATION]: () => this.newConversation(),
      [COMMAND.NEW_WINDOW]: () => this.newConversation(agent(), { inNewWindow: true }),
      [COMMAND.SEARCH]: () => this.openOverlay("search"),
      [COMMAND.FIND]: () => this.openOverlay("find"),
      [COMMAND.RENAME]: () => this.beginRename(),
      [COMMAND.ARCHIVE]: () => agent() && selected() && void this.archive(agent(), selected()),
      [COMMAND.OPEN_WINDOW]: () => agent() && selected() && void this.openInNewWindow(agent(), selected()),
      [COMMAND.PREVIOUS]: () => this.step(-1),
      [COMMAND.NEXT]: () => this.step(1),
      [COMMAND.TOGGLE_SIDEBAR]: () => this.toggleSidebar(),
      [COMMAND.STOP]: () => this.currentSession?.controller.cancel(),
      [COMMAND.CHOOSE_WORKSPACE]: () => void this.currentSession?.workspace.choose().catch(error => this.currentSession?.controller.fail(error)),
      [COMMAND.SETTINGS]: () => this.openOverlay("settings"),
      [COMMAND.ZOOM_IN]: () => this.setZoom(nextZoom(this.state.zoom, "increase")),
      [COMMAND.ZOOM_OUT]: () => this.setZoom(nextZoom(this.state.zoom, "decrease")),
      [COMMAND.ZOOM_RESET]: () => this.setZoom(DESKTOP_ZOOM.default),
      "agent.select": index => { const target = this.agents[index]; if (target) void this.selectAgent(target); }
    };
  }
}
