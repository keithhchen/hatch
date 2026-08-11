import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useExternalStoreRuntime,
  useMessage
} from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import {
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FilePenLine,
  FileSearch,
  FileText,
  FolderOpen,
  GitCompareArrows,
  Globe2,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  SquareTerminal,
  Wrench
} from "lucide-react";
import "streamdown/styles.css";
import "../../../packages/brand/tokens.css";
import hatchMarkUrl from "../../../packages/brand/hatch-mark.svg";
import "./styles.css";
import {
  DEFAULT_CREATOR_AGENT,
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_OPTIONS,
  PRODUCT_COPY,
  creatorAgentFromBoundSession,
  creatorAgentFromEntitlement,
  PLATFORM_LOCAL_TOOLS,
  normalizePermissionPolicy,
  permissionPolicyDetail,
  permissionPolicyLabel,
  workspaceGrantLabel
} from "./product-policy.js";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";
import {
  createConversation,
  canConnectConversation,
  getConversationSnapshot,
  interruptedRunFromSnapshot,
  isServerConversationId,
  isTerminalRunStatus,
  listConversations,
  reconcileConversationSnapshot,
  restorableConversationId,
  shouldOpenNewConversationInWindow,
  updateConversation
} from "./conversation-client.js";
import {
  conversationCreationScope,
  createConversationCreationTracker
} from "./conversation-create-retry.js";
import {
  isRetryableConversationLibraryError,
  conversationLibraryRetryScope,
  createConversationLibraryRetryController
} from "./conversation-library-retry.js";
import {
  clearAuthSession,
  createTauriAuthStorage,
  isRemoteAuthSessionCleared,
  loadSavedAuthSession,
  isAuthInvalidError,
  isNetworkError,
  startAuthSessionSignOut
} from "./auth-session.js";
import {
  CONSUMER_DESKTOP_ROLE_MESSAGE,
  persistedDesktopSessionFromError,
  resolveDesktopSession,
  signInDesktopSession
} from "./desktop-auth-flow.js";
import { openCreatorAgentCatalog } from "./catalog-opener.js";
import { projectApprovedRuntimeStream, summarizeTurnTiming } from "./stream-projection.js";
import { createTextRevealController, textRevealBoundary } from "./text-reveal.js";
import { createTauriSettingsStore } from "./desktop-settings.js";
import {
  importLegacyProfileSettings,
  purgeLegacySensitiveStorage
} from "./legacy-settings-migration.js";
import {
  isInvalidWorkspaceGrantError,
  normalizeWorkspaceGrant,
  validateRestoredWorkspace,
  workspacePickerSelection
} from "./workspace-restore.js";
import {
  shouldPersistWorkspaceToProfile,
  usesLegacyProfileRunFallback
} from "./desktop-window-context.js";
import { createTurnAccessSnapshot } from "./turn-access-snapshot.js";
import { canUseAnotherAccountFromNetworkError } from "./network-error-recovery.js";
import {
  entitlementRefreshNeedsReconnect,
  runtimeBindingForEntitlement,
  runtimeBindingMatches
} from "./entitlement-binding.js";
import {
  LOCAL_TOOL_STOP_UNCONFIRMED,
  committedResultAfterCancellation,
  localToolCancellationError,
  localToolTransportDeadlineMs,
  statusAfterLocalToolStop
} from "./local-tool-lifecycle.js";
import { DesktopWindowShell } from "./desktop-shell.jsx";
import { clampWindowFrame, normalizeWindowFrame } from "./desktop-window-frame.js";
import { accountScopedWindowContext } from "./desktop-window-context.js";
import {
  DESKTOP_LAYOUT,
  DESKTOP_ZOOM,
  nextZoom,
  normalizeWindowLayoutPreferences,
  normalizeZoom
} from "./desktop-layout.js";
import {
  conversationBindingFromLocation,
  conversationIdFromLocation,
  isEditableContextTarget,
  normalizeConversationBinding,
  nativeContextRequest,
  requestNativeContextMenu,
  routeNativeCommand,
  subscribeNativeCommands
} from "./native-commands.js";
import {
  normalizeNativeDropAttachment,
  normalizeNativeDropFile
} from "./native-drop-context.js";
import { invokeDesktopCommand } from "./native-invoke-boundary.js";
import {
  SKILL_ACTIVITY_PART,
  SKILL_RUN_ACTIVITY_PART,
  TURN_ACTIVITY_PART,
  activityGroupPath,
  activitySummary,
  appendTimelineText,
  historyTimelineEntries,
  prependTurnActivity,
  terminalTimelineParts,
  toolActionLabel,
  toolDisplay,
  toolResultSummary,
  toolState,
  toolTarget,
  upsertTimelinePart
} from "./activity-ui.js";

const PROTOCOL_VERSION = "0.7";
const OUTPUT_FILTERED_COPY = "This response was blocked by the output safety check.";
const DEFAULT_RUNTIME_URL = import.meta.env.VITE_HATCH_RUNTIME_URL || "wss://hatch.tokenquadrant.cn/v1/runtime";
const DEFAULT_AUTH_URL = import.meta.env.VITE_HATCH_AUTH_URL || "https://hatch.tokenquadrant.cn";
const BROWSE_CATALOG_URL = import.meta.env.VITE_HATCH_CATALOG_URL || "https://hatch.tokenquadrant.cn/agents";
const EMPTY_PROFILE = Object.freeze({ id: "anonymous", name: "User", initials: "U" });
const DEFAULT_PERMISSION_MODE = DEFAULT_PERMISSION_POLICY;
const ApprovalContext = createContext(null);
const NativeContextMenuContext = createContext(null);

function auxiliaryWindowMode(locationLike = globalThis.location) {
  const params = new URLSearchParams(typeof locationLike?.search === "string" ? locationLike.search : "");
  if (params.get("settings") === "1") return "settings";
  if (params.get("about") === "1") return "about";
  return "";
}

function DesktopAuxiliaryWindow({ kind }) {
  const about = kind === "about";
  return (
    <main className="desktop-auxiliary-window" aria-labelledby="auxiliary-window-title">
      <header className="desktop-auxiliary-header" data-tauri-drag-region>
        <span className="desktop-auxiliary-mark" aria-hidden="true">●</span>
        <div>
          <p className="desktop-auxiliary-kicker">HATCH</p>
          <h1 id="auxiliary-window-title">{about ? "About Hatch" : "Settings"}</h1>
        </div>
      </header>
      {about ? (
        <section className="desktop-auxiliary-content">
          <p className="desktop-auxiliary-lede">Creator agents, on your terms.</p>
          <p>Hatch keeps the desktop boundary native while React renders the conversation work surface.</p>
          <dl className="desktop-auxiliary-facts">
            <div><dt>Version</dt><dd>0.1.0</dd></div>
            <div><dt>Architecture</dt><dd>Tauri Hybrid</dd></div>
          </dl>
        </section>
      ) : (
        <section className="desktop-auxiliary-content">
          <p className="desktop-auxiliary-lede">Desktop behavior</p>
          <div className="desktop-auxiliary-row"><span>Window layout</span><strong>Per-window</strong></div>
          <div className="desktop-auxiliary-row"><span>Application zoom</span><strong>80%–200%</strong></div>
          <div className="desktop-auxiliary-row"><span>Workspace access</span><strong>Native grant</strong></div>
          <p className="desktop-auxiliary-note">Conversation, pane, frame and zoom preferences are stored per window. Secrets stay in the native session boundary.</p>
        </section>
      )}
    </main>
  );
}

function App() {
  const auxiliaryMode = auxiliaryWindowMode();
  if (auxiliaryMode) return <DesktopAuxiliaryWindow kind={auxiliaryMode} />;
  const authStorageRef = useRef(null);
  const settingsStoreRef = useRef(null);
  if (!authStorageRef.current) {
    authStorageRef.current = createTauriAuthStorage(invoke, {
      strict: typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__)
    });
  }
  if (!settingsStoreRef.current) {
    settingsStoreRef.current = createTauriSettingsStore(invoke, {
      strict: typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__)
    });
  }
  const socketRef = useRef(null);
  // Runtime messages arrive on a WebSocket listener created before React has
  // necessarily re-rendered after a folder grant. Local tool execution must
  // therefore use the latest explicit grant, not a stale render closure.
  const workspaceRef = useRef("");
  const workspaceGrantRef = useRef(null);
  const activeRunRef = useRef(null);
  const permissionRef = useRef(DEFAULT_PERMISSION_MODE);
  const imeRef = useRef({ composing: false });
  const connectedRef = useRef(false);
  const connectingRef = useRef(false);
  const connectionTokenRef = useRef(0);
  const connectionConfigRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalDisconnectRef = useRef(true);
  const approvalResolversRef = useRef(new Map());
  const pendingLocalToolsRef = useRef(new Map());
  const buyerSessionRef = useRef(null);
  const textRevealSinkRef = useRef(null);
  const textRevealRef = useRef(null);
  const entitlementRefreshRef = useRef(false);
  const lastEntitlementRefreshRef = useRef(0);
  const nativeCommandHandlersRef = useRef({});
  const nativeContextTargetsRef = useRef(new Map());
  const nativeContextTargetSequenceRef = useRef(0);
  const requestedConversationIdRef = useRef(conversationIdFromLocation());
  const requestedConversationBindingRef = useRef(conversationBindingFromLocation());
  // Preserve the launch role even after Conversation Library hydration clears
  // the one-shot URL request. Dynamic Conversation windows must never write
  // their workspace back into the main window's legacy profile fallback.
  const conversationWindowRef = useRef(Boolean(requestedConversationIdRef.current));
  const conversationLibraryRequestRef = useRef(0);
  const conversationLibraryRetryTimerRef = useRef(null);
  const conversationLibraryRetryableRef = useRef(false);
  const conversationLibraryLoadingRef = useRef(false);
  const conversationLibraryStatusRef = useRef("idle");
  const conversationLibraryRetryControllerRef = useRef(null);
  if (!conversationLibraryRetryControllerRef.current) {
    conversationLibraryRetryControllerRef.current = createConversationLibraryRetryController();
  }
  const conversationCreationTrackerRef = useRef(null);
  if (!conversationCreationTrackerRef.current) {
    conversationCreationTrackerRef.current = createConversationCreationTracker();
  }
  const conversationCursorRef = useRef(0);
  const viewportRef = useRef(null);
  const viewportScrollTopRef = useRef(0);
  const viewportScrollPersistTimerRef = useRef(null);
  // Window context is deliberately separate from profile preferences. A
  // second Conversation window must be able to use another Conversation and
  // Workspace without last-writer-wins updates from the first window.
  const windowContextRef = useRef({});
  const [serverUrl] = useState(DEFAULT_RUNTIME_URL);
  const [workspace, setWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceGrant, setWorkspaceGrant] = useState(null);
  const [workspaceDraftGrant, setWorkspaceDraftGrant] = useState(null);
  const [authState, setAuthState] = useState("loading");
  const [startupError, setStartupError] = useState("");
  const [settingsMigrationNotice, setSettingsMigrationNotice] = useState("");
  const [settingsReady, setSettingsReady] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [entitlementRefreshing, setEntitlementRefreshing] = useState(false);
  const [entitlementError, setEntitlementError] = useState("");
  const [buyerSession, setBuyerSession] = useState(null);
  const [creatorAgentEntitlements, setCreatorAgentEntitlements] = useState([]);
  const [selectedEntitlementId, setSelectedEntitlementId] = useState("");
  const selectedEntitlementIdRef = useRef("");
  const [signInStatus, setSignInStatus] = useState("idle");
  const [signInError, setSignInError] = useState("");
  const [workspaceGranted, setWorkspaceGranted] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState([]);
  const droppedFilesRef = useRef([]);
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  const [interruptedRun, setInterruptedRun] = useState(null);
  const [conversationId, setConversationId] = useState(() => requestedConversationIdRef.current || "desktop-chat");
  const [conversations, setConversations] = useState([]);
  const [conversationLibraryStatus, setConversationLibraryStatus] = useState("idle");
  const [conversationLibraryError, setConversationLibraryError] = useState("");
  const [conversationLibraryRetryNonce, setConversationLibraryRetryNonce] = useState(0);
  const [renamingConversationId, setRenamingConversationId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [status, setStatus] = useState("Offline");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState([]);
  const [composerDraft, setComposerDraft] = useState("");
  const [approvalRequests, setApprovalRequests] = useState({});
  const [creatorAgent, setCreatorAgent] = useState(DEFAULT_CREATOR_AGENT);
  const [sidebarPreference, setSidebarPreference] = useState("open");
  const [sidebarWidth, setSidebarWidth] = useState(DESKTOP_LAYOUT.sidebar.default);
  const [inspectorPreference, setInspectorPreference] = useState("open");
  const [inspectorWidth, setInspectorWidth] = useState(DESKTOP_LAYOUT.inspector.default);
  const [applicationZoom, setApplicationZoom] = useState(DESKTOP_ZOOM.default);
  const [windowLayoutReady, setWindowLayoutReady] = useState(false);
  const [windowContextReady, setWindowContextReady] = useState(false);
  const [windowStateRestored, setWindowStateRestored] = useState(false);
  const composerDraftRef = useRef("");
  const buyerProfile = buyerSession?.profile ?? EMPTY_PROFILE;
  const signedIn = authState === "signed-in";
  buyerSessionRef.current = buyerSession;

  useEffect(() => {
    droppedFilesRef.current = droppedFiles;
  }, [droppedFiles]);

  useEffect(() => {
    conversationLibraryStatusRef.current = conversationLibraryStatus;
  }, [conversationLibraryStatus]);

  // A pending native file projection belongs to exactly one conversation. It
  // must never follow the window when the user switches the Library row or
  // Creator Agent before sending. Discard is idempotent because a successful
  // send has already consumed the native one-shot handle.
  useEffect(() => {
    void discardNativeDropContexts(droppedFilesRef.current.map((file) => file.contextId));
    droppedFilesRef.current = [];
    setDroppedFiles([]);
  }, [conversationId]);

  useEffect(() => () => {
    void discardNativeDropContexts(droppedFilesRef.current.map((file) => file.contextId));
  }, []);

  textRevealSinkRef.current = appendAssistantText;
  if (!textRevealRef.current) {
    textRevealRef.current = createTextRevealController({
      onReveal: ({ assistantId, content }) => {
        textRevealSinkRef.current?.(assistantId, content);
      },
      shouldRevealImmediately: () => (
        document.visibilityState !== "visible"
        || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      )
    });
  }

  selectedEntitlementIdRef.current = selectedEntitlementId;

  function getProfileSetting(key, fallback = undefined, profileId = buyerProfile.id) {
    return settingsStoreRef.current?.getProfile(profileId, key, fallback) ?? fallback;
  }

  function setProfileSetting(key, value, profileId = buyerProfile.id) {
    settingsStoreRef.current?.setProfile(profileId, key, value);
  }

  function persistWorkspaceGrant(grant, profileId = buyerProfile.id) {
    if (!shouldPersistWorkspaceToProfile(conversationWindowRef.current)) {
      patchWindowContext({ workspaceGrant: grant });
      return;
    }
    setProfileSetting("workspace_grant", grant, profileId);
  }

  // Conversation windows are independent native contexts. Only the original
  // main window may use the legacy profile-level run slot as a migration
  // fallback; otherwise two windows can overwrite one another's recovery
  // projection even though their native contexts are separate.
  function setLegacyProfileActiveRun(value) {
    if (usesLegacyProfileRunFallback(requestedConversationIdRef.current)) {
      setProfileSetting("active_run", value);
    }
  }

  function patchWindowContext(patch = {}) {
    const next = {
      ...windowContextRef.current,
      ...patch
    };
    // Window labels are stable across launches, but a user can sign out and
    // sign in as another account in the same native window. Keep the
    // presentational context account-scoped so a composer draft, Conversation
    // id, or restored workspace projection can never cross that boundary.
    if (buyerProfile.id) next.accountId = buyerProfile.id;
    windowContextRef.current = next;
    if (!window.__TAURI_INTERNALS__) return;
    void invokeTauri("patch_window_settings", { patch: { context: next } }).catch(() => {});
  }

  function setComposerDraftValue(value) {
    const next = String(value ?? "");
    composerDraftRef.current = next;
    windowContextRef.current = {
      ...windowContextRef.current,
      composerDraft: next
    };
    setComposerDraft(next);
  }

  function handleViewportScroll(event) {
    const next = Math.max(0, Number(event.currentTarget?.scrollTop) || 0);
    viewportScrollTopRef.current = next;
    window.clearTimeout(viewportScrollPersistTimerRef.current);
    viewportScrollPersistTimerRef.current = window.setTimeout(() => {
      viewportScrollPersistTimerRef.current = null;
      patchWindowContext({ scrollTop: viewportScrollTopRef.current });
    }, 180);
  }

  function getConversationId(profileId, entitlementId, fallback) {
    const byEntitlement = getProfileSetting("conversation_id_by_entitlement", {}, profileId);
    if (byEntitlement && typeof byEntitlement === "object" && entitlementId && typeof byEntitlement[entitlementId] === "string") {
      return byEntitlement[entitlementId];
    }
    return getProfileSetting("conversation_id", fallback, profileId) || fallback;
  }

  function setConversationIdForEntitlement(profileId, entitlementId, value) {
    if (!entitlementId || !value) return;
    const current = getProfileSetting("conversation_id_by_entitlement", {}, profileId);
    setProfileSetting("conversation_id_by_entitlement", {
      ...(current && typeof current === "object" ? current : {}),
      [entitlementId]: value
    }, profileId);
  }

  function chooseEntitlement(entitlements, profileId, currentId = "", preferredBinding = null) {
    if (!Array.isArray(entitlements) || entitlements.length === 0) return null;
    const active = entitlements
      .filter((item) => item?.status === "active")
      .sort((left, right) => Date.parse(right.granted_at || "") - Date.parse(left.granted_at || ""));
    if (active.length === 0) return null;
    if (preferredBinding?.entitlementId) {
      return active.find((item) => item.entitlement_id === preferredBinding.entitlementId
        && item.creator_id === preferredBinding.creatorId
        && item.agent_id === preferredBinding.agentId) || null;
    }
    const current = active.find((item) => item.entitlement_id === currentId);
    if (current) return current;
    const previousId = settingsStoreRef.current?.getProfile(profileId, "last_selected_entitlement_id", "");
    return active.find((item) => item.entitlement_id === previousId) || active[0];
  }

  function applySignedInSession(session, entitlements, { preserveCurrent = false } = {}) {
    const profileId = session.profile?.id || EMPTY_PROFILE.id;
    const launchBinding = requestedConversationBindingRef.current
      || (conversationWindowRef.current ? normalizeConversationBinding(windowContextRef.current) : null);
    const selected = chooseEntitlement(
      entitlements,
      profileId,
      preserveCurrent ? selectedEntitlementIdRef.current : "",
      launchBinding
    );
    const mustRebindRuntime = entitlementRefreshNeedsReconnect(connectionConfigRef.current, selected);
    if (mustRebindRuntime) {
      disconnectRuntime();
      // A legacy Runtime may still expose the historical single transcript
      // route, but a new Conversation ID must always come from the Library.
      // Never mint an authoritative conversation id in the renderer.
      const fallback = "desktop-chat";
      const savedConversationId = selected
        ? getConversationId(profileId, selected.entitlement_id, fallback)
        : fallback;
      setConversationId(requestedConversationIdRef.current
        || restorableConversationId(savedConversationId, fallback));
      setMessages([]);
    }
    setBuyerSession(session);
    setCreatorAgentEntitlements(entitlements);
    setSelectedEntitlementId(selected?.entitlement_id || "");
    setCreatorAgent(selected ? creatorAgentFromEntitlement(selected) : DEFAULT_CREATOR_AGENT);
    setEntitlementError(launchBinding && !selected
      ? "This Conversation window's Creator Agent binding is no longer available in this account."
      : "");
    if (selected) setProfileSetting("last_selected_entitlement_id", selected.entitlement_id, profileId);
    setStartupError("");
    setAuthState("signed-in");
    setSignInStatus("ready");
  }

  function applyUnsupportedRoleSession(session) {
    setBuyerSession(session);
    setCreatorAgentEntitlements([]);
    setSelectedEntitlementId("");
    setCreatorAgent(DEFAULT_CREATOR_AGENT);
    setStartupError("");
    setAuthState("unsupported-role");
    setSignInStatus("ready");
  }

  async function applyResolvedDesktopSession(result, options = {}) {
    if (window.__TAURI_INTERNALS__) {
      try {
        const migration = await importLegacyProfileSettings({
          profileId: result.session.profile.id,
          legacyStorage: window.localStorage,
          settingsStore: settingsStoreRef.current
        });
        setSettingsMigrationNotice(migration.notice);
      } catch {
        setSettingsMigrationNotice("Hatch couldn't move your previous workspace settings. The legacy values were kept and Hatch will retry next launch; choose a workspace again if needed.");
      }
    } else {
      setSettingsMigrationNotice("");
    }
    if (result.state === "unsupported-role") {
      applyUnsupportedRoleSession(result.session);
      return;
    }
    applySignedInSession(result.session, result.entitlements, options);
  }

  function resetToSignedOut() {
    disconnectRuntime();
    void clearNativeToolContext();
    activeRunRef.current = null;
    setInterruptedRun(null);
    setBuyerSession(null);
    setAuthState("signed-out");
    setCreatorAgentEntitlements([]);
    setEntitlementError("");
    setSelectedEntitlementId("");
    setCreatorAgent(DEFAULT_CREATOR_AGENT);
    setMessages([]);
    setComposerDraftValue("");
    viewportScrollTopRef.current = 0;
    setWorkspace("");
    setWorkspaceDraft("");
    setWorkspaceGrant(null);
    setWorkspaceDraftGrant(null);
    workspaceGrantRef.current = null;
    setWorkspaceGranted(false);
    setConversationId("desktop-chat");
    setSignInStatus("idle");
    setStartupError("");
    setSettingsMigrationNotice("");
    connectionConfigRef.current = null;
  }

  // Session storage is process-wide while each WebView owns independent React
  // state. Native clear_auth_token broadcasts only a semantic event so every
  // other Conversation window drops its stale in-memory bearer and returns to
  // Sign in; the source window is ignored because its own caller resets it.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    const sourceWindow = getCurrentWindow().label;
    let disposed = false;
    let unlisten;
    void listen("hatch://auth-session", ({ payload }) => {
      if (disposed || !isRemoteAuthSessionCleared(payload, sourceWindow)) return;
      if (!buyerSessionRef.current?.accessToken) return;
      resetToSignedOut();
      setSignInError("This session was signed out in another Hatch window.");
    }).then((dispose) => {
      unlisten = dispose;
      if (disposed) unlisten?.();
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function synchronizeNativeToolContext(accessSnapshot) {
    const workspaceGrantId = String(accessSnapshot?.workspaceGrantId || "").trim();
    if (!workspaceGrantId) throw new Error("Choose a workspace folder before starting a task.");
    return invokeTauri("set_window_tool_context", {
      workspaceGrantId,
      permissionPolicy: accessSnapshot.permissionMode
    });
  }

  async function clearNativeToolContext() {
    try {
      await invokeTauri("clear_window_tool_context");
    } catch {
      // The process may already be closing. Rust also clears per-window
      // authority on WindowEvent::Destroyed.
    }
  }

  async function clearSavedSession(session, clearPromise) {
    try {
      await (clearPromise ?? clearAuthSession(session, authStorageRef.current));
    } catch {
      resetToSignedOut();
      setSignInError("Hatch couldn't clear the saved sign-in from this Mac. Sign in again to replace it.");
      return false;
    }
    resetToSignedOut();
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    async function bootstrapAuth() {
      if (window.__TAURI_INTERNALS__) {
        try {
          purgeLegacySensitiveStorage(window.localStorage);
        } catch {
          // Legacy cleanup is best effort and must not block normal Sign in.
        }
      }
      await settingsStoreRef.current.load();
      if (cancelled) return;
      setSettingsReady(true);
      const savedSession = await loadSavedAuthSession(authStorageRef.current);
      if (!savedSession) {
        setAuthState("signed-out");
        return;
      }
      try {
        const result = await resolveDesktopSession(savedSession, DEFAULT_AUTH_URL);
        if (!cancelled) await applyResolvedDesktopSession(result);
      } catch (error) {
        if (cancelled) return;
        if (isAuthInvalidError(error)) {
          const cleared = await clearSavedSession(savedSession);
          if (cleared) setSignInError("");
          return;
        }
        setBuyerSession(savedSession);
        setStartupError(errorMessage(error));
        setAuthState("network-error");
      }
    }
    void bootstrapAuth();
    return () => { cancelled = true; };
  }, [bootstrapAttempt]);

  async function refreshEntitlements({ startup = false, preserveCurrent = true } = {}) {
    if (!buyerSession?.accessToken || entitlementRefreshRef.current) return;
    entitlementRefreshRef.current = true;
    setEntitlementRefreshing(true);
    lastEntitlementRefreshRef.current = Date.now();
    try {
      const entitlements = await fetchPurchasedCreatorAgents(DEFAULT_AUTH_URL, buyerSession.accessToken);
      applySignedInSession(buyerSession, entitlements, { preserveCurrent });
      // A successful entitlement refresh is also evidence that the service is
      // reachable again. Re-run a previously network-failed Library request
      // after React applies any Agent rebinding, without changing its pending
      // bootstrap clientRequestId.
      if (conversationLibraryRetryableRef.current
        && conversationLibraryStatusRef.current === "unavailable"
        && !conversationLibraryLoadingRef.current) {
        setConversationLibraryRetryNonce((current) => current + 1);
      }
    } catch (error) {
      if (isAuthInvalidError(error)) {
        await clearSavedSession(buyerSession);
        return;
      }
      if (startup) {
        setStartupError(errorMessage(error));
        setAuthState("network-error");
      } else {
        setEntitlementError("Connection lost. Your account stays here. Retry when you’re online.");
        setStatus("Couldn't refresh your Agents. Try again when you're online.");
      }
    } finally {
      entitlementRefreshRef.current = false;
      setEntitlementRefreshing(false);
    }
  }

  useEffect(() => {
    if (!signedIn || !buyerSession?.accessToken) return undefined;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastEntitlementRefreshRef.current < 1500) return;
      void refreshEntitlements({ preserveCurrent: true });
    };
    const recoverLibrary = () => {
      if (document.visibilityState === "hidden" || entitlementRefreshRef.current) return;
      triggerConversationLibraryRecovery({ manual: true });
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", recoverLibrary);
    window.addEventListener("online", recoverLibrary);
    document.addEventListener("visibilitychange", recoverLibrary);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", recoverLibrary);
      window.removeEventListener("online", recoverLibrary);
      document.removeEventListener("visibilitychange", recoverLibrary);
    };
  }, [buyerSession?.accessToken, signedIn, selectedEntitlementId]);

  function conversationBindingFor(entitlementId = selectedEntitlementId) {
    const entitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === entitlementId);
    return entitlement ? {
      entitlementId: entitlement.entitlement_id,
      creatorId: entitlement.creator_id,
      agentId: entitlement.agent_id
    } : null;
  }

  function launchConversationBinding() {
    return requestedConversationBindingRef.current
      || (conversationWindowRef.current ? normalizeConversationBinding(windowContextRef.current) : null);
  }

  function conversationCreationRequest(binding, purpose = "create") {
    const scope = conversationCreationScope({
      accountId: buyerProfile.id,
      binding,
      purpose
    });
    const clientRequestId = conversationCreationTrackerRef.current.requestId(
      scope,
      () => `desktop-${purpose}-${stableRandomId()}`
    );
    return { scope, clientRequestId };
  }

  function settleConversationCreation(scope, error = null) {
    conversationCreationTrackerRef.current.settle(scope, {
      retryable: error?.code === "network_error"
    });
  }

  function clearConversationLibraryRetryTimer() {
    if (conversationLibraryRetryTimerRef.current === null) return;
    window.clearTimeout(conversationLibraryRetryTimerRef.current);
    conversationLibraryRetryTimerRef.current = null;
  }

  function conversationLibraryScope(binding) {
    return conversationLibraryRetryScope({
      accountId: buyerProfile.id,
      binding
    });
  }

  function resetConversationLibraryRecovery(binding) {
    const scope = conversationLibraryScope(binding);
    conversationLibraryRetryControllerRef.current.reset(scope);
    conversationLibraryRetryableRef.current = false;
    clearConversationLibraryRetryTimer();
  }

  function scheduleConversationLibraryRetry(binding) {
    const scope = conversationLibraryScope(binding);
    const controller = conversationLibraryRetryControllerRef.current;
    controller.setScope(scope);
    const retry = controller.nextAutomaticRetry({ retryable: true });
    if (!retry) return false;
    clearConversationLibraryRetryTimer();
    conversationLibraryRetryTimerRef.current = window.setTimeout(() => {
      conversationLibraryRetryTimerRef.current = null;
      if (!signedIn || !buyerSession?.accessToken || conversationLibraryLoadingRef.current) return;
      const currentBinding = conversationBindingFor();
      if (!currentBinding || conversationLibraryScope(currentBinding) !== scope) return;
      setConversationLibraryRetryNonce((current) => current + 1);
    }, retry.delay);
    return true;
  }

  function triggerConversationLibraryRecovery({ manual = false } = {}) {
    if (!signedIn || !buyerSession?.accessToken || !selectedEntitlementId) return false;
    if (conversationLibraryStatusRef.current !== "unavailable"
      || !conversationLibraryRetryableRef.current
      || conversationLibraryLoadingRef.current) return false;
    const binding = conversationBindingFor();
    if (!binding?.entitlementId || !binding.creatorId || !binding.agentId) return false;
    const controller = conversationLibraryRetryControllerRef.current;
    const scope = conversationLibraryScope(binding);
    controller.setScope(scope);
    if (manual && !controller.allowManualTrigger()) return false;
    clearConversationLibraryRetryTimer();
    setConversationLibraryRetryNonce((current) => current + 1);
    return true;
  }

  async function loadConversationLibrary() {
    if (!signedIn || !buyerSession?.accessToken || !selectedEntitlementId) {
      conversationLibraryLoadingRef.current = false;
      conversationLibraryRetryableRef.current = false;
      clearConversationLibraryRetryTimer();
      setConversations([]);
      setConversationLibraryStatus("idle");
      return;
    }
    const binding = conversationBindingFor();
    if (!binding?.entitlementId || !binding.creatorId || !binding.agentId) {
      conversationLibraryLoadingRef.current = false;
      conversationLibraryRetryableRef.current = false;
      clearConversationLibraryRetryTimer();
      setConversationLibraryStatus("unavailable");
      setConversationLibraryError("Conversation Library is waiting for the Agent binding.");
      return;
    }
    const launchBinding = launchConversationBinding();
    if (conversationWindowRef.current
      && isServerConversationId(requestedConversationIdRef.current)
      && !launchBinding) {
      // A legacy native manifest may contain a server Conversation id but no
      // saved Agent binding. Do not guess from profile order or silently
      // create a replacement under another Agent; require an explicit
      // server-issued route/context on the next open.
      conversationLibraryLoadingRef.current = false;
      conversationLibraryRetryableRef.current = false;
      clearConversationLibraryRetryTimer();
      setConversationLibraryStatus("unavailable");
      setConversationLibraryError("This Conversation window needs its Creator Agent binding before it can be restored.");
      return;
    }
    if (conversationWindowRef.current && launchBinding && !runtimeBindingMatches(launchBinding, binding)) {
      // Wait for the context-binding selector effect to choose the exact
      // Creator Agent. Never issue a Library request for the profile's
      // default Agent while a restored secondary window is still rebinding.
      conversationLibraryLoadingRef.current = false;
      setConversationLibraryStatus("loading");
      return;
    }
    const requestId = ++conversationLibraryRequestRef.current;
    conversationLibraryLoadingRef.current = true;
    conversationLibraryRetryControllerRef.current.setScope(conversationLibraryScope(binding));
    setConversationLibraryStatus("loading");
    setConversationLibraryError("");
    try {
      const payload = await listConversations(serverUrl, buyerSession.accessToken, binding, {
        status: "active",
        limit: 100
      });
      if (requestId !== conversationLibraryRequestRef.current) return;
      let nextConversations = Array.isArray(payload?.conversations)
        ? payload.conversations.filter((item) => isServerConversationId(item?.id) && item.status !== "archived")
        : [];
      let requested = requestedConversationIdRef.current;
      const saved = getConversationId(
        buyerProfile.id,
        selectedEntitlementId,
        ""
      );
      const savedServerConversation = isServerConversationId(saved) && nextConversations.some((item) => item.id === saved)
        ? saved
        : "";
      // A URL can be supplied by another window, but the current Agent list
      // is the authority for whether that Conversation belongs here. Do not
      // hydrate or execute an ID that the bound Library did not return.
      const requestedServerConversation = isServerConversationId(requested)
        && nextConversations.some((item) => item.id === requested)
        ? requested
        : "";
      let nextId = requestedServerConversation || savedServerConversation || nextConversations[0]?.id || "";

      if (!nextId && !requestedServerConversation) {
        if (requestId !== conversationLibraryRequestRef.current) return;
        const creation = conversationCreationRequest(binding, "bootstrap");
        try {
          const created = await createConversation(serverUrl, buyerSession.accessToken, binding, {
            title: `New ${creatorAgent.name} conversation`,
            clientRequestId: creation.clientRequestId
          });
          const conversation = created?.conversation;
          if (!isServerConversationId(conversation?.id)) {
            throw new Error("Runtime returned an invalid server Conversation ID.");
          }
          settleConversationCreation(creation.scope);
          nextId = conversation.id;
          nextConversations = [conversation, ...nextConversations];
        } catch (error) {
          settleConversationCreation(creation.scope, error);
          throw error;
        }
      }
      if (requestId !== conversationLibraryRequestRef.current) return;
      if (nextId && nextId !== conversationId) {
        disconnectRuntime();
        conversationCursorRef.current = 0;
        setMessages([]);
        setConversationId(nextId);
        setConversationIdForEntitlement(buyerProfile.id, selectedEntitlementId, nextId);
      }
      if (requested && isServerConversationId(requested) && !requestedServerConversation) {
        setConversationLibraryError("That Conversation is not available for the selected Creator Agent.");
      }
      requestedConversationIdRef.current = "";
      setConversations(nextConversations);
      setConversationLibraryStatus("ready");
      conversationLibraryLoadingRef.current = false;
      resetConversationLibraryRecovery(binding);
    } catch (error) {
      if (requestId !== conversationLibraryRequestRef.current) return;
      // A server without the P2 Library API can still serve legacy transcript
      // reads. Keep that compatibility path explicit and never fabricate a
      // new server Conversation ID in the renderer.
      setConversationLibraryStatus("unavailable");
      setConversationLibraryError(errorMessage(error));
      setStatus("Conversation Library unavailable — keeping the legacy session.");
      conversationLibraryLoadingRef.current = false;
      const retryable = isRetryableConversationLibraryError(error);
      conversationLibraryRetryableRef.current = retryable;
      if (retryable) {
        scheduleConversationLibraryRetry(binding);
      } else {
        conversationLibraryRetryControllerRef.current.reset(conversationLibraryScope(binding));
        clearConversationLibraryRetryTimer();
      }
    }
  }

  useEffect(() => {
    if (!windowContextReady) return undefined;
    void loadConversationLibrary();
    return () => {
      conversationLibraryRequestRef.current += 1;
      conversationLibraryLoadingRef.current = false;
      clearConversationLibraryRetryTimer();
    };
  }, [buyerSession?.accessToken, conversationLibraryRetryNonce, selectedEntitlementId, signedIn, windowContextReady]);

  function isCurrentRuntimeTransport(socket, requestToken) {
    return Boolean(
      socket
      && socketRef.current === socket
      && connectionTokenRef.current === requestToken
      && !intentionalDisconnectRef.current
    );
  }

  function sendRuntimeMessage(socket, requestToken, message) {
    if (!isCurrentRuntimeTransport(socket, requestToken) || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    const flushHiddenText = () => {
      if (document.visibilityState !== "visible") textRevealRef.current?.flush();
    };
    document.addEventListener("visibilitychange", flushHiddenText);
    return () => {
      document.removeEventListener("visibilitychange", flushHiddenText);
      textRevealRef.current?.discard();
    };
  }, []);

  const send = useCallback((message) => {
    const socket = socketRef.current;
    return sendRuntimeMessage(socket, connectionTokenRef.current, message);
  }, []);

  const cancelRun = useCallback(async () => {
    const activeRun = activeRunRef.current;
    if (!activeRun) return;
    send({
      type: "turn.cancel",
      run_id: activeRun.runId,
      reason: "user_requested"
    });
    const localToolsStopped = await cancelPendingLocalTools("user_requested", activeRun.runId);
    setStatus(localToolsStopped ? "Cancelling" : "Couldn't confirm that the local tool stopped");
  }, [send]);

  const resolveToolApproval = useCallback((toolCallId, approved) => {
    const resolver = approvalResolversRef.current.get(toolCallId);
    if (!resolver) return;
    approvalResolversRef.current.delete(toolCallId);
    setApprovalRequests((current) => {
      const request = current[toolCallId];
      if (!request) return current;
      return {
        ...current,
        [toolCallId]: {
          ...request,
          status: approved ? "approved" : "denied",
          resolvedAt: Date.now()
        }
      };
    });
    resolver(approved);
  }, []);

  const sendUserMessage = useCallback(async (appendMessage) => {
    const socket = socketRef.current;
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Service unavailable. Your message will stay here.");
      return;
    }
    if (activeRunRef.current) {
      setStatus("A turn is already running.");
      return;
    }

    // `desktop-chat` is a read-only migration identifier. A new Desktop turn
    // must always target a server-issued Conversation from the Library; the
    // legacy history endpoint remains available only so older sessions can
    // be viewed while the Runtime rolls forward.
    const activeConversationId = conversationId.trim();
    if (!isServerConversationId(activeConversationId)) {
      setStatus(conversationLibraryStatus === "loading"
        ? "Preparing your Conversation Library…"
        : "Conversation Library unavailable. Try again when you're online.");
      return;
    }

    const content = textFromAppendMessage(appendMessage).trim();
    if (!content) return;
    // Workspace and permission changes are pending Desktop preferences until a
    // new turn starts. The native window captures this exact snapshot before
    // the Runtime may request a local tool; the renderer never sends a path or
    // an `approved_by_user` flag to authorize the tool itself.
    const accessSnapshot = createTurnAccessSnapshot(workspaceGrant?.grant_id, workspace, permissionMode);
    try {
      await synchronizeNativeToolContext(accessSnapshot);
    } catch (error) {
      setStatus(`Couldn't prepare native workspace access: ${errorMessage(error)}`);
      return;
    }
    let attachments = [];
    let preparedDroppedFiles = droppedFiles;
    if (droppedFiles.length > 0) {
      try {
        const prepared = await prepareNativeDropAttachments(droppedFiles);
        attachments = prepared.attachments;
        preparedDroppedFiles = prepared.files;
      } catch (error) {
        setStatus(`Couldn't attach the dropped files: ${errorMessage(error)}`);
        return;
      }
    }
    const runId = `run_${stableRandomId()}`;
    const clientMessageId = `message_${stableRandomId()}`;
    const outboundMessage = {
      type: "client.message",
      run_id: runId,
      client_message_id: clientMessageId,
      conversation_id: activeConversationId,
      message: {
        role: "user",
        content,
        ...(attachments.length > 0 ? { attachments } : {})
      }
    };
    workspaceRef.current = accessSnapshot.displayPath;
    workspaceGrantRef.current = workspaceGrant;
    permissionRef.current = accessSnapshot.permissionMode;

    const assistantId = `${runId}_assistant`;
    const startedAt = Date.now();
    textRevealRef.current?.discard();
    activeRunRef.current = {
      runId,
      clientMessageId,
      assistantId,
      text: "",
      startedAt,
      accessSnapshot,
      timing: { questionSentAt: startedAt }
    };
    setLegacyProfileActiveRun({
      runId,
      clientMessageId,
      assistantId,
      startedAt,
      conversationId,
      accessSnapshot,
      timing: { questionSentAt: startedAt }
    });
    patchWindowContext({ activeRun: activeRunRef.current, dismissedRunId: null });
    setRunning(true);
    setStatus("Running");
    if (!send(outboundMessage)) {
      // `read_native_drop_contexts` is intentionally one-shot. Keep its
      // immutable projection in this window's draft state so a transient
      // socket failure remains retryable without reopening the external file.
      activeRunRef.current = null;
      setLegacyProfileActiveRun(undefined);
      patchWindowContext({ activeRun: null });
      setRunning(false);
      droppedFilesRef.current = preparedDroppedFiles;
      setDroppedFiles(preparedDroppedFiles);
      setStatus("Service unavailable. Your message will stay here.");
      return;
    }
    // Clear the Composer only after native authority and socket send both
    // succeed. A failed preparation/send leaves the user's draft and native
    // attachment projection recoverable for retry.
    setComposerDraftValue("");
    droppedFilesRef.current = [];
    setDroppedFiles([]);
    setMessages((current) => [
      ...current,
      // Runtime receives the user text plus structured attachments. Keep the
      // optimistic message text clean and retain only attachment metadata in
      // the local UI projection; the untrusted body is never flattened into
      // `message.content` by the renderer.
      makeUserMessage(`${runId}_user`, content, startedAt, { attachments }),
      makeAssistantPlaceholder(assistantId, runId, startedAt)
    ]);

  }, [buyerProfile.id, connected, conversationId, conversationLibraryStatus, droppedFiles, permissionMode, send, workspace, workspaceGrant]);

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    isLoading: status === "Loading history...",
    isSendDisabled: !connected
      || running
      || Boolean(interruptedRun)
      || conversationLibraryStatus !== "ready"
      || !isServerConversationId(conversationId),
    onNew: sendUserMessage,
    onCancel: cancelRun,
    unstable_capabilities: {
      copy: true
    }
  });

  const startImeComposition = useCallback(() => {
    imeRef.current.composing = true;
  }, []);

  const endImeComposition = useCallback(() => {
    imeRef.current.composing = false;
  }, []);

  const resetImeComposition = useCallback(() => {
    imeRef.current.composing = false;
  }, []);

  const stopImeEnterSubmit = useCallback((event) => {
    if (event.key !== "Enter") return;
    const nativeEvent = event.nativeEvent ?? event;
    if (imeRef.current.composing || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  // Hydrate the invoking native window's context before profile-level legacy
  // migration runs. The profile store remains a compatibility fallback for
  // the original single-window build, but it must not be the authority once
  // a second Conversation window exists.
  useEffect(() => {
    if (!settingsReady || !signedIn || !buyerSession?.profile?.id) {
      setWindowContextReady(false);
      windowContextRef.current = {};
      return;
    }
    let cancelled = false;
    setWindowContextReady(false);
    void invokeTauri("read_window_settings").then((saved) => {
      if (cancelled) return;
      const context = saved?.context && typeof saved.context === "object" && !Array.isArray(saved.context)
        ? saved.context
        : {};
      // Context written by older builds had no account binding. Discard it
      // once rather than risking a cross-account draft or Conversation
      // projection; pane/frame preferences remain available independently.
      const accountBoundContext = accountScopedWindowContext(context, buyerSession.profile.id);
      windowContextRef.current = {
        ...accountBoundContext,
        accountId: buyerSession.profile.id,
        conversationId: typeof accountBoundContext.conversationId === "string" ? accountBoundContext.conversationId : "",
        workspaceGrant: normalizeWorkspaceGrant(accountBoundContext.workspaceGrant),
        permissionMode: accountBoundContext.permissionMode ? normalizePermissionPolicy(accountBoundContext.permissionMode) : "",
        activeRun: parseStoredJson(accountBoundContext.activeRun),
        dismissedRunId: typeof accountBoundContext.dismissedRunId === "string"
          ? accountBoundContext.dismissedRunId.trim()
          : "",
        composerDraft: typeof accountBoundContext.composerDraft === "string" ? accountBoundContext.composerDraft : "",
        scrollTop: Number.isFinite(Number(accountBoundContext.scrollTop))
          ? Math.max(0, Number(accountBoundContext.scrollTop))
          : 0,
        conversationCursor: Number.isFinite(Number(accountBoundContext.conversationCursor))
          ? Math.max(0, Number(accountBoundContext.conversationCursor))
          : 0
      };
      if (conversationWindowRef.current && !requestedConversationBindingRef.current) {
        requestedConversationBindingRef.current = normalizeConversationBinding(windowContextRef.current);
      }
      conversationCursorRef.current = requestedConversationIdRef.current
        && requestedConversationIdRef.current !== windowContextRef.current.conversationId
        ? 0
        : windowContextRef.current.conversationCursor;
      composerDraftRef.current = windowContextRef.current.composerDraft;
      setComposerDraft(windowContextRef.current.composerDraft);
      viewportScrollTopRef.current = windowContextRef.current.scrollTop;
      setWindowContextReady(true);
    }).catch(() => {
      if (!cancelled) {
        windowContextRef.current = {};
        setWindowContextReady(true);
      }
    });
    return () => { cancelled = true; };
  }, [buyerSession?.profile?.id, settingsReady, signedIn]);

  // A restored secondary window may be relaunched from the native manifest
  // with only its conversation id. Its last native context still contains
  // the immutable Agent binding; re-select that entitlement before the
  // Conversation Library request. URL/context values are only hints and must
  // match the signed-in entitlement projection exactly.
  useEffect(() => {
    if (!windowContextReady || !signedIn || !conversationWindowRef.current) return;
    const binding = launchConversationBinding();
    if (!binding || creatorAgentEntitlements.length === 0) return;
    const selected = creatorAgentEntitlements.find((item) => item.entitlement_id === binding.entitlementId
      && item.creator_id === binding.creatorId
      && item.agent_id === binding.agentId);
    if (!selected) {
      if (selectedEntitlementId) setSelectedEntitlementId("");
      setEntitlementError("This Conversation window's Creator Agent binding is no longer available in this account.");
      return;
    }
    if (selectedEntitlementId !== selected.entitlement_id) {
      setSelectedEntitlementId(selected.entitlement_id);
      setCreatorAgent(creatorAgentFromEntitlement(selected));
      setEntitlementError("");
    }
  }, [creatorAgentEntitlements, selectedEntitlementId, signedIn, windowContextReady]);

  useEffect(() => {
    if (!settingsReady || !windowContextReady || !signedIn || !buyerSession?.profile?.id) return;
    let cancelled = false;
    const profileId = buyerSession.profile.id;
    setWindowStateRestored(false);
    const windowContext = windowContextRef.current;
    const openedFromConversationWindow = Boolean(requestedConversationIdRef.current);
    const savedWorkspaceGrant = normalizeWorkspaceGrant(windowContext.workspaceGrant)
      || (!openedFromConversationWindow ? normalizeWorkspaceGrant(getProfileSetting("workspace_grant", null)) : null);
    const legacySavedWorkspace = getProfileSetting("workspace_root", "");
    const storedConversationId = getConversationId(
      buyerProfile.id,
      selectedEntitlementId,
      "desktop-chat"
    );
    const savedConversationId = restorableConversationId(storedConversationId);
    const storedWindowConversationId = typeof windowContext.conversationId === "string"
      ? windowContext.conversationId.trim()
      : "";
    const windowConversationId = restorableConversationId(storedWindowConversationId, "");
    const savedRun = parseStoredJson(windowContext.activeRun)
      || (!openedFromConversationWindow ? parseStoredJson(getProfileSetting("active_run", null)) : null);
    const dismissedRunId = typeof windowContext.dismissedRunId === "string"
      ? windowContext.dismissedRunId.trim()
      : "";
    const restorableRun = savedRun?.runId
      && !isTerminalRunStatus(savedRun.status)
      && savedRun.runId !== dismissedRunId
      ? savedRun
      : null;
    const savedPermission = windowContext.permissionMode || getProfileSetting("permission_mode");
    const nextPermission = normalizePermissionPolicy(savedPermission);
    if (savedPermission !== nextPermission) {
      setProfileSetting("permission_mode", nextPermission);
    }
    setWorkspace("");
    workspaceRef.current = "";
    workspaceGrantRef.current = null;
    setWorkspaceGrant(null);
    setWorkspaceDraft(savedWorkspaceGrant?.display_path || "");
    setWorkspaceDraftGrant(savedWorkspaceGrant);
    setComposerDraftValue(typeof windowContext.composerDraft === "string" ? windowContext.composerDraft : "");
    viewportScrollTopRef.current = Number.isFinite(Number(windowContext.scrollTop))
      ? Math.max(0, Number(windowContext.scrollTop))
      : 0;
    setWorkspaceGranted(false);
    setConversationId(requestedConversationIdRef.current || windowConversationId || savedConversationId);
    permissionRef.current = nextPermission;
    setPermissionMode(nextPermission);
    if (restorableRun) {
      activeRunRef.current = restorableRun;
      setInterruptedRun(restorableRun);
      setStatus("Task paused — restoring connection");
    } else {
      activeRunRef.current = null;
      setInterruptedRun(null);
    }
    async function restoreWorkspace() {
      let legacyClearFailed = false;
      if (legacySavedWorkspace) {
        try {
          await settingsStoreRef.current.clearProfileKey(profileId, "workspace_root");
        } catch {
          legacyClearFailed = true;
          if (!cancelled) setStatus("Choose your previous workspace again. Hatch couldn't clear the legacy path and will retry next launch.");
        }
      }
      const restored = await validateRestoredWorkspace(savedWorkspaceGrant, (grantId) => invokeTauri("ensure_workspace", {
        workspaceGrantId: grantId
      }));
      if (cancelled) return;
      if (restored.state === "valid") {
        setWorkspace(restored.workspace);
        workspaceRef.current = restored.workspace;
        workspaceGrantRef.current = restored.grant;
        setWorkspaceGrant(restored.grant);
        setWorkspaceDraft(restored.workspace);
        setWorkspaceDraftGrant(restored.grant);
        setWorkspaceGranted(true);
        if (restored.workspace !== savedWorkspaceGrant?.display_path) {
          persistWorkspaceGrant(restored.grant, profileId);
        }
        return;
      }
      setWorkspace("");
      workspaceRef.current = "";
      workspaceGrantRef.current = null;
      setWorkspaceGrant(null);
      setWorkspaceGranted(false);
      if (restored.state === "stale") {
        setWorkspaceDraft("");
        setWorkspaceDraftGrant(null);
        try {
          await Promise.all([
            !shouldPersistWorkspaceToProfile(conversationWindowRef.current)
              ? Promise.resolve()
              : settingsStoreRef.current.clearProfileKey(profileId, "workspace_grant"),
            invokeTauri("revoke_workspace_grant", { workspaceGrantId: restored.staleGrant.grant_id })
          ]);
          patchWindowContext({ workspaceGrant: null });
          if (!cancelled) setStatus(restored.status);
        } catch {
          if (!cancelled) setStatus(`${restored.status} Hatch couldn't clear the stale saved path; it will retry next launch.`);
        }
      } else if (!cancelled && !restorableRun) {
        setStatus(legacySavedWorkspace
          ? legacyClearFailed
            ? "Choose your previous workspace again. Hatch couldn't clear the legacy path and will retry next launch."
            : "Choose your previous workspace again so macOS can grant Hatch access from the folder picker."
          : restored.status);
      }
    }
    void restoreWorkspace().finally(() => {
      if (!cancelled) setWindowStateRestored(true);
    });
    return () => { cancelled = true; };
  }, [buyerProfile.id, buyerSession?.profile?.id, selectedEntitlementId, settingsReady, signedIn, windowContextReady]);

  // Persist only after the native window context has been read and the
  // workspace restore attempt has completed. This prevents the first React
  // render's defaults from overwriting another window's saved context.
  useEffect(() => {
    if (!windowContextReady || !windowStateRestored || !signedIn) return;
    patchWindowContext({
      conversationId,
      ...(conversationBindingFor() || {}),
      workspaceGrant,
      permissionMode,
      draft: workspaceDraft,
      activeRun: activeRunRef.current,
      conversationCursor: conversationCursorRef.current,
      scrollTop: viewportScrollTopRef.current
    });
  }, [conversationId, permissionMode, signedIn, windowContextReady, windowStateRestored, workspaceDraft, workspaceGrant]);

  useEffect(() => {
    if (!windowContextReady || !windowStateRestored || !signedIn) return undefined;
    const applyScroll = () => {
      if (viewportRef.current) viewportRef.current.scrollTop = viewportScrollTopRef.current;
    };
    const frame = window.requestAnimationFrame(applyScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [messages, signedIn, windowContextReady, windowStateRestored]);

  useEffect(() => () => {
    window.clearTimeout(viewportScrollPersistTimerRef.current);
    viewportScrollPersistTimerRef.current = null;
    if (windowContextReady && signedIn) {
      patchWindowContext({ scrollTop: viewportScrollTopRef.current });
    }
  }, [signedIn, windowContextReady]);

  // Composer text is user data, but unlike the workspace onboarding draft it
  // belongs to the active window session. Debounce app-data writes so normal
  // typing does not turn into one synchronous native file write per keypress;
  // flush on teardown/beforeunload so a quick close still keeps the draft.
  useEffect(() => {
    if (!windowContextReady || !windowStateRestored || !signedIn) return undefined;
    const timer = window.setTimeout(() => {
      patchWindowContext({ composerDraft: composerDraftRef.current });
    }, 180);
    const flush = () => patchWindowContext({ composerDraft: composerDraftRef.current });
    window.addEventListener("beforeunload", flush);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [composerDraft, signedIn, windowContextReady, windowStateRestored]);

  // Window geometry is machine-local and intentionally separate from the
  // cloud Conversation. Rust namespaces this state by the invoking native
  // window label, so concurrent windows patch only their own entry.
  useEffect(() => {
    if (!settingsReady || !signedIn || !buyerSession?.profile?.id) {
      setWindowLayoutReady(false);
      return;
    }
    let cancelled = false;
    setWindowLayoutReady(false);
    void invokeTauri("read_window_settings").then((saved) => {
      if (cancelled) return;
      const next = normalizeWindowLayoutPreferences(saved?.layout);
      setSidebarPreference(next.sidebarPreference);
      setSidebarWidth(next.sidebarWidth);
      setInspectorPreference(next.inspectorPreference);
      setInspectorWidth(next.inspectorWidth);
      setApplicationZoom(next.zoom);
      setWindowLayoutReady(true);
    }).catch(() => {
      if (!cancelled) setWindowLayoutReady(true);
    });
    return () => { cancelled = true; };
  }, [buyerSession?.profile?.id, settingsReady, signedIn]);

  useEffect(() => {
    if (!windowLayoutReady || !signedIn || !buyerSession?.profile?.id) return;
    void invokeTauri("patch_window_settings", {
      patch: {
        layout: {
        sidebarPreference,
        sidebarWidth,
        inspectorPreference,
        inspectorWidth,
        zoom: normalizeZoom(applicationZoom)
        }
      }
    }).catch(() => {});
  }, [applicationZoom, buyerSession?.profile?.id, inspectorPreference, inspectorWidth, sidebarPreference, sidebarWidth, signedIn, windowLayoutReady]);

  // Tauri's supported Window APIs expose physical outer geometry. Persist it
  // independently of auth so a signed-out launch still restores the user's
  // frame, then clamp it to a currently connected monitor before applying it.
  // This mirrors native window-state behavior without reparenting the WebView
  // or depending on an unstable plugin API.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let cancelled = false;
    let resizeUnlisten = null;
    let moveUnlisten = null;
    let debounceTimer = null;
    const appWindow = getCurrentWindow();

    const persistFrame = async ({ force = false } = {}) => {
      // A close can arrive during the debounce window. Flush one last read
      // before marking the effect cancelled so the user's final resize/move
      // is not lost merely because the WebView is being torn down.
      if (cancelled && !force) return;
      try {
        const [position, size] = await Promise.all([
          appWindow.outerPosition(),
          appWindow.outerSize()
        ]);
        if (cancelled && !force) return;
        await invokeTauri("patch_window_settings", {
          patch: {
            frame: {
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height
            }
          }
        });
      } catch {
        // Geometry persistence is best effort; the OS still owns the live
        // frame and a transient display/API failure must not affect the chat.
      }
    };
    const schedulePersist = () => {
      if (debounceTimer) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void persistFrame();
      }, 180);
    };
    const bind = async () => {
      try {
        const saved = await invokeTauri("read_window_settings");
        const savedFrame = normalizeWindowFrame(saved?.frame);
        if (!cancelled && savedFrame) {
          const monitors = await availableMonitors();
          const frame = clampWindowFrame(savedFrame, monitors);
          await appWindow.setSize(new PhysicalSize(frame.width, frame.height));
          await appWindow.setPosition(new PhysicalPosition(frame.x, frame.y));
        }
      } catch {
        // A first launch or an unavailable monitor API simply uses the config
        // defaults; it must not prevent the renderer from mounting.
      }
      if (cancelled) return;
      resizeUnlisten = await appWindow.onResized(schedulePersist);
      moveUnlisten = await appWindow.onMoved(schedulePersist);
      if (cancelled) {
        resizeUnlisten?.();
        moveUnlisten?.();
      }
    };
    void bind();
    return () => {
      void persistFrame({ force: true });
      cancelled = true;
      if (debounceTimer) window.clearTimeout(debounceTimer);
      resizeUnlisten?.();
      moveUnlisten?.();
    };
  }, []);

  // Cmd/Ctrl +/-/0 is an application command, not browser page zoom. It is
  // kept in the same per-window settings object as pane widths so each
  // conversation window can have its own readable scale.
  useEffect(() => {
    if (!windowLayoutReady) return undefined;
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key;
      if (!["=", "+", "-", "0"].includes(key)) return;
      event.preventDefault();
      if (key === "0") {
        setApplicationZoom(DESKTOP_ZOOM.default);
      } else {
        setApplicationZoom((current) => nextZoom(current, key === "-" ? "decrease" : "increase"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [windowLayoutReady]);

  useEffect(() => {
    if (!windowLayoutReady) return undefined;
    const zoom = normalizeZoom(applicationZoom);
    if (window.__TAURI_INTERNALS__) {
      void getCurrentWebview().setZoom(zoom).catch(() => {});
    } else if (typeof document !== "undefined") {
      document.documentElement.style.zoom = String(zoom);
    }
    return undefined;
  }, [applicationZoom, windowLayoutReady]);

  useEffect(() => () => {
    intentionalDisconnectRef.current = true;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    socketRef.current?.close();
    void cancelPendingLocalTools("transport_failure");
  }, []);

  useEffect(() => {
    if (!signedIn || !workspaceGranted || !workspaceGrant?.grant_id || !selectedEntitlementId) return;
    if (!canConnectConversation({ libraryStatus: conversationLibraryStatus, conversationId })) return;
    const entitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId);
    const desiredBinding = runtimeBindingForEntitlement(entitlement);
    const hasConnection = connectedRef.current || socketRef.current || connectingRef.current;
    if (hasConnection && runtimeBindingMatches(connectionConfigRef.current, desiredBinding)) return;
    if (hasConnection) disconnectRuntime();
    void connectRuntime({
      workspaceGrant,
      conversationId,
      entitlementId: desiredBinding?.entitlementId,
      agentId: desiredBinding?.agentId,
      creatorId: desiredBinding?.creatorId,
      preserveMessages: true
    });
  }, [connected, conversationId, conversationLibraryStatus, creatorAgentEntitlements, selectedEntitlementId, signedIn, workspaceGrant, workspaceGranted]);

  function scheduleRuntimeReconnect() {
    if (intentionalDisconnectRef.current || reconnectTimerRef.current || !connectionConfigRef.current) return;
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(10_000, 800 * 2 ** Math.min(attempt, 4));
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void connectRuntime({ ...connectionConfigRef.current, preserveMessages: true });
    }, delay);
  }

  function retryRuntimeConnection() {
    if (connectedRef.current || connectingRef.current) return;
    const retryConnection = connectionConfigRef.current ?? {
      serverUrl,
      workspaceGrant,
      conversationId,
      entitlementId: selectedEntitlementId,
      agentId: creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId)?.agent_id,
      creatorId: creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId)?.creator_id
    };
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    connectionTokenRef.current += 1;
    intentionalDisconnectRef.current = true;
    const staleSocket = socketRef.current;
    socketRef.current = null;
    staleSocket?.close();
    connectedRef.current = false;
    setConnected(false);
    setStatus("Restoring connection…");
    void connectRuntime({ ...retryConnection, preserveMessages: true });
  }

  function projectDurableSnapshotRun(snapshot, targetWorkspaceGrant) {
    // Keep the pre-snapshot local identity stable while reconciling. If this
    // window's saved Run is already terminal, do not clear it and then
    // accidentally adopt an unrelated historical interrupted Run from the
    // same Conversation.
    const activeRunBeforeSnapshot = activeRunRef.current;
    const activeRunId = String(activeRunBeforeSnapshot?.runId || "").trim();
    const durableRun = activeRunId && Array.isArray(snapshot?.runs)
      ? snapshot.runs.find((run) => String(run?.id ?? run?.run_id ?? "").trim() === activeRunId)
      : null;
    if (durableRun && isTerminalRunStatus(durableRun.status)) {
      // A renderer can close after the server has already completed or
      // cancelled a Run. Clear the optimistic recovery projection before it
      // permanently blocks the next Composer turn.
      activeRunRef.current = null;
      setInterruptedRun(null);
      setRunning(false);
      setLegacyProfileActiveRun(undefined);
      patchWindowContext({ activeRun: null, dismissedRunId: null });
    }
    const interruptedSnapshotRun = interruptedRunFromSnapshot(
      snapshot,
      durableRun && isTerminalRunStatus(durableRun.status)
        ? activeRunBeforeSnapshot
        : activeRunRef.current,
      windowContextRef.current.dismissedRunId
    );
    if (!interruptedSnapshotRun) return;
    const recoveredRun = activeRunRef.current?.runId === interruptedSnapshotRun.runId
      ? interruptedSnapshotRun
      : {
          ...interruptedSnapshotRun,
          accessSnapshot: createTurnAccessSnapshot(
            workspaceGrantRef.current?.grant_id || targetWorkspaceGrant?.grant_id,
            workspaceRef.current || targetWorkspaceGrant?.display_path || "",
            permissionRef.current
          )
        };
    activeRunRef.current = recoveredRun;
    setInterruptedRun(recoveredRun);
    setRunning(false);
    setStatus("Task interrupted — your work is safe");
    patchWindowContext({ activeRun: recoveredRun, dismissedRunId: null });
  }

  async function reconcileLiveSnapshot(socket, requestToken) {
    const config = connectionConfigRef.current;
    if (!config || socketRef.current !== socket || requestToken !== connectionTokenRef.current) return;
    try {
      // The initial HTTP snapshot and WebSocket hello have a small race: a
      // server event can land between them. Read the journal again after the
      // authenticated socket is ready, using the cursor already projected.
      const snapshot = await getConversationSnapshot(
        config.serverUrl,
        buyerSession.accessToken,
        {
          entitlementId: config.entitlementId,
          agentId: config.agentId,
          creatorId: config.creatorId
        },
        config.conversationId,
        conversationCursorRef.current
      );
      if (socketRef.current !== socket || requestToken !== connectionTokenRef.current) return;
      const reconciled = reconcileConversationSnapshot(snapshot, {
        afterCursor: conversationCursorRef.current
      });
      // The Runtime returns the complete canonical message projection even
      // for an after_cursor request. Replacing the local projection removes
      // optimistic duplicates without replaying tools or assistant effects.
      setMessages(reconciled.messages.map(historyMessageToThreadMessage));
      projectDurableSnapshotRun(snapshot, config.workspaceGrant);
      if (reconciled.cursor > conversationCursorRef.current) {
        conversationCursorRef.current = reconciled.cursor;
        patchWindowContext({ conversationCursor: reconciled.cursor });
      }
    } catch (error) {
      if (socketRef.current !== socket || requestToken !== connectionTokenRef.current) return;
      if (error?.code === "snapshot_invalid") {
        setStatus("Conversation recovery could not be verified. Reconnect to continue.");
      }
    }
  }

  async function connectRuntime(connection = {}) {
    if (connectedRef.current || socketRef.current || connectingRef.current) return;
    const targetServerUrl = connection.serverUrl || serverUrl;
    const targetWorkspaceGrant = normalizeWorkspaceGrant(connection.workspaceGrant) || workspaceGrant;
    const targetConversationId = connection.conversationId || conversationId;
    const targetEntitlementId = connection.entitlementId || selectedEntitlementId;
    const selectedEntitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === targetEntitlementId);
    const targetAgentId = connection.agentId || selectedEntitlement?.agent_id;
    const targetCreatorId = connection.creatorId || selectedEntitlement?.creator_id;
    if (!canConnectConversation({
      libraryStatus: conversationLibraryStatus,
      conversationId: targetConversationId
    })) {
      setStatus(conversationLibraryStatus === "unavailable"
        ? "Conversation Library unavailable. Hatch will not connect an unverified Conversation."
        : "Preparing your Conversation Library…");
      return;
    }
    if (!targetServerUrl.trim() || !targetWorkspaceGrant?.grant_id || !buyerSession?.accessToken || !targetEntitlementId) {
      setStatus("Choose a folder before starting the connection.");
      return;
    }

    const requestToken = ++connectionTokenRef.current;
    connectingRef.current = true;
    intentionalDisconnectRef.current = false;
    connectionConfigRef.current = {
      serverUrl: targetServerUrl.trim(),
      workspaceGrant: targetWorkspaceGrant,
      conversationId: targetConversationId.trim() || "desktop-chat",
      entitlementId: targetEntitlementId,
      ...(targetAgentId ? { agentId: targetAgentId } : {}),
      ...(targetCreatorId ? { creatorId: targetCreatorId } : {})
    };
    // Legacy `desktop-chat` remains read-only during Runtime rollout. Never
    // persist it over a server-issued Conversation selected by the Library.
    if (isServerConversationId(targetConversationId)) {
      setConversationIdForEntitlement(buyerProfile.id, targetEntitlementId, targetConversationId.trim());
    }

    let normalizedWorkspaceGrant;
    try {
      normalizedWorkspaceGrant = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
        workspaceGrantId: targetWorkspaceGrant.grant_id
      }));
      // A newer Conversation/Agent selection may have invalidated this
      // request while the native grant was being revalidated. Never let an
      // older request write workspace, cursor, or message state into it.
      if (requestToken !== connectionTokenRef.current) return;
      if (!normalizedWorkspaceGrant) throw new Error("The native workspace grant is invalid.");
      setWorkspace(normalizedWorkspaceGrant.display_path);
      workspaceRef.current = normalizedWorkspaceGrant.display_path;
      workspaceGrantRef.current = normalizedWorkspaceGrant;
      setWorkspaceGrant(normalizedWorkspaceGrant);
      connectionConfigRef.current.workspaceGrant = normalizedWorkspaceGrant;
      persistWorkspaceGrant(normalizedWorkspaceGrant);
      setStatus("Loading history...");
      const activeConversationId = targetConversationId.trim() || "desktop-chat";
      let history;
      let snapshotLoaded = false;
      let snapshotCursor = null;
      try {
        const snapshot = await getConversationSnapshot(
          targetServerUrl.trim(),
          buyerSession.accessToken,
          {
            entitlementId: targetEntitlementId,
            agentId: targetAgentId,
            creatorId: targetCreatorId
          },
          activeConversationId,
          conversationCursorRef.current
        );
        if (requestToken !== connectionTokenRef.current) return;
        const reconciledSnapshot = reconcileConversationSnapshot(snapshot, {
          afterCursor: conversationCursorRef.current
        });
        history = reconciledSnapshot.messages;
        snapshotCursor = reconciledSnapshot.cursor;
        projectDurableSnapshotRun(snapshot, targetWorkspaceGrant);
        snapshotLoaded = true;
      } catch (snapshotError) {
        // A malformed journal is an integrity failure, not a rollout/version
        // miss. Do not silently downgrade it to the legacy history endpoint;
        // that could display an incomplete projection while hiding the fact
        // that the cursor boundary was not safely reconciled.
        if (snapshotError?.code === "snapshot_invalid") throw snapshotError;
        // Keep old Runtime history readable during the P2 rollout. A P2
        // Runtime will normally take the snapshot branch; the legacy route is
        // read-only compatibility and never creates a Conversation.
        history = await loadConversationHistory(
          targetServerUrl.trim(),
          activeConversationId,
          targetEntitlementId,
          buyerSession.accessToken,
          { agentId: targetAgentId, creatorId: targetCreatorId }
        ).catch(() => {
          throw snapshotError;
        });
        if (requestToken !== connectionTokenRef.current) return;
      }
      if (requestToken !== connectionTokenRef.current) return;
      // A snapshot is the canonical observer recovery boundary. Replacing
      // the local projection after reconnect prevents optimistic user/assistant
      // placeholders from being duplicated when a socket closes mid-turn.
      if (snapshotLoaded || !connection.preserveMessages || messages.length === 0) {
        setMessages(history.map(historyMessageToThreadMessage));
      }
      if (snapshotCursor !== null && requestToken === connectionTokenRef.current) {
        // Persist the cursor only after the corresponding snapshot projection
        // has been installed, so a crash cannot claim events were rendered
        // before their messages/run state reached the UI.
        conversationCursorRef.current = snapshotCursor;
        patchWindowContext({ conversationCursor: snapshotCursor });
      }
      setStatus("Connecting...");
    } catch (error) {
      if (requestToken === connectionTokenRef.current) {
        if (isInvalidWorkspaceGrantError(error)) {
          workspaceRef.current = "";
          workspaceGrantRef.current = null;
          connectionConfigRef.current = null;
          intentionalDisconnectRef.current = true;
          setWorkspace("");
          setWorkspaceDraft("");
          setWorkspaceGrant(null);
          setWorkspaceDraftGrant(null);
          setWorkspaceGranted(false);
          setStatus("Workspace access is no longer available. Choose the folder again to continue.");
          void Promise.allSettled([
            settingsStoreRef.current.clearProfileKey(buyerProfile.id, "workspace_grant"),
            invokeTauri("revoke_workspace_grant", { workspaceGrantId: targetWorkspaceGrant.grant_id })
          ]);
        } else {
          setStatus(`Connection unavailable — ${errorMessage(error)}`);
          scheduleRuntimeReconnect();
        }
      }
      return;
    } finally {
      if (requestToken === connectionTokenRef.current) connectingRef.current = false;
    }

    if (requestToken !== connectionTokenRef.current || intentionalDisconnectRef.current) return;

    const socket = new WebSocket(targetServerUrl.trim());
    socketRef.current = socket;
    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) return;
      socket.send(JSON.stringify({
        type: "client.hello",
        protocol_version: PROTOCOL_VERSION,
        installation_id: "desktop-local-install",
        auth_token: buyerSession.accessToken,
        entitlement_id: targetEntitlementId,
        ...(targetAgentId ? { agent_id: targetAgentId } : {}),
        ...(targetCreatorId ? { creator_id: targetCreatorId } : {}),
        client_version: "0.1.0",
        local_tools: [...PLATFORM_LOCAL_TOOLS],
      }));
    });
    socket.addEventListener("message", (event) => {
      if (socketRef.current !== socket) return;
      try {
        void handleRuntimeMessage(JSON.parse(event.data), socket, requestToken).catch(() => {
          if (isCurrentRuntimeTransport(socket, requestToken)) {
            setStatus("Connection sent an invalid response. Restoring your session…");
          }
        });
      } catch {
        // A malformed frame is untrusted transport input. Keep the current
        // connection alive long enough for its normal close/reconnect path;
        // never let parsing a stale frame tear down the React render loop.
        if (isCurrentRuntimeTransport(socket, requestToken)) {
          setStatus("Connection sent an invalid response. Restoring your session…");
        }
      }
    });
    socket.addEventListener("error", () => {
      if (socketRef.current !== socket) return;
      setStatus("Connection problem. Your work has been kept.");
      void cancelPendingLocalTools("transport_failure").then((stopped) => {
        if (!stopped && isCurrentRuntimeTransport(socket, requestToken)) {
          setStatus(LOCAL_TOOL_STOP_UNCONFIRMED);
        }
      });
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      textRevealRef.current?.flush(activeRunRef.current?.runId);
      rejectPendingApprovals();
      void cancelPendingLocalTools("transport_failure").then((stopped) => {
        if (!stopped && isCurrentRuntimeTransport(socket, requestToken)) {
          setStatus(LOCAL_TOOL_STOP_UNCONFIRMED);
        }
      });
      socketRef.current = null;
      connectedRef.current = false;
      setConnected(false);
      setRunning(false);
      if (activeRunRef.current) {
        setInterruptedRun(activeRunRef.current);
      }
      if (!intentionalDisconnectRef.current) {
        setStatus("Connection lost — restoring your session…");
        scheduleRuntimeReconnect();
      } else {
        setStatus(activeRunRef.current ? "Task paused — your work has been kept" : "Offline");
      }
    });
  }

  function disconnectRuntime() {
    textRevealRef.current?.flush(activeRunRef.current?.runId);
    intentionalDisconnectRef.current = true;
    const disconnectToken = ++connectionTokenRef.current;
    connectingRef.current = false;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    rejectPendingApprovals();
    void cancelPendingLocalTools("transport_failure").then((stopped) => {
      if (!stopped && connectionTokenRef.current === disconnectToken) {
        setStatus(LOCAL_TOOL_STOP_UNCONFIRMED);
      }
    });
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    connectedRef.current = false;
    setConnected(false);
    setRunning(false);
    setStatus(activeRunRef.current ? "Task paused — your work has been kept" : "Offline");
  }

  async function handleRuntimeMessage(message, sourceSocket = socketRef.current, sourceToken = connectionTokenRef.current) {
    if (!isCurrentRuntimeTransport(sourceSocket, sourceToken)) return;
    if (message.type === "session.ready") {
      const selectedEntitlement = creatorAgentEntitlements.find(
        (entitlement) => entitlement.entitlement_id === selectedEntitlementId
      );
      setCreatorAgent((current) => creatorAgentFromBoundSession(
        message,
        selectedEntitlement,
        current
      ));
      connectedRef.current = true;
      reconnectAttemptRef.current = 0;
      setConnected(true);
      setStatus("Ready");
      const socket = socketRef.current;
      if (socket) {
        await reconcileLiveSnapshot(socket, sourceToken);
      }
      return;
    }

    const revealBoundary = textRevealBoundary(message);
    if (revealBoundary === "flush") {
      textRevealRef.current?.flush(message.run_id);
    } else if (revealBoundary === "discard") {
      textRevealRef.current?.discard(message.run_id);
    }

    if (message.type === "assistant.delta") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      if (message.delta.kind === "text") {
        const projection = projectApprovedRuntimeStream(activeRunRef.current, message);
        if (!projection) return;
        activeRunRef.current = projection.activeRun;
        textRevealRef.current?.enqueue({
          runId: message.run_id,
          assistantId: projection.assistantId,
          content: projection.content
        });
      } else {
        setStatus(message.delta.content);
        updateAssistantMetadataForRun(message.run_id, {
          latestStatus: message.delta.content
        });
      }
      return;
    }

    if (message.type === "turn.state") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      setStatus(message.status);
      updateAssistantMetadataForRun(message.run_id, {
        runtimeStatus: message.status
      });
      return;
    }

    if (message.type === "approval.request" || message.type === "approval.result") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      upsertToolEvent(toolEventFromApproval(message));
      setStatus(message.type === "approval.request"
        ? `Approval requested: ${message.name}`
        : `Approval ${message.status}: ${message.name}`);
      return;
    }

    if (message.type === "tool_call.delta") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      upsertToolEvent(message);
      return;
    }

    if (message.type === "tool_call.request") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      upsertToolEvent({
        ...message,
        locality: "client",
        status: "requested"
      });
      await handleToolRequest(message, {
        socket: sourceSocket,
        requestToken: sourceToken
      });
      return;
    }

    if (message.type === "skill.activated" || message.type === "skill.invoked") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      upsertSkillEvent(message);
      setStatus(`${message.status === "activated" ? "Creator method ready" : "Creator method applied"}: ${message.name}`);
      return;
    }

    if (message.type === "skill.run") {
      if (!message.run_id || activeRunRef.current?.runId !== message.run_id) return;
      upsertSkillRun(message);
      setStatus(skillRunStatusLabel(message));
      return;
    }

    if (message.type === "session.compacted") {
      setStatus("Conversation optimized");
      return;
    }

    if (message.type === "turn.completed") {
      const sourceRun = activeRunRef.current;
      if (!message.run_id || !sourceRun || sourceRun.runId !== message.run_id) return;
      const localToolsStopped = await cancelPendingLocalTools("turn_completed", message.run_id);
      if (!isCurrentRuntimeTransport(sourceSocket, sourceToken) || activeRunRef.current?.runId !== sourceRun.runId) return;
      const projection = projectApprovedRuntimeStream(sourceRun, message);
      if (!projection) return;
      activeRunRef.current = projection.activeRun;
      const finishVisibleTurn = () => {
        if (activeRunRef.current?.runId !== projection.runId) return;
        if (projection.finishReason === "content_filter") {
          finishAssistant(projection.assistantId, OUTPUT_FILTERED_COPY, "content_filter");
        } else {
          finishAssistant(projection.assistantId, projection.text, "completed");
        }
        saveAssistantTiming(
          projection.assistantId,
          projection.runId,
          projection.activeRun.timing,
          Date.now()
        );
        activeRunRef.current = null;
        setLegacyProfileActiveRun(undefined);
        patchWindowContext({ activeRun: null, dismissedRunId: null });
        setInterruptedRun(null);
        setRunning(false);
        setStatus(statusAfterLocalToolStop("Completed", localToolsStopped));
      };
      if (projection.finishReason === "content_filter") {
        finishVisibleTurn();
      } else if (textRevealRef.current) {
        textRevealRef.current.complete(message.run_id, finishVisibleTurn);
      } else {
        finishVisibleTurn();
      }
      return;
    }

    if (message.type === "turn.failed") {
      const sourceRun = activeRunRef.current;
      if (!message.run_id || !sourceRun || sourceRun.runId !== message.run_id) return;
      const localToolsStopped = await cancelPendingLocalTools("turn_failed", message.run_id);
      if (!isCurrentRuntimeTransport(sourceSocket, sourceToken) || activeRunRef.current?.runId !== sourceRun.runId) return;
      const activeRun = sourceRun;
      const text = `Run failed: ${message.error?.message || "Unknown error"}`;
      if (activeRun) {
        finishAssistant(activeRun.assistantId, text, "failed");
      } else {
        setMessages((current) => [
          ...current,
          makeAssistantMessage(`error_${Date.now()}`, text, {
            status: "failed"
          })
        ]);
      }
      activeRunRef.current = null;
      setLegacyProfileActiveRun(undefined);
      patchWindowContext({ activeRun: null, dismissedRunId: null });
      setInterruptedRun(null);
      setRunning(false);
      setStatus(statusAfterLocalToolStop("Failed", localToolsStopped));
    }
  }

  async function handleToolRequest(message, transport = {}) {
    const sourceSocket = transport.socket;
    const sourceToken = transport.requestToken;
    const isTransportCurrent = () => isCurrentRuntimeTransport(sourceSocket, sourceToken)
      && activeRunRef.current?.runId === message.run_id;
    if (!isTransportCurrent()) return;
    try {
      // NativeToolAuthority derives the current window's opaque grant and
      // Ask/Allow policy. This request is untrusted input, not authority.
      const result = await invokeLocalToolCall(message, isTransportCurrent);
      if (!isTransportCurrent()) return;
      sendRuntimeMessage(sourceSocket, sourceToken, result);
    } catch (error) {
      if (!isTransportCurrent()) return;
      const localError = {
        code: ["local_tool_timeout", "local_tool_cancelled", "local_tool_cancel_failed"].includes(error?.code)
          ? error.code
          : "local_runner_error",
        message: errorMessage(error)
      };
      if (localError.code === "local_tool_cancel_failed") {
        setStatus("Hatch couldn't confirm that the local tool stopped. Check the workspace before continuing.");
      } else if (localError.code === "local_tool_timeout") {
        setStatus("Local tool timed out and was stopped.");
      }
      upsertToolEvent({
        ...message,
        locality: "client",
        status: "failed",
        error: localError
      });
      sendRuntimeMessage(sourceSocket, sourceToken, {
        type: "tool_call.result",
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        status: "error",
        error: localError
      });
    }
  }

  function invokeLocalToolCall(message, isTransportCurrent = () => true) {
    const request = { ...message };
    const deadlineMs = localToolTransportDeadlineMs(request);
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancellationPromise = null;
      let pollTimer;
      let deadlineTimer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(pollTimer);
        window.clearTimeout(deadlineTimer);
        approvalResolversRef.current.delete(request.tool_call_id);
        if (pendingLocalToolsRef.current.get(request.tool_call_id)?.request === request) {
          pendingLocalToolsRef.current.delete(request.tool_call_id);
        }
        callback(value);
      };
      const cancel = (reason) => {
        if (settled) return Promise.resolve(true);
        if (cancellationPromise) return cancellationPromise;
        cancellationPromise = (async () => {
          try {
            const acknowledged = await invokeTauri("cancel_tool_call", {
              toolCallId: request.tool_call_id
            });
            if (!acknowledged) {
              const completed = await invokeTauri("poll_tool_call", {
                toolCallId: request.tool_call_id
              });
              if (completed) {
                finish(resolve, completed);
                return true;
              }
              const missing = new Error(`Native local tool job was not found: ${request.tool_call_id}`);
              missing.code = "local_tool_cancel_failed";
              throw missing;
            }
            const completed = await invokeTauri("poll_tool_call", {
              toolCallId: request.tool_call_id
            }).catch(() => null);
            // A non-shell file operation may commit between the cancel signal
            // and its next safe point. Preserve that honest native result
            // instead of falsely claiming the operation was stopped.
            const committed = committedResultAfterCancellation(completed);
            if (committed) {
              finish(resolve, committed);
              return true;
            }
            finish(reject, localToolCancellationError(request, reason, deadlineMs));
            return true;
          } catch (error) {
            const cancellationError = error instanceof Error ? error : new Error(errorMessage(error));
            if (!cancellationError.code) cancellationError.code = "local_tool_cancel_failed";
            finish(reject, cancellationError);
            throw cancellationError;
          }
        })();
        return cancellationPromise;
      };
      const poll = async () => {
        if (settled) return;
        try {
          const result = await invokeTauri("poll_tool_call", {
            toolCallId: request.tool_call_id
          });
          if (result) {
            finish(resolve, result);
            return;
          }
        } catch (error) {
          finish(reject, error);
          return;
        }
        pollTimer = window.setTimeout(poll, 100);
      };

      pendingLocalToolsRef.current.set(request.tool_call_id, {
        request,
        runId: request.run_id,
        cancel
      });
      deadlineTimer = window.setTimeout(() => {
        void cancel("timeout").catch(() => {});
      }, deadlineMs);

      invokeTauri("execute_tool_call", { request }).then((submission) => {
        if (!isTransportCurrent()) {
          void cancel("transport_failure").catch(() => {});
          return;
        }
        if (submission?.status === "approval_required") {
          // The visual inline gate is only a projection of the native pending
          // record. The renderer cannot manufacture approval metadata; its
          // action names an already-recorded call in this WebviewWindow.
          void requestToolApproval(request).then(async (approved) => {
            if (!isTransportCurrent()) {
              finish(reject, localToolCancellationError(request, "transport_failure", deadlineMs));
              return;
            }
            try {
              await invokeTauri(approved ? "approve_pending_tool_call" : "deny_pending_tool_call", {
                toolCallId: request.tool_call_id
              });
            } catch (error) {
              finish(reject, error);
            }
          });
        }
        poll();
      }).catch((error) => finish(reject, error));
    });
  }

  async function cancelPendingLocalTools(reason, runId = null) {
    const pending = [...pendingLocalToolsRef.current.values()]
      .filter((entry) => !runId || entry.runId === runId);
    if (pending.length === 0) return true;
    const outcomes = await Promise.allSettled(pending.map((entry) => entry.cancel(reason)));
    return outcomes.every((outcome) => outcome.status === "fulfilled");
  }

  async function grantWorkspace() {
    try {
      if (!workspaceDraftGrant?.grant_id) throw new Error("Choose a workspace folder before starting.");
      const normalized = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
        workspaceGrantId: workspaceDraftGrant.grant_id
      }));
      if (!normalized) throw new Error("The native workspace grant is invalid.");
      setWorkspace(normalized.display_path);
      workspaceRef.current = normalized.display_path;
      workspaceGrantRef.current = normalized;
      setWorkspaceGrant(normalized);
      setWorkspaceDraft(normalized.display_path);
      setWorkspaceDraftGrant(normalized);
      setWorkspaceGranted(true);
      persistWorkspaceGrant(normalized);
      setStatus("Folder access granted");
      await connectRuntime({ workspaceGrant: normalized, conversationId, preserveMessages: false });
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function chooseWorkspace({ activate = workspaceGranted } = {}) {
    try {
      const selected = await invokeTauri("pick_workspace_folder");
      const selection = workspacePickerSelection({
        workspace,
        draft: workspaceDraft,
        pendingGrant: workspaceDraftGrant,
        granted: workspaceGranted
      }, selected);
      if (!selection.changed) return;
      setWorkspaceDraft(selection.draft);
      setWorkspaceDraftGrant(selection.pendingGrant);
      if (activate) await switchWorkspace(selection.pendingGrant);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function switchWorkspace(nextWorkspaceGrant) {
    const candidate = normalizeWorkspaceGrant(nextWorkspaceGrant);
    if (!candidate) throw new Error("The folder picker did not return a native workspace grant.");
    const normalized = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
      workspaceGrantId: candidate.grant_id
    }));
    if (!normalized) throw new Error("The native workspace grant is invalid.");
    if (normalized.grant_id === workspaceGrant?.grant_id) return;

    setWorkspace(normalized.display_path);
    workspaceRef.current = normalized.display_path;
    workspaceGrantRef.current = normalized;
    setWorkspaceGrant(normalized);
    setWorkspaceDraft(normalized.display_path);
    setWorkspaceDraftGrant(normalized);
    setWorkspaceGranted(true);
    if (connectionConfigRef.current) {
      connectionConfigRef.current.workspaceGrant = normalized;
    }
    persistWorkspaceGrant(normalized);
    setStatus("Workspace updated for the next turn");
  }

  function mergeDroppedFiles(incoming) {
    const files = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
    if (files.length === 0) return [];
    const current = droppedFilesRef.current;
    const byId = new Map(current.map((file) => [file.contextId, file]));
    for (const file of files) byId.set(file.contextId, file);
    const next = [...byId.values()].slice(-8);
    const keep = new Set(next.map((file) => file.contextId));
    const evicted = [...byId.keys()].filter((contextId) => !keep.has(contextId));
    if (evicted.length > 0) void discardNativeDropContexts(evicted);
    droppedFilesRef.current = next;
    setDroppedFiles(next);
    return next;
  }

  function nativeDropStatus(files, rejectedFiles) {
    const acceptedCount = Array.isArray(files) ? files.length : 0;
    const rejected = Array.isArray(rejectedFiles) ? rejectedFiles.filter(Boolean) : [];
    const acceptedLabel = acceptedCount > 0
      ? `${acceptedCount} file${acceptedCount === 1 ? "" : "s"} ready as context`
      : "";
    if (rejected.length === 0) return acceptedLabel;
    const rejectedLabel = `${rejected.length} file${rejected.length === 1 ? "" : "s"} couldn't be attached`;
    const reason = typeof rejected[0]?.reason === "string" ? rejected[0].reason : "Try a UTF-8 text file under 1 MiB.";
    return acceptedLabel ? `${acceptedLabel}; ${rejectedLabel}` : `${rejectedLabel} — ${reason}`;
  }

  async function chooseContextFiles() {
    try {
      const result = await invokeTauri("pick_native_drop_files");
      const files = Array.isArray(result?.files)
        ? result.files.map(normalizeNativeDropFile).filter(Boolean)
        : [];
      const rejectedFiles = Array.isArray(result?.rejectedFiles) ? result.rejectedFiles : [];
      if (files.length > 0) mergeDroppedFiles(files);
      const message = nativeDropStatus(files, rejectedFiles);
      if (message) setStatus(message);
    } catch (error) {
      setStatus(`Couldn't attach files: ${errorMessage(error)}`);
    }
  }

  // Native drag/drop is intentionally a projection boundary: Rust turns
  // dropped directories into grants first, while files arrive as bounded
  // display metadata plus opaque one-shot context handles. No renderer path
  // is accepted as tool authority.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let unlisten;
    let cancelled = false;
    void listen("hatch://native-drop", ({ payload }) => {
      if (cancelled || !payload || typeof payload !== "object") return;
      const directories = Array.isArray(payload.directories) ? payload.directories : [];
      const files = Array.isArray(payload.files)
        ? payload.files.map(normalizeNativeDropFile).filter(Boolean)
        : [];
      const rejectedFiles = Array.isArray(payload.rejectedFiles) ? payload.rejectedFiles : [];
      if (files.length > 0) {
        mergeDroppedFiles(files);
      }
      const candidate = normalizeWorkspaceGrant(directories[0]);
      if (!candidate?.grant_id) {
        const message = nativeDropStatus(files, rejectedFiles);
        if (message) setStatus(message);
        return;
      }
      void (async () => {
        try {
          const normalized = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
            workspaceGrantId: candidate.grant_id
          }));
          if (!normalized) throw new Error("The dropped workspace grant is invalid.");
          setWorkspace(normalized.display_path);
          workspaceRef.current = normalized.display_path;
          workspaceGrantRef.current = normalized;
          setWorkspaceGrant(normalized);
          setWorkspaceDraft(normalized.display_path);
          setWorkspaceDraftGrant(normalized);
          setWorkspaceGranted(true);
          persistWorkspaceGrant(normalized);
          const dropStatus = nativeDropStatus(files, rejectedFiles);
          setStatus(dropStatus
            ? `Folder dropped — workspace access granted; ${dropStatus}`
            : "Folder dropped — workspace access granted");
          if (selectedEntitlementId) {
            await connectRuntime({ workspaceGrant: normalized, conversationId, preserveMessages: true });
          }
        } catch (error) {
          setStatus(errorMessage(error));
        }
      })();
    }).then((dispose) => {
      unlisten = dispose;
      if (cancelled) unlisten?.();
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [conversationId, selectedEntitlementId]);

  function updatePermissionMode(nextMode) {
    if (!PERMISSION_OPTIONS.some((mode) => mode.value === nextMode)) return;
    setPermissionMode(nextMode);
    setProfileSetting("permission_mode", nextMode);
    setStatus(`Permission updated for the next turn: ${permissionPolicyLabel(nextMode)}`);
  }

  async function createLibraryConversation({ allowActiveRun = false } = {}) {
    if (activeRunRef.current && !allowActiveRun) {
      setStatus("Stop or close the active task before starting another conversation.");
      return "";
    }
    const binding = conversationBindingFor();
    if (!binding || !buyerSession?.accessToken) {
      setStatus("Choose a Creator Agent before starting a conversation.");
      return "";
    }
    const creation = conversationCreationRequest(binding, "create");
    try {
      const result = await createConversation(serverUrl, buyerSession.accessToken, binding, {
        title: `New ${creatorAgent.name} conversation`,
        clientRequestId: creation.clientRequestId
      });
      const conversation = result?.conversation;
      if (!isServerConversationId(conversation?.id)) {
        throw new Error("Runtime returned an invalid server Conversation ID.");
      }
      settleConversationCreation(creation.scope);
      setConversations((current) => [
        conversation,
        ...current.filter((item) => item.id !== conversation.id)
      ]);
      return conversation.id;
    } catch (error) {
      settleConversationCreation(creation.scope, error);
      setConversationLibraryError(errorMessage(error));
      setStatus("Conversation Library unavailable. Try again when you're online.");
      return "";
    }
  }

  async function startNewConversation() {
    if (shouldOpenNewConversationInWindow(activeRunRef.current)) {
      return startNewConversationInWindow();
    }
    textRevealRef.current?.discard();
    const nextId = await createLibraryConversation();
    if (!nextId) return "";
    disconnectRuntime();
    conversationCursorRef.current = 0;
    setConversationId(nextId);
    setMessages([]);
    setConversationIdForEntitlement(buyerProfile.id, selectedEntitlementId, nextId);
    setStatus("New conversation ready");
    return nextId;
  }

  async function openConversationInNewWindow(nextConversationId, { announce = true } = {}) {
    const target = String(nextConversationId || "").trim();
    if (!isServerConversationId(target)) {
      setStatus("Only a server Conversation can be opened in a new window.");
      return false;
    }
    const binding = conversationBindingFor();
    if (!binding?.entitlementId || !binding.creatorId || !binding.agentId) {
      setStatus("Choose a Creator Agent before opening a Conversation window.");
      return false;
    }
    try {
      await invokeTauri("open_conversation_window", {
        conversationId: target,
        entitlementId: binding.entitlementId,
        creatorId: binding.creatorId,
        agentId: binding.agentId
      });
      if (announce) setStatus("Conversation opened in a new window");
      return true;
    } catch (error) {
      setStatus(`Hatch couldn't open the conversation window: ${errorMessage(error)}`);
      return false;
    }
  }

  async function startNewConversationInWindow() {
    // The current window intentionally keeps its existing conversation. The
    // receiving window reads this ID from its native URL before restoring its
    // own scoped workspace and layout state.
    const nextId = await createLibraryConversation({ allowActiveRun: true });
    return nextId ? openConversationInNewWindow(nextId) : false;
  }

  function rememberNativeContextTarget(value) {
    const target = String(value || "").trim();
    if (!target) return "";
    const key = `context-${Date.now()}-${++nativeContextTargetSequenceRef.current}`;
    nativeContextTargetsRef.current.set(key, target);
    while (nativeContextTargetsRef.current.size > 32) {
      const oldest = nativeContextTargetsRef.current.keys().next().value;
      nativeContextTargetsRef.current.delete(oldest);
    }
    return key;
  }

  function takeNativeContextTarget(key) {
    const value = nativeContextTargetsRef.current.get(key);
    if (value !== undefined) nativeContextTargetsRef.current.delete(key);
    return value ?? String(key || "").trim();
  }

  const showNativeContextMenu = useCallback((event, request) => {
    const savedTarget = typeof request?.target === "string" ? request.target : "";
    const targetKey = savedTarget ? rememberNativeContextTarget(savedTarget) : "";
    const nativeRequest = nativeContextRequest(event, request?.kind, targetKey || savedTarget);
    const intercepted = requestNativeContextMenu({
      event,
      request: nativeRequest,
      invokeImpl: invokeTauri,
      packaged: Boolean(window.__TAURI_INTERNALS__),
      onError: () => {
        if (targetKey) nativeContextTargetsRef.current.delete(targetKey);
        setStatus("Hatch couldn't open the native context menu.");
      }
    });
    if (!intercepted && targetKey) nativeContextTargetsRef.current.delete(targetKey);
    return intercepted;
  }, []);

  const showNativeCommandMenu = useCallback((event) => {
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    const position = rect
      ? { x: Number(rect.right), y: Number(rect.bottom) }
      : null;
    void invokeTauri("show_native_command_menu", {
      request: position ? { position } : { position: null }
    }).catch(() => setStatus("Hatch couldn't open the command menu."));
  }, []);

  async function copyNativeContextTarget(key, label) {
    const value = takeNativeContextTarget(key);
    if (!value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(value);
      setStatus(`${label} copied`);
    } catch {
      setStatus(`Hatch couldn't copy the ${label.toLowerCase()}.`);
    }
  }

  async function revealArtifact(target) {
    const artifact = String(target || "").trim();
    const grant = workspaceGrantRef.current || workspaceGrant;
    const relativePath = artifactRelativePath(artifact, workspaceRef.current || workspace);
    if (!grant?.grant_id || !relativePath) {
      setStatus("Reveal is available only for an artifact inside the granted workspace.");
      return;
    }
    try {
      await invokeTauri("reveal_workspace_artifact", {
        request: {
          workspaceGrantId: grant.grant_id,
          relativePath
        }
      });
      setStatus("Artifact revealed in the file browser");
    } catch (error) {
      setStatus(`Hatch couldn't reveal the artifact: ${errorMessage(error)}`);
    }
  }

  async function openArtifactInNativePreview(target) {
    const artifact = String(target || "").trim();
    const grant = workspaceGrantRef.current || workspaceGrant;
    const relativePath = artifactRelativePath(artifact, workspaceRef.current || workspace);
    if (!grant?.grant_id || !relativePath) {
      setStatus("Preview is available only for an artifact inside the granted workspace.");
      return;
    }
    try {
      await invokeTauri("open_workspace_artifact", {
        request: {
          workspaceGrantId: grant.grant_id,
          relativePath
        }
      });
      setStatus("Artifact opened in the native preview");
    } catch (error) {
      setStatus(`Hatch couldn't preview the artifact: ${errorMessage(error)}`);
    }
  }

  // Keep the single native listener stable while its actions always observe
  // the latest React state. Rust routes only to this focused WebView window.
  nativeCommandHandlersRef.current = {
    onNewConversation: startNewConversation,
    onNewConversationWindow: startNewConversationInWindow,
    onOpenConversationWindow: (target) => openConversationInNewWindow(takeNativeContextTarget(target), { announce: false }),
    onRenameConversation: (target) => beginRenameConversation(takeNativeContextTarget(target)),
    onArchiveConversation: (target) => void archiveConversation(takeNativeContextTarget(target)),
    onToggleSidebar: () => setSidebarPreference((current) => current === "open" ? "closed" : "open"),
    onToggleInspector: () => setInspectorPreference((current) => current === "open" ? "closed" : "open"),
    onStopRun: () => cancelRun(),
    onZoomIn: () => setApplicationZoom((current) => nextZoom(current, "increase")),
    onZoomOut: () => setApplicationZoom((current) => nextZoom(current, "decrease")),
    onZoomReset: () => setApplicationZoom(DESKTOP_ZOOM.default),
    onChooseWorkspace: () => chooseWorkspace(),
    onOpenSettings: () => {
      void invokeTauri("open_settings_window").catch((error) => {
        setStatus(`Hatch couldn't open Settings: ${errorMessage(error)}`);
      });
    },
    onOpenAbout: () => {
      void invokeTauri("open_about_window").catch((error) => {
        setStatus(`Hatch couldn't open About: ${errorMessage(error)}`);
      });
    },
    onRevealArtifact: (target) => void revealArtifact(takeNativeContextTarget(target)),
    onQuickLookArtifact: (target) => void openArtifactInNativePreview(takeNativeContextTarget(target)),
    onCopyArtifactPath: (target) => copyNativeContextTarget(target, "Path"),
    onCopyToolOutput: (target) => copyNativeContextTarget(target, "Output")
  };

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    void invokeTauri("set_native_command_state", {
      state: {
        newConversationEnabled: signedIn && conversationLibraryStatus === "ready",
        newWindowEnabled: signedIn && conversationLibraryStatus === "ready",
        workspaceEnabled: signedIn,
        // Settings/About are app-level surfaces and remain available while
        // signed out. Authentication state must not make the native menu
        // look broken before the first session is established.
        settingsEnabled: true,
        runStopEnabled: Boolean(signedIn && running && activeRunRef.current),
        sidebarVisible: sidebarPreference === "open",
        inspectorVisible: inspectorPreference === "open"
      }
    }).catch(() => {});
    return undefined;
  }, [conversationLibraryStatus, inspectorPreference, running, sidebarPreference, signedIn]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    return subscribeNativeCommands({
      listenImpl: listen,
      onCommand: (payload) => {
        void routeNativeCommand(payload, nativeCommandHandlersRef.current).catch((error) => {
          setStatus(`Hatch couldn't run the native command: ${errorMessage(error)}`);
        });
      },
      onError: (error) => {
        console.warn("[hatch:native-command-listener]", error);
      }
    });
  }, []);

  // WebKit's default product-area context menu includes Inspect Element when
  // DevTools are available. Product surfaces must never expose that browser
  // affordance: the row/tool/artifact handlers above still open Hatch's
  // semantic native menu, while editable controls retain Cut/Copy/Paste and
  // the browser preview keeps its normal DevTools menu.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    const suppressProductContextMenu = (event) => {
      if (!isEditableContextTarget(event.target)) event.preventDefault();
    };
    document.addEventListener("contextmenu", suppressProductContextMenu, true);
    return () => document.removeEventListener("contextmenu", suppressProductContextMenu, true);
  }, []);

  function clearInterruptedRun() {
    const dismissedRunId = String(activeRunRef.current?.runId || interruptedRun?.runId || "").trim();
    textRevealRef.current?.discard();
    activeRunRef.current = null;
    setInterruptedRun(null);
    setRunning(false);
    setLegacyProfileActiveRun(undefined);
    patchWindowContext({ activeRun: null, dismissedRunId: dismissedRunId || null });
    setStatus("Paused task closed by you");
  }

  async function signIn(credentials) {
    setSignInStatus("loading");
    setSignInError("");
    try {
      if (!credentials) throw new Error("Enter your email and password.");
      const result = await signInDesktopSession(credentials, DEFAULT_AUTH_URL, authStorageRef.current);
      await applyResolvedDesktopSession(result);
    } catch (error) {
      const persistedSession = persistedDesktopSessionFromError(error);
      if (persistedSession) {
        if (isAuthInvalidError(error)) {
          const cleared = await clearSavedSession(persistedSession);
          if (cleared) setSignInError("Hatch couldn't verify the new session. Please sign in again.");
          return;
        }
        setBuyerSession(persistedSession);
        setStartupError(errorMessage(error));
        setSignInStatus("ready");
        setAuthState("network-error");
        return;
      }
      setSignInStatus("error");
      setSignInError(isNetworkError(error)
        ? "Hatch can't reach the service. Check your connection and try again."
        : errorMessage(error));
    }
  }

  async function signOut() {
    const { serverRevoke, localClear } = startAuthSessionSignOut(
      DEFAULT_AUTH_URL,
      buyerSession,
      authStorageRef.current
    );
    void serverRevoke;
    disconnectRuntime();
    const cleared = await clearSavedSession(buyerSession, localClear);
    if (cleared) setSignInError("");
  }

  async function openBrowseCatalog() {
    try {
      await openCreatorAgentCatalog({
        catalogUrl: BROWSE_CATALOG_URL,
        invokeImpl: invokeTauri,
        windowObject: window,
        packaged: Boolean(window.__TAURI_INTERNALS__)
      });
      setEntitlementError("");
    } catch (error) {
      setEntitlementError(errorMessage(error));
    }
  }

  function selectCreatorAgent(entitlement) {
    const sameEntitlement = entitlement.entitlement_id === selectedEntitlementId;
    if (sameEntitlement && runtimeBindingMatches(
      connectionConfigRef.current,
      runtimeBindingForEntitlement(entitlement)
    )) return;
    disconnectRuntime();
    // A manual Agent switch is an explicit user choice. Do not let the
    // launch URL/context hint re-apply the previous window binding.
    requestedConversationBindingRef.current = null;
    // A manual Agent switch is also a navigation boundary. The previous
    // Conversation belongs to the old Agent and must not remain as a URL
    // hint while the new Agent's Library is loading.
    requestedConversationIdRef.current = "";
    const nextBinding = runtimeBindingForEntitlement(entitlement);
    if (nextBinding) {
      patchWindowContext({
        ...nextBinding,
        conversationId: "desktop-chat",
        conversationCursor: 0,
        composerDraft: "",
        activeRun: null,
        dismissedRunId: ""
      });
    }
    setSelectedEntitlementId(entitlement.entitlement_id);
    setCreatorAgent(creatorAgentFromEntitlement(entitlement));
    setProfileSetting("last_selected_entitlement_id", entitlement.entitlement_id);
    if (!sameEntitlement) {
      setMessages([]);
      conversationCursorRef.current = 0;
      setConversations([]);
      setConversationLibraryStatus("loading");
      setComposerDraftValue("");
      // Never carry a Conversation ID across Creator Agents. The Library
      // effect will select or create an ID bound to the newly selected Agent.
      setConversationId("desktop-chat");
    }
  }

  function selectConversation(conversation) {
    const nextId = String(conversation?.id || "").trim();
    if (!isServerConversationId(nextId)) {
      setStatus("That Conversation is not a server record.");
      return;
    }
    if (nextId === conversationId) return;
    if (activeRunRef.current) {
      setStatus("Stop or open a new window before switching away from the active task.");
      return;
    }
    disconnectRuntime();
    conversationCursorRef.current = 0;
    setMessages([]);
    setConversationId(nextId);
    setConversationIdForEntitlement(buyerProfile.id, selectedEntitlementId, nextId);
    setStatus("Conversation selected");
  }

  function beginRenameConversation(targetId) {
    const target = conversations.find((item) => item.id === targetId);
    if (!target) {
      setStatus("That conversation is no longer in the Library.");
      return;
    }
    setRenamingConversationId(target.id);
    setRenameDraft(target.title || conversationTitle(target.id));
    window.requestAnimationFrame(() => {
      const selector = `[data-conversation-rename="${CSS.escape(target.id)}"]`;
      document.querySelector(selector)?.focus();
    });
  }

  function cancelRenameConversation() {
    setRenamingConversationId("");
    setRenameDraft("");
  }

  async function commitRenameConversation(targetId, value = renameDraft) {
    const target = conversations.find((item) => item.id === targetId);
    const nextTitle = String(value || "").trim();
    if (!target || !nextTitle) {
      cancelRenameConversation();
      return;
    }
    const binding = conversationBindingFor();
    if (!binding || !buyerSession?.accessToken) {
      cancelRenameConversation();
      return;
    }
    try {
      const result = await updateConversation(serverUrl, buyerSession.accessToken, binding, target.id, {
        title: nextTitle,
        version: target.version
      });
      const updated = result?.conversation;
      if (!updated?.id) throw new Error("Runtime returned an invalid Conversation.");
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item));
      cancelRenameConversation();
      setStatus("Conversation renamed");
    } catch (error) {
      setStatus(`Couldn't rename the conversation: ${errorMessage(error)}`);
    }
  }

  async function archiveConversation(targetId) {
    const target = conversations.find((item) => item.id === targetId);
    const binding = conversationBindingFor();
    if (!target || !binding || !buyerSession?.accessToken) return;
    try {
      await updateConversation(serverUrl, buyerSession.accessToken, binding, target.id, {
        status: "archived",
        version: target.version
      });
      const remaining = conversations.filter((item) => item.id !== target.id);
      setConversations(remaining);
      if (target.id === conversationId) {
        const replacement = remaining[0];
        if (replacement) selectConversation(replacement);
        else await startNewConversation();
      }
      setStatus("Conversation archived");
    } catch (error) {
      setStatus(`Couldn't archive the conversation: ${errorMessage(error)}`);
    }
  }

  function requestToolApproval(message) {
    return new Promise((resolve) => {
      approvalResolversRef.current.set(message.tool_call_id, resolve);
      setApprovalRequests((current) => ({
        ...current,
        [message.tool_call_id]: {
          message,
          status: "pending",
          requestedAt: Date.now()
        }
      }));
      upsertToolEvent({
        ...message,
        locality: "client",
        status: "requested"
      });
      // If the executor window is in the background, ask the OS for a
      // non-modal Dock/taskbar attention pulse. Approval remains inline and
      // never turns into a blocking system sheet.
      if (window.__TAURI_INTERNALS__) {
        void invokeTauri("request_window_attention").catch(() => {});
      }
    });
  }

  function rejectPendingApprovals() {
    for (const [, resolve] of approvalResolversRef.current) {
      resolve(false);
    }
    approvalResolversRef.current.clear();
    setApprovalRequests({});
  }

  function appendAssistantText(id, delta) {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) return message;
      return {
        ...message,
        content: appendTimelineText(assistantParts(message), delta),
        status: { type: "running" }
      };
    }));
  }

  function saveAssistantTiming(id, runId, timing, fullResponseAt) {
    const summary = reportTurnTiming(runId, timing, fullResponseAt);
    updateAssistantMessage(id, (message) => ({
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        custom: {
          ...(message.metadata?.custom ?? {}),
          turnTiming: summary
        }
      }
    }));
  }

  function finishAssistant(id, text, statusValue) {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) return message;
      const parts = terminalTimelineParts(
        assistantParts(message),
        text,
        statusValue,
        message.metadata?.custom?.runId
      );
      const custom = {
        ...(message.metadata?.custom ?? {}),
        status: statusValue,
        completedAt: Date.now()
      };
      return {
        ...message,
        content: parts,
        status: statusValue === "failed"
          ? { type: "incomplete", reason: "error", error: { message: text } }
          : { type: "complete", reason: "stop" },
        metadata: {
          ...(message.metadata ?? {}),
          custom
        }
      };
    }));
  }

  function upsertToolEvent(event) {
    const activeRun = activeRunRef.current;
    if (!activeRun || event.run_id !== activeRun.runId) return;
    updateAssistantMessage(activeRun.assistantId, (message) => {
      const parts = assistantParts(message);
      const existingIndex = parts.findIndex((part) => (
        part.type === "tool-call" && part.toolCallId === event.tool_call_id
      ));
      const existing = existingIndex >= 0 ? parts[existingIndex] : undefined;
      const nextPart = toolPartFromEvent(event, existing);
      return {
        ...message,
        content: upsertTimelinePart(
          parts,
          nextPart,
          (part) => part.type === "tool-call" && part.toolCallId === event.tool_call_id
        ),
        status: event.status === "failed"
          ? { type: "running" }
          : message.status ?? { type: "running" },
        metadata: {
          ...(message.metadata ?? {}),
          custom: {
            ...(message.metadata?.custom ?? {}),
            latestTool: {
              name: event.name,
              status: event.status,
              toolCallId: event.tool_call_id
            }
          }
        }
      };
    });
  }

  function upsertSkillEvent(event) {
    const activeRun = activeRunRef.current;
    if (!activeRun || event.run_id !== activeRun.runId) return;
    updateAssistantMessage(activeRun.assistantId, (message) => {
      const parts = assistantParts(message);
      const nextPart = skillActivityPartFromEvent(event);
      return {
        ...message,
        content: upsertTimelinePart(parts, nextPart, (part) => isSameSkillActivityPart(part, nextPart)),
        status: message.status ?? { type: "running" },
        metadata: {
          ...(message.metadata ?? {}),
          custom: {
            ...(message.metadata?.custom ?? {}),
            latestSkill: {
              name: event.name,
              status: event.status,
              reason: event.reason
            }
          }
        }
      };
    });
  }

  function upsertSkillRun(event) {
    const activeRun = activeRunRef.current;
    if (!activeRun || event.run_id !== activeRun.runId) return;
    updateAssistantMessage(activeRun.assistantId, (message) => {
      const parts = assistantParts(message);
      const nextPart = skillRunActivityPartFromEvent(event);
      return {
        ...message,
        content: upsertTimelinePart(parts, nextPart, (part) => isSameSkillRunActivityPart(part, nextPart)),
        status: message.status ?? { type: "running" },
        metadata: {
          ...(message.metadata ?? {}),
          custom: {
            ...(message.metadata?.custom ?? {}),
            latestSkillRun: {
              name: event.name,
              status: event.status,
              skillRunId: event.skill_run_id
            }
          }
        }
      };
    });
  }

  function updateAssistantMessage(id, updater) {
    setMessages((current) => current.map((message) => (
      message.id === id ? updater(message) : message
    )));
  }

  function updateAssistantMetadataForRun(runId, metadata) {
    const activeRun = activeRunRef.current;
    if (!activeRun || activeRun.runId !== runId) return;
    updateAssistantMessage(activeRun.assistantId, (message) => ({
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        custom: {
          ...(message.metadata?.custom ?? {}),
          ...metadata
        }
      }
    }));
  }

  if (authState === "loading") return <LaunchScreen />;
  if (authState === "network-error") {
    return (
      <NetworkErrorScreen
        message={startupError}
        onRetry={() => { setAuthState("loading"); setBootstrapAttempt((value) => value + 1); }}
        onSignOut={canUseAnotherAccountFromNetworkError(buyerSession) ? () => void signOut() : null}
      />
    );
  }
  if (authState === "unsupported-role") {
    return <UnsupportedRoleScreen profile={buyerProfile} onSignOut={() => void signOut()} />;
  }
  if (!signedIn) {
    return <SignInScreen onSignIn={(credentials) => void signIn(credentials)} status={signInStatus} error={signInError} />;
  }
  if (creatorAgentEntitlements.length === 0) {
    return (
      <EmptyAgentsScreen
        profile={buyerProfile}
        onBrowse={() => void openBrowseCatalog()}
        onRefresh={() => void refreshEntitlements({ preserveCurrent: true })}
        onSignOut={() => void signOut()}
        refreshing={entitlementRefreshing}
        error={entitlementError}
        notice={settingsMigrationNotice}
      />
    );
  }

  return (
    <DesktopWindowShell
      sidebarPreference={sidebarPreference}
      sidebarWidth={sidebarWidth}
      inspectorPreference={inspectorPreference}
      inspectorWidth={inspectorWidth}
      onSidebarPreferenceChange={setSidebarPreference}
      onSidebarWidthChange={setSidebarWidth}
      onInspectorPreferenceChange={setInspectorPreference}
      onInspectorWidthChange={setInspectorWidth}
      onShowOverflow={showNativeCommandMenu}
      sidebar={(
        <DesktopSidebar
          profile={buyerProfile}
          entitlements={creatorAgentEntitlements}
          selectedEntitlementId={selectedEntitlementId}
          conversationId={conversationId}
          conversations={conversations}
          conversationLibraryError={conversationLibraryError}
          conversationLibraryStatus={conversationLibraryStatus}
          conversationLibraryReady={conversationLibraryStatus === "ready"}
          onSelectAgent={selectCreatorAgent}
          onSelectConversation={selectConversation}
          onNewConversation={startNewConversation}
          onConversationContextMenu={showNativeContextMenu}
          renamingConversationId={renamingConversationId}
          renameDraft={renameDraft}
          onRenameDraftChange={setRenameDraft}
          onCommitRename={commitRenameConversation}
          onCancelRename={cancelRenameConversation}
          onSignOut={() => void signOut()}
        />
      )}
      toolbar={(
        <DesktopConversationToolbar
          creatorAgent={creatorAgent}
          conversationId={conversationId}
          conversationTitle={conversations.find((item) => item.id === conversationId)?.title || ""}
          connected={connected}
          conversationLibraryReady={conversationLibraryStatus === "ready"}
          workspaceGranted={workspaceGranted}
          status={status}
          onRetry={retryRuntimeConnection}
        />
      )}
      inspector={(
        <DesktopInspector
          creatorAgent={creatorAgent}
          workspace={workspace}
          workspaceGranted={workspaceGranted}
          permissionMode={permissionMode}
          running={running}
          status={status}
          onChooseWorkspace={() => void chooseWorkspace()}
          onPermissionChange={updatePermissionMode}
        />
      )}
    >
      <section className="chat-shell desktop-chat-shell">
        {!workspaceGranted ? (
          <WorkspaceOnboarding
            creatorName={creatorAgent.creator}
            draft={workspaceDraft}
            onChoose={() => void chooseWorkspace({ activate: false })}
            onGrant={() => void grantWorkspace()}
            status={status}
          />
        ) : (
          <ApprovalContext.Provider value={{ requests: approvalRequests, resolveToolApproval }}>
            <NativeContextMenuContext.Provider value={showNativeContextMenu}>
              <AssistantRuntimeProvider runtime={runtime}>
                <ThreadPrimitive.Root className="thread-root">
                <ThreadPrimitive.Viewport
                  ref={viewportRef}
                  className="thread-viewport"
                  onScroll={handleViewportScroll}
                >
                  <ThreadPrimitive.Empty>
                    <EmptyThread connected={connected} creatorAgent={creatorAgent} />
                  </ThreadPrimitive.Empty>
                  <ThreadPrimitive.Messages components={{ Message: HatchMessage }} />
                </ThreadPrimitive.Viewport>
                <ThreadPrimitive.ViewportFooter className="composer-footer">
                  <ComposerPrimitive.Root className="composer">
                    <DesktopComposerInput
                      key={conversationId}
                      className="composer-input"
                      draftKey={conversationId}
                      initialDraft={composerDraft}
                      ready={windowContextReady && windowStateRestored}
                      onDraftChange={setComposerDraftValue}
                      onBlur={resetImeComposition}
                      onCompositionEnd={endImeComposition}
                      onCompositionStart={startImeComposition}
                      onKeyDownCapture={stopImeEnterSubmit}
                      placeholder={connected ? "Message" : "Connection is restoring…"}
                      submitMode="enter"
                      rows={1}
                    />
                    <div className="composer-actions">
                      <ComposerControls
                        droppedFiles={droppedFiles}
                        workspace={workspace}
                        workspaceGranted={workspaceGranted}
                        permissionMode={permissionMode}
                        onChooseWorkspace={() => void chooseWorkspace()}
                        onChooseFiles={() => void chooseContextFiles()}
                        onPermissionChange={updatePermissionMode}
                        onRemoveDroppedFile={(contextId) => {
                          void discardNativeDropContexts([contextId]);
                          droppedFilesRef.current = droppedFilesRef.current.filter((item) => item.contextId !== contextId);
                          setDroppedFiles((current) => current.filter((item) => item.contextId !== contextId));
                        }}
                      />
                      {running ? (
                        <button
                          aria-label="Stop response"
                          className="send-button stop-button"
                          title="Stop"
                          type="button"
                          onClick={() => void cancelRun()}
                        >
                          <Square aria-hidden="true" fill="currentColor" strokeWidth={0} />
                        </button>
                      ) : (
                        <ComposerPrimitive.Send
                          aria-label="Send message"
                          className="send-button"
                          title="Send"
                        >
                          <ArrowUp aria-hidden="true" />
                        </ComposerPrimitive.Send>
                      )}
                    </div>
                  </ComposerPrimitive.Root>
                </ThreadPrimitive.ViewportFooter>
                </ThreadPrimitive.Root>
              </AssistantRuntimeProvider>
            </NativeContextMenuContext.Provider>
          </ApprovalContext.Provider>
        )}
        {interruptedRun ? (
          <div className="recovery-banner" role="alert">
            <div><strong>Your task is safe.</strong><span>The Conversation is restored. This task will not resume or replay tools automatically; close it before starting a new task.</span></div>
            <button className="secondary compact" type="button" onClick={clearInterruptedRun}>Close task</button>
          </div>
        ) : null}
      </section>
    </DesktopWindowShell>
  );
}

function DesktopSidebar({
  profile,
  entitlements,
  selectedEntitlementId,
  conversationId,
  conversations,
  conversationLibraryError,
  conversationLibraryStatus,
  conversationLibraryReady,
  onSelectAgent,
  onSelectConversation,
  onNewConversation,
  onConversationContextMenu,
  renamingConversationId,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onSignOut
}) {
  const listedConversations = Array.isArray(conversations) ? conversations : [];
  // The server-issued Library is the only list authority. Never synthesize a
  // row for a URL/profile ID that the selected Agent's Library did not return.
  const visibleConversations = listedConversations;
  return (
    <div className="desktop-sidebar-content">
      <div className="desktop-sidebar-heading">
        <span className="hatch-wordmark">Hatch</span>
        <button
          className="sidebar-new-conversation"
          type="button"
          disabled={!conversationLibraryReady}
          onClick={onNewConversation}
        >
          <Plus aria-hidden="true" /><span>New conversation</span>
        </button>
      </div>
      <nav className="desktop-source-list" aria-label="Creator Agents">
        <div className="desktop-source-list-label">{PRODUCT_COPY.home}</div>
        {entitlements.map((entitlement) => {
          const agent = creatorAgentFromEntitlement(entitlement);
          const selected = entitlement.entitlement_id === selectedEntitlementId;
          return (
            <React.Fragment key={entitlement.entitlement_id}>
              <button
                aria-current={selected ? "page" : undefined}
                aria-expanded={selected}
                className={`desktop-source-row agent ${selected ? "selected" : ""}`}
                type="button"
                onClick={() => onSelectAgent(entitlement)}
              >
                <span className="creator-avatar">{agent.creatorInitials}</span>
                <span className="desktop-source-row-copy">
                  <strong title={agent.name}>{agent.name}</strong>
                  <small>by {agent.creator}</small>
                </span>
                {selected
                  ? <ChevronDown className="desktop-agent-disclosure" aria-hidden="true" />
                  : <ChevronRight className="desktop-agent-disclosure" aria-hidden="true" />}
              </button>
              {selected ? (
                <div className="desktop-agent-conversation-group" role="group" aria-label={`${agent.name} conversations`}>
                  <div className="desktop-agent-conversation-label">Conversations</div>
                  {conversationLibraryStatus === "loading" || conversationLibraryStatus === "idle" ? (
                    <div className="desktop-source-empty compact">Loading conversations…</div>
                  ) : conversationLibraryStatus === "unavailable" ? (
                    <div
                      className="desktop-source-empty compact"
                      role="status"
                      title={conversationLibraryError || undefined}
                    >
                      Conversations unavailable · retrying
                    </div>
                  ) : visibleConversations.length > 0 ? visibleConversations.map((conversation) => {
                    const conversationSelected = conversation.id === conversationId;
                    const renaming = conversation.id === renamingConversationId;
                    return (
                      renaming ? (
                        <ConversationSourceRow
                          key={conversation.id}
                          conversation={conversation}
                          selected={conversationSelected}
                          renaming
                          renameDraft={renameDraft}
                          onRenameDraftChange={onRenameDraftChange}
                          onCommitRename={onCommitRename}
                          onCancelRename={onCancelRename}
                          onContextMenu={onConversationContextMenu}
                        />
                      ) : (
                        <ConversationSourceRow
                          key={conversation.id}
                          conversation={conversation}
                          selected={conversationSelected}
                          onSelect={onSelectConversation}
                          onContextMenu={onConversationContextMenu}
                        />
                      )
                    );
                  }) : (
                    <div className="desktop-source-empty compact">No conversations yet</div>
                  )}
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </nav>
      <div className="desktop-sidebar-footer">
        <span className="avatar">{profile.initials}</span>
        <span className="desktop-sidebar-account"><strong>{profile.name}</strong><small>Signed in</small></span>
        <button className="profile-sign-out" type="button" onClick={onSignOut}>Sign out</button>
      </div>
    </div>
  );
}

function ConversationSourceRow({
  conversation,
  selected,
  renaming = false,
  renameDraft = "",
  onSelect,
  onContextMenu,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename
}) {
  const contextMenu = (event) => onContextMenu?.(event, {
    kind: "conversation",
    target: conversation.id
  });
  if (renaming) {
    return (
      <div
        className={`desktop-source-row conversation ${selected ? "selected" : ""}`}
        aria-current={selected ? "page" : undefined}
        onContextMenu={contextMenu}
      >
        <MessageSquare className="conversation-row-glyph" aria-hidden="true" />
        <span className="desktop-source-row-copy">
          <input
            aria-label="Rename conversation"
            className="conversation-rename-input"
            data-conversation-rename={conversation.id}
            value={renameDraft}
            onChange={(event) => onRenameDraftChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onCommitRename?.(conversation.id, event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCancelRename?.();
              }
            }}
          />
          <small>Rename with Enter · cancel with Escape</small>
        </span>
      </div>
    );
  }
  return (
    <button
      className={`desktop-source-row conversation ${selected ? "selected" : ""}`}
      type="button"
      aria-current={selected ? "page" : undefined}
      title={conversation.title || conversation.id}
      onClick={() => onSelect?.(conversation)}
      onContextMenu={contextMenu}
    >
      <MessageSquare className="conversation-row-glyph" aria-hidden="true" />
      <span className="desktop-source-row-copy">
        <strong>{conversation.title || conversationTitle(conversation.id)}</strong>
        <small>{selected ? "Current conversation" : "Conversation"}</small>
      </span>
    </button>
  );
}

function DesktopConversationToolbar({ creatorAgent, conversationId, conversationTitle: providedTitle, connected, conversationLibraryReady, workspaceGranted, status, onRetry }) {
  const connecting = /connecting|loading history|restoring|preparing/i.test(String(status || ""));
  const title = providedTitle || conversationTitle(conversationId);
  return (
    <>
      <div
        aria-label={`${title}, ${creatorAgent.name} by ${creatorAgent.creator}`}
        className="desktop-toolbar-context"
        title={`${title} · ${creatorAgent.name} by ${creatorAgent.creator}`}
      >
        <strong className="desktop-toolbar-conversation">{title}</strong>
        <span className="desktop-toolbar-context-divider" aria-hidden="true">·</span>
        <span className="desktop-toolbar-agent-name">{creatorAgent.name}</span>
      </div>
      {workspaceGranted && conversationLibraryReady && !connected ? (
        <button
          aria-busy={connecting || undefined}
          aria-label={connecting ? "Connecting" : "Reconnect"}
          className="chrome-icon-button desktop-connection-action"
          disabled={connecting}
          title={connecting ? "Connecting" : "Reconnect"}
          type="button"
          onClick={onRetry}
        >
          {connecting
            ? <LoaderCircle className="connection-spinner" aria-hidden="true" />
            : <RefreshCw aria-hidden="true" />}
        </button>
      ) : null}
    </>
  );
}

function DesktopInspector({
  creatorAgent,
  workspace,
  workspaceGranted,
  permissionMode,
  running,
  status,
  onChooseWorkspace,
  onPermissionChange
}) {
  return (
    <div className="desktop-inspector-content">
      <section className="inspector-section">
        <span className="inspector-kicker">Workspace</span>
        <strong className="inspector-workspace-path" title={workspace || "No folder selected"}>
          {workspaceGranted ? workspaceGrantLabel(workspace) : "No workspace selected"}
        </strong>
        <button className="secondary compact inspector-action" type="button" onClick={onChooseWorkspace}>
          {workspaceGranted ? "Change folder" : "Choose folder"}
        </button>
      </section>
      <section className="inspector-section">
        <span className="inspector-kicker">Permissions</span>
        <label className="inspector-select-control">
          <ShieldIcon />
          <select aria-label="Workspace permissions" value={permissionMode} onChange={(event) => onPermissionChange(event.target.value)}>
            {PERMISSION_OPTIONS.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </label>
        <p>{permissionPolicyDetail(permissionMode)}</p>
      </section>
      <section className="inspector-section">
        <span className="inspector-kicker">Run</span>
        <div className="inspector-run-state">
          <span className={`activity-dot ${running ? "running" : status.toLowerCase().includes("fail") ? "failed" : "done"}`} />
          <strong>{running ? "Working" : status || "Ready"}</strong>
        </div>
      </section>
      <section className="inspector-section agent-boundary-section">
        <span className="inspector-kicker">Creator Agent</span>
        <strong>{creatorAgent.name}</strong>
        <p>by {creatorAgent.creator}. This conversation keeps the Agent context it started with.</p>
      </section>
    </div>
  );
}

function ComposerControls({ droppedFiles = [], workspace, workspaceGranted, permissionMode, onChooseWorkspace, onChooseFiles, onPermissionChange, onRemoveDroppedFile }) {
  const attachmentControl = (
    <button
      aria-label="Attach context files"
      className="composer-control attachment-composer-control"
      title="Attach context files"
      type="button"
      onClick={onChooseFiles}
    >
      <Paperclip aria-hidden="true" />
      <span className="composer-control-label">Attach files</span>
    </button>
  );
  return (
    <div className="composer-controls">
      {droppedFiles.length > 0 ? (
        <div className="composer-attachments" aria-label="Dropped context files">
          {droppedFiles.map((file) => (
            <span className="composer-attachment" key={file.contextId} title={file.displayName}>
              <span className="composer-attachment-name">{file.displayName}</span>
              <button type="button" aria-label={`Remove ${file.displayName}`} onClick={() => onRemoveDroppedFile?.(file.contextId)}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-settings">
        {attachmentControl}
        <button
          aria-label="Choose workspace folder"
          className="composer-control workspace-composer-control"
          title={workspace || "Choose a workspace folder"}
          type="button"
          onClick={onChooseWorkspace}
        >
          <WorkspaceIcon />
          <span className="composer-control-label">{workspaceGranted ? workspaceGrantLabel(workspace) : "Choose workspace"}</span>
          <ChevronDown className="composer-control-caret" aria-hidden="true" />
        </button>
        <label className="composer-control permission-composer-control" title={permissionPolicyDetail(permissionMode)}>
          <ShieldIcon />
          <select aria-label="Workspace permissions" value={permissionMode} onChange={(event) => onPermissionChange(event.target.value)}>
            {PERMISSION_OPTIONS.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
          <ChevronDown className="composer-control-caret" aria-hidden="true" />
        </label>
      </div>
    </div>
  );
}

/**
 * assistant-ui owns the live composer value. This thin adapter mirrors text
 * changes into the native per-window session and restores a draft only when
 * the window context is ready or the active Conversation changes. It avoids
 * passing a competing `value` prop to ComposerPrimitive.Input, which would
 * interfere with its IME and autosize behavior.
 */
function DesktopComposerInput({
  draftKey,
  initialDraft,
  ready,
  onDraftChange,
  ...props
}) {
  const { setText } = unstable_useComposerInput();
  const appliedKeyRef = useRef(null);

  useEffect(() => {
    if (!ready || appliedKeyRef.current === draftKey) return;
    appliedKeyRef.current = draftKey;
    setText(String(initialDraft || ""));
  }, [draftKey, initialDraft, ready, setText]);

  return (
    <ComposerPrimitive.Input
      {...props}
      onChange={(event) => onDraftChange?.(event.target.value)}
    />
  );
}

function conversationTitle(conversationId) {
  const value = String(conversationId || "").trim();
  if (!value || value === "desktop-chat") return "New conversation";
  return value.replace(/^conversation_[^_]+_/, "Conversation ").replaceAll("_", " ");
}

function stableRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

async function loadConversationHistory(serverUrl, conversationId, entitlementId, accessToken, binding = {}) {
  const response = await fetch(historyUrlForRuntime(serverUrl, conversationId, entitlementId, binding), {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error("We couldn't reload this conversation.");
  }
  const payload = await response.json();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.filter((message) => message.role === "user" || message.role === "assistant");
}

function historyUrlForRuntime(serverUrl, conversationId, entitlementId, binding = {}) {
  const url = new URL(runtimeHttpUrl(serverUrl, `/conversations/${encodeURIComponent(conversationId)}/messages`));
  url.searchParams.set("entitlement_id", entitlementId);
  if (binding.creatorId) url.searchParams.set("creator_id", binding.creatorId);
  if (binding.agentId) url.searchParams.set("agent_id", binding.agentId);
  return url.toString();
}

function historyMessageToThreadMessage(message, index) {
  const id = `history_${message.run_id ?? "message"}_${index}`;
  const createdAt = messageCreatedAt(message.timestamp);
  if (message.role === "user") {
    return makeUserMessage(id, message.content ?? "", createdAt, {
      attachments: message.attachments
    });
  }
  const filtered = message.finish_reason === "content_filter";
  const text = filtered ? OUTPUT_FILTERED_COPY : message.content ?? "";
  const content = filtered
    ? [{ type: "text", text }]
    : historyOrderedParts(message);
  const activityParts = content.filter(isActivityPart);
  const lastTool = [...activityParts].reverse().find((part) => part.type === "tool-call");
  const lastSkill = [...activityParts].reverse().find(isSkillActivityPart);
  return makeAssistantMessage(id, text, {
    status: filtered ? "content_filter" : "completed",
    createdAt,
    content,
    custom: {
      runId: message.run_id,
      hydrated: true,
      ...(filtered ? { outputGuardBlocked: true } : {}),
      ...(lastSkill
        ? {
            latestSkill: {
              name: lastSkill.data.name,
              status: lastSkill.data.status,
              reason: lastSkill.data.reason
            }
          }
        : {}),
      ...(lastTool
        ? {
            latestTool: {
              name: lastTool.toolName,
              status: lastTool.artifact?.status,
              toolCallId: lastTool.toolCallId
            }
          }
        : {})
    }
  });
}

function historyOrderedParts(message) {
  const timeline = historyTimelineEntries(message);
  if (!timeline) {
    return message.content ? [{ type: "text", text: message.content }] : [];
  }
  return timeline.map((entry) => {
    if (entry.type === "tool_call") return historyToolCallToPart(entry.value);
    if (entry.type === "skill_run") return skillRunActivityPartFromEvent(entry.value);
    if (entry.type === "skill_event") return skillActivityPartFromEvent(entry.value);
    return entry;
  });
}

function messageCreatedAt(timestamp) {
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function makeUserMessage(id, text, createdAt = Date.now(), options = {}) {
  const attachments = attachmentPresentationMetadata(options.attachments);
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date(createdAt),
    metadata: {
      custom: {
        source: "hatch",
        ...(attachments.length > 0 ? { attachments } : {})
      }
    }
  };
}

function attachmentPresentationMetadata(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    if (!attachment || typeof attachment !== "object") return [];
    const attachmentId = typeof attachment.attachment_id === "string" ? attachment.attachment_id : "";
    const displayName = typeof attachment.display_name === "string" ? attachment.display_name : "";
    const mediaType = typeof attachment.media_type === "string" ? attachment.media_type : "";
    const sourceBytes = Number(attachment.source_bytes);
    if (!attachmentId || !displayName || !mediaType || !Number.isSafeInteger(sourceBytes)) return [];
    return [{
      attachment_id: attachmentId,
      display_name: displayName,
      media_type: mediaType,
      source_bytes: sourceBytes,
      truncated: attachment.truncated === true
    }];
  });
}

function makeAssistantMessage(id, text, options = {}) {
  const content = options.content ?? (text ? [{ type: "text", text }] : []);
  return {
    id,
    role: "assistant",
    content: prependTurnActivity(content, options.custom?.runId),
    createdAt: new Date(options.createdAt ?? Date.now()),
    status: options.status === "failed"
      ? { type: "incomplete", reason: "error", error: { message: text } }
      : { type: "complete", reason: "stop" },
    metadata: {
      custom: {
        source: "hatch",
        status: options.status ?? "completed",
        ...(options.custom ?? {})
      }
    }
  };
}

function makeAssistantPlaceholder(id, runId, startedAt) {
  return {
    id,
    role: "assistant",
    content: prependTurnActivity([], runId),
    createdAt: new Date(startedAt),
    status: { type: "running" },
    metadata: {
      custom: {
        source: "hatch",
        runId,
        startedAt,
        status: "running"
      }
    }
  };
}

function assistantParts(message) {
  if (Array.isArray(message.content)) return [...message.content];
  if (typeof message.content === "string" && message.content.length > 0) {
    return [{ type: "text", text: message.content }];
  }
  return [];
}

function textFromAppendMessage(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part.type === "text") return part.text ?? "";
    return "";
  }).join("");
}

function toolPartFromEvent(event, existing) {
  const args = event.arguments ?? existing?.args ?? {};
  const failed = event.status === "failed" || event.status === "cancelled";
  const completed = event.status === "completed";
  const result = failed
    ? event.error ?? existing?.result
    : completed
      ? event.result ?? existing?.result ?? { status: "ok" }
      : existing?.result;
  return {
    type: "tool-call",
    toolCallId: event.tool_call_id,
    toolName: event.name,
    args,
    argsText: JSON.stringify(args, null, 2),
    result,
    isError: failed || existing?.isError || false,
    approval: approvalForToolEvent(event, existing),
    artifact: {
      locality: event.locality ?? existing?.artifact?.locality,
      status: event.status,
      error: event.error,
      approval: event.approval ?? existing?.artifact?.approval
    }
  };
}

function historyToolCallToPart(toolCall) {
  return toolPartFromEvent({
    type: "tool_call.delta",
    run_id: toolCall.run_id,
    tool_call_id: toolCall.tool_call_id,
    name: toolCall.name,
    locality: toolCall.locality,
    approval: toolCall.approval ?? "none",
    status: toolCall.status,
    arguments: toolCall.arguments,
    result: toolCall.result,
    error: toolCall.error
  });
}

function skillActivityPartFromEvent(event) {
  return {
    type: "data",
    name: SKILL_ACTIVITY_PART,
    data: {
      id: skillActivityIdForEvent(event),
      run_id: event.run_id,
      name: event.name,
      path: event.path,
      scope: event.scope,
      status: event.status,
      invocation_type: event.invocation_type,
      reason: event.reason,
      source_tool_call_id: event.source_tool_call_id,
      trigger: event.trigger,
      resource_paths: event.resource_paths,
      resource_manifest_truncated: event.resource_manifest_truncated,
      timestamp: event.timestamp ?? new Date().toISOString()
    }
  };
}

function skillRunActivityPartFromEvent(event) {
  return {
    type: "data",
    name: SKILL_RUN_ACTIVITY_PART,
    data: {
      id: skillRunActivityIdForEvent(event),
      run_id: event.run_id,
      skill_run_id: event.skill_run_id,
      skill_id: event.skill_id,
      name: event.name,
      status: event.status,
      error: event.error,
      timestamp: event.timestamp ?? new Date().toISOString()
    }
  };
}

function skillRunActivityIdForEvent(event) {
  return [event.run_id, event.skill_run_id].join(":");
}

function skillActivityIdForEvent(event) {
  if (event.status === "invoked") {
    return [
      event.run_id,
      "invoked",
      event.source_tool_call_id ?? "",
      event.path,
      event.reason
    ].join(":");
  }
  return [
    event.run_id,
    "activated",
    event.path,
    event.reason
  ].join(":");
}

function isSkillActivityPart(part) {
  return part?.type === "data" && part.name === SKILL_ACTIVITY_PART;
}

function isSkillRunActivityPart(part) {
  return part?.type === "data" && part.name === SKILL_RUN_ACTIVITY_PART;
}

function isSameSkillRunActivityPart(part, nextPart) {
  return isSkillRunActivityPart(part)
    && isSkillRunActivityPart(nextPart)
    && part.data?.id === nextPart.data?.id;
}

function isSameSkillActivityPart(part, nextPart) {
  return isSkillActivityPart(part)
    && isSkillActivityPart(nextPart)
    && part.data?.id === nextPart.data?.id;
}

function approvalForToolEvent(event, existing) {
  const approval = event.approval ?? existing?.artifact?.approval;
  if (approval !== "ask") return existing?.approval;
  if (event.status === "completed") {
    return {
      id: event.tool_call_id,
      approved: true,
      isAutomatic: false
    };
  }
  if (event.status === "failed") {
    return {
      id: event.tool_call_id,
      approved: false,
      isAutomatic: false,
      reason: event.error?.message
    };
  }
  return {
    id: event.tool_call_id,
    isAutomatic: false
  };
}

function toolEventFromApproval(message) {
  return {
    type: "tool_call.delta",
    run_id: message.run_id,
    tool_call_id: message.tool_call_id,
    name: message.name,
    locality: "client",
    approval: "ask",
    status: message.type === "approval.result" && message.status === "denied" ? "failed" : "requested",
    arguments: message.arguments,
    error: message.type === "approval.result" && message.status === "denied"
      ? { code: "approval_denied", message: message.reason ?? "Tool call denied" }
      : undefined
  };
}

function EmptyThread({ connected, creatorAgent }) {
  return (
    <div className="empty-thread">
      <span className="creator-avatar large">{creatorAgent.creatorInitials}</span>
      <span className="empty-kicker">{creatorAgent.creator}</span>
      <h2>{connected ? "What would you like to work on?" : "Your conversation is offline."}</h2>
      <p>
        {connected
          ? creatorAgent.description
          : "Your conversation and unfinished task stay here while the connection is restored."}
      </p>
      {creatorAgent.boundary ? <small className="boundary-copy">{creatorAgent.boundary}</small> : null}
    </div>
  );
}

function WorkspaceIcon() {
  return <FolderOpen aria-hidden="true" />;
}

function ShieldIcon() {
  return <ShieldAlert aria-hidden="true" />;
}

function WorkspaceOnboarding({ creatorName, draft, onChoose, onGrant, status }) {
  return (
    <div className="workspace-onboarding">
      <section className="workspace-onboarding-card">
        <div className="workspace-onboarding-icon"><WorkspaceIcon /></div>
        <h2>{PRODUCT_COPY.workspaceRequired}</h2>
        <p>{creatorName}&apos;s agent only works with files inside the folder you choose.</p>

        <button className={`workspace-picker ${draft ? "selected" : ""}`} type="button" onClick={onChoose}>
          <WorkspaceIcon />
          <span className="workspace-picker-copy">
            <strong>{draft ? workspaceGrantLabel(draft) : "Choose a folder on this computer"}</strong>
          </span>
          <span className="workspace-picker-action">{draft ? "Change" : "Choose"}</span>
        </button>

        <button className="workspace-grant-button" type="button" onClick={onGrant} disabled={!draft.trim()}>
          Start
        </button>
        {status && status !== "Offline" ? <small className="workspace-onboarding-status">{status}</small> : null}
      </section>
    </div>
  );
}

function LaunchScreen() {
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">Hatch.</strong></div>
      <section className="status-card">
        <span className="eyebrow">Hatch</span>
        <h1>Opening your workspace…</h1>
        <p>Checking your account and Creator Agents.</p>
      </section>
    </main>
  );
}

function NetworkErrorScreen({ message, onRetry, onSignOut }) {
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">Hatch.</strong></div>
      <section className="status-card">
        <span className="eyebrow">Connection</span>
        <h1>Hatch can't reach the service</h1>
        <p>{message || "Check your connection and try again."}</p>
        <small>Your saved access stays on this computer.</small>
        <button type="button" onClick={onRetry}>Retry</button>
        {onSignOut ? <button className="secondary" type="button" onClick={onSignOut}>Sign out / use another account</button> : null}
      </section>
    </main>
  );
}

function UnsupportedRoleScreen({ profile, onSignOut }) {
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">Hatch.</strong></div>
      <section className="status-card">
        <span className="eyebrow">Consumer Desktop</span>
        <h1>Use a buyer account in this app</h1>
        <p>{CONSUMER_DESKTOP_ROLE_MESSAGE}</p>
        <small>{profile.name} is signed in as a Creator.</small>
        <button type="button" onClick={onSignOut}>Sign out</button>
      </section>
    </main>
  );
}

function EmptyAgentsScreen({ profile, onBrowse, onRefresh, onSignOut, refreshing, error, notice }) {
  return (
    <main className="welcome-screen status-screen empty-agents-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">Hatch.</strong></div>
      <section className="status-card empty-agents-card">
        <div className="empty-agents-header">
          <span className="avatar">{profile.initials}</span>
          <span><strong>{profile.name}</strong><small>Signed in</small></span>
          <button className="profile-sign-out" type="button" onClick={onSignOut}>Sign out</button>
        </div>
        <span className="eyebrow">Your Creator Agents</span>
        <h1>Find an Agent built around a creator's proven method.</h1>
        <p>Your account is ready. Browse the catalog to find an Agent for your work.</p>
        {notice ? <p className="status-inline-notice" role="status">{notice}</p> : null}
        {error ? <p className="status-inline-error" role="status">{error}</p> : null}
        <button type="button" onClick={onBrowse}>Browse Creator Agents</button>
        <button className="secondary status-refresh" type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </section>
    </main>
  );
}

function SignInScreen({ onSignIn, status, error }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loading = status === "loading";

  function submit(event) {
    event.preventDefault();
    onSignIn({ email, password });
  }

  return (
    <main className="welcome-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">Hatch.</strong></div>
      <section className="sign-in-card">
        <span className="eyebrow">Welcome</span>
        <h1>Your trusted creator agents, in one place.</h1>
        <p>Sign in to use the Creator Agents available to your account.</p>
        <form className="sign-in-form" onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input autoCapitalize="none" autoComplete="email" spellCheck="false" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" disabled={loading} />
          </label>
          <label className="field">
            <span>Password</span>
            <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" disabled={loading} />
          </label>
          <button type="submit" disabled={loading || (!email.trim() || !password.trim())}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {error ? <small className="sign-in-error" role="alert">{error}</small> : null}
        <small>Hatch keeps you signed in on this computer until you sign out.</small>
      </section>
    </main>
  );
}

function HatchMessage() {
  const role = useMessage((message) => message.role);
  if (role !== "assistant") {
    return (
      <MessagePrimitive.Root className={`chat-message ${role}`}>
        <div className={`message-surface ${role}`}>
          <MessagePrimitive.Parts components={{ Text: PlainText }} />
        </div>
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className={`chat-message ${role}`}>
      <MessagePrimitive.GroupedParts groupBy={activityGroupPath} indicator="never">
        {renderAssistantTimelinePart}
      </MessagePrimitive.GroupedParts>
      <AssistantTurnTiming />
    </MessagePrimitive.Root>
  );
}

function renderAssistantTimelinePart({ part, children }) {
  switch (part.type) {
    case "group-activity":
      return <AssistantActivityBlock indices={part.indices}>{children}</AssistantActivityBlock>;
    case "group-tools":
      return <TimelineToolGroup indices={part.indices}>{children}</TimelineToolGroup>;
    case "text":
      return <AssistantMarkdownPart />;
    case "image":
      return <MessagePartPrimitive.Image />;
    case "tool-call":
      return part.toolUI ?? <HatchToolCall {...part} />;
    case "data":
      if (part.name === TURN_ACTIVITY_PART) return null;
      if (part.name === SKILL_ACTIVITY_PART) return <SkillActivityPart data={part.data} />;
      if (part.name === SKILL_RUN_ACTIVITY_PART) return <SkillRunActivityPart data={part.data} />;
      return part.dataRendererUI ?? null;
    default:
      return null;
  }
}

function AssistantActivityBlock({ indices, children }) {
  const approvals = useContext(ApprovalContext);
  const custom = useMessage((message) => message.metadata?.custom ?? {});
  const status = useMessage((message) => message.status);
  const parts = useMessage((message) => message.content ?? []);
  const groupParts = indices.map((index) => parts[index]).filter(Boolean);
  const isTurnActivity = groupParts.some(isTurnActivityPart);
  const visibleActivityParts = groupParts.filter(isActivityPart);
  const [now, setNow] = useState(Date.now());
  const isRunning = status?.type === "running";
  const [open, setOpen] = useState(isRunning && visibleActivityParts.length > 0);
  const hadVisibleActivity = useRef(visibleActivityParts.length > 0);

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    if (hadVisibleActivity.current || visibleActivityParts.length === 0) return;
    hadVisibleActivity.current = true;
    if (isRunning) setOpen(true);
  }, [isRunning, visibleActivityParts.length]);

  if (!isTurnActivity) return children;

  const startedAt = Number(custom.startedAt);
  const completedAt = Number(custom.completedAt ?? now);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, completedAt - startedAt) : undefined;
  const activityParts = Array.isArray(parts) ? parts.filter(isActivityPart) : [];
  const active = activeActivity(activityParts, approvals?.requests ?? {});
  const hasAnswerText = Array.isArray(parts) && parts.some((part) => part.type === "text" && part.text);
  const failed = status?.type === "incomplete" || custom.status === "failed";
  const filtered = custom.status === "content_filter";
  const summary = activitySummary({
    isRunning,
    failed,
    filtered,
    elapsedMs,
    activeLabel: active?.label ?? (isRunning && hasAnswerText ? "Answering" : "")
  });
  const icon = filtered ? "⊘" : failed ? "!" : isRunning ? active?.icon ?? "✦" : "✓";
  const tone = filtered || failed ? "failed" : isRunning ? "running" : "completed";
  const summaryContent = (
    <>
      <span className="assistant-activity-icon" aria-hidden="true"><ActivityGlyph icon={icon} /></span>
      <span
        className={`assistant-activity-title${isRunning ? " status-text-shimmer" : ""}`}
        style={isRunning ? { "--shimmer-spread": `${Math.max(24, summary.length * 2)}px` } : undefined}
      >
        {summary}
      </span>
      {visibleActivityParts.length > 0 ? (
        <ChevronDown className="activity-group-chevron" aria-hidden="true" />
      ) : null}
    </>
  );

  if (visibleActivityParts.length === 0) {
    return <div className={`assistant-activity-summary ${tone}`}>{summaryContent}</div>;
  }

  return (
    <details
      className={`assistant-activity-block ${tone}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="assistant-activity-summary expandable">{summaryContent}</summary>
      <div className="assistant-activity-items">{children}</div>
    </details>
  );
}

function AssistantTurnTiming() {
  const custom = useMessage((message) => message.metadata?.custom ?? {});
  if (!custom.turnTiming) return null;
  return (
    <details className="turn-timing">
      <summary>Timing</summary>
      <pre>{JSON.stringify(custom.turnTiming, null, 2)}</pre>
    </details>
  );
}

function isActivityPart(part) {
  return part?.type === "tool-call" || isSkillActivityPart(part) || isSkillRunActivityPart(part);
}

function isTurnActivityPart(part) {
  return part?.type === "data" && part.name === TURN_ACTIVITY_PART;
}

function activeActivity(parts, approvalRequests) {
  for (const part of [...parts].reverse()) {
    if (part.type === "tool-call") {
      const state = toolState(part, approvalRequests[part.toolCallId]);
      if (state === "approval") return { icon: "!", label: "Waiting for approval" };
      if (state === "running") {
        const display = toolDisplay(part.toolName);
        return {
          icon: display.icon,
          label: toolActionLabel(display, "running", toolTarget(part.args))
        };
      }
      continue;
    }
    if (isSkillRunActivityPart(part) && ["requested", "running"].includes(part.data?.status)) {
      return { icon: "◇", label: `Applying ${methodDisplayName(part.data?.name)}` };
    }
  }
  return null;
}

function TimelineToolGroup({ indices, children }) {
  const status = useMessage((message) => message.status);
  const [open, setOpen] = useState(status?.type === "running");
  const count = indices.length;
  if (count <= 1) return children;
  return (
    <details
      className="activity-tool-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="activity-group-icon" aria-hidden="true"><Wrench /></span>
        <span>Used {count} tools</span>
        <ChevronDown className="activity-group-chevron" aria-hidden="true" />
      </summary>
      <div className="activity-tool-items">
        {children}
      </div>
    </details>
  );
}

function PlainText({ text }) {
  return <p className="plain-text">{text}</p>;
}

const ACTIVITY_GLYPHS = {
  "◎": Globe2,
  "⌕": FileSearch,
  "▣": FileText,
  "☷": ListTree,
  "✎": FilePenLine,
  ">_": SquareTerminal,
  "Δ": GitCompareArrows,
  "↗": ExternalLink,
  "◇": Plug,
  "✓": Check,
  "⊘": Ban,
  "!": CircleAlert,
  "✦": LoaderCircle
};

function ActivityGlyph({ icon }) {
  const Icon = ACTIVITY_GLYPHS[icon] ?? Wrench;
  return <Icon className={icon === "✦" ? "activity-spinner" : undefined} />;
}

function AssistantMarkdownPart() {
  const status = useMessage((message) => message.status);
  return (
    <div className={`message-surface assistant${status?.type === "running" ? " streaming" : ""}`}>
      <MarkdownText />
    </div>
  );
}

function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      className="markdown-body"
      components={{
        li: MarkdownListItem,
        table: MarkdownTable
      }}
      containerClassName="markdown-container"
      controls={false}
      security={{
        defaultOrigin: globalThis.location?.origin ?? "http://localhost",
        allowedProtocols: ["http", "https", "mailto"],
        allowedImagePrefixes: ["http://", "https://", "data:"]
      }}
    />
  );
}

function MarkdownListItem({ children, className, node, ...props }) {
  const childArray = React.Children.toArray(children);
  const checkboxIndex = childArray.findIndex(isTaskCheckbox);

  if (checkboxIndex === -1) {
    return (
      <li className={className} data-streamdown="list-item" {...props}>
        {children}
      </li>
    );
  }

  const checkbox = childArray[checkboxIndex];
  const content = childArray
    .filter((_, index) => index !== checkboxIndex)
    .filter((child) => typeof child !== "string" || child.trim() !== "");

  return (
    <li className={joinClassNames("markdown-task-item", className)} data-streamdown="list-item" {...props}>
      <span className="markdown-task-checkbox">
        {React.cloneElement(checkbox, {
          className: joinClassNames(checkbox.props?.className, "markdown-checkbox")
        })}
      </span>
      <span className="markdown-task-content">{content}</span>
    </li>
  );
}

function MarkdownTable({ children, ...props }) {
  return (
    <div className="markdown-table-scroll" tabIndex={0} aria-label="Scrollable table">
      <table {...props}>{children}</table>
    </div>
  );
}

function isTaskCheckbox(child) {
  return React.isValidElement(child) && child.type === "input" && child.props?.type === "checkbox";
}

function joinClassNames(...classNames) {
  return classNames.filter(Boolean).join(" ") || undefined;
}

function reportTurnTiming(runId, timing, fullResponseAt) {
  const summary = summarizeTurnTiming(runId, timing, fullResponseAt);
  console.info("[hatch:turn-timing]", summary);
  return summary;
}

function HatchToolCall(props) {
  const approvals = useContext(ApprovalContext);
  const showNativeContextMenu = useContext(NativeContextMenuContext);
  const approvalRequest = approvals?.requests?.[props.toolCallId];
  const display = toolDisplay(props.toolName);
  const state = toolState(props, approvalRequest);
  const target = toolTarget(props.args);
  const label = toolActionLabel(display, state, target);
  const summary = toolResultSummary(props);
  const artifactTarget = toolArtifactTarget(props);
  const copyTarget = toolResultCopyTarget(props);
  const pendingApproval = approvalRequest?.status === "pending";

  return (
    <div
      className={`tool-call ${state}`}
      onContextMenu={(event) => showNativeContextMenu?.(event, {
        kind: "tool-result",
        target: copyTarget
      })}
    >
      <div className="tool-summary">
        <span className="tool-icon"><ActivityGlyph icon={display.icon} /></span>
        <span className="tool-label">{label}</span>
        {summary ? (
          <span
            className="tool-meta"
            onContextMenu={artifactTarget ? (event) => {
              const intercepted = showNativeContextMenu?.(event, {
                kind: "artifact",
                target: artifactTarget
              });
              if (intercepted) event.stopPropagation();
            } : undefined}
          >
            {summary}
          </span>
        ) : null}
      </div>
      {pendingApproval || approvalRequest?.status ? <div className="tool-detail">
        {pendingApproval ? (
          <div className="approval-gate">
            <div>
              <strong>Allow this action?</strong>
              <p>{approvalRequest.message.reason || approvalReasonText(approvalRequest.message)}</p>
              {approvalRequest.message.name === "shell_exec" && fullShellCommand(approvalRequest.message) ? (
                <pre className="approval-command" aria-label="Full shell command">{fullShellCommand(approvalRequest.message)}</pre>
              ) : null}
            </div>
            <div className="approval-actions">
              <button type="button" onClick={() => approvals.resolveToolApproval(props.toolCallId, true)}>
                Allow
              </button>
              <button type="button" className="secondary" onClick={() => approvals.resolveToolApproval(props.toolCallId, false)}>
                Deny
              </button>
            </div>
          </div>
        ) : approvalRequest?.status ? (
          <div className={`approval-resolution ${approvalRequest.status}`}>
            {approvalRequest.status === "approved" ? "Allowed" : "Not allowed"}
          </div>
        ) : null}
      </div> : null}
    </div>
  );
}

function SkillActivityPart({ data }) {
  const status = data.status === "invoked" ? "invoked" : "activated";
  const display = skillActivityDisplay(data);
  return (
    <div className={`activity-row skill-activity ${status}`}>
      <span className="skill-icon">{display.icon}</span>
      <span className="skill-label">{display.label}</span>
      <span className="skill-meta">{display.meta}</span>
    </div>
  );
}

function SkillRunActivityPart({ data }) {
  const status = data.status;
  const methodName = methodDisplayName(data.name);
  const label = status === "completed"
    ? `Applied ${methodName}`
    : status === "failed"
      ? `Could not apply ${methodName}`
      : status === "cancelled"
        ? `Stopped ${methodName}`
        : status === "requested"
          ? `Preparing ${methodName}`
          : `Applying ${methodName}`;
  const icon = status === "completed" ? "◆" : status === "failed" || status === "cancelled" ? "!" : "◇";
  return (
    <div className={`activity-row skill-activity skill-run-${status}`}>
      <span className="skill-icon">{icon}</span>
      <span className="skill-label">{label}</span>
      <span className="skill-meta">{data.error?.message || "Creator method"}</span>
    </div>
  );
}

function approvalReasonText(message) {
  if (message.name === "file_write") {
    return `Write ${toolTarget(message.arguments) || "a file"} in the selected workspace.`;
  }
  if (message.name === "file_patch") {
    return `Update ${toolTarget(message.arguments) || "a file"} in the selected workspace.`;
  }
  if (message.name === "shell_exec") {
    return "Run this shell command in the selected workspace.";
  }
  return `Run ${message.name} locally in the selected workspace.`;
}

function fullShellCommand(message) {
  const command = message?.arguments?.command;
  return typeof command === "string" ? command.trim() : "";
}

function parseStoredJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function skillActivityDisplay(data) {
  const status = data.status === "invoked" ? "invoked" : "activated";
  const methodName = methodDisplayName(data.name);
  const label = status === "invoked"
    ? `Applied ${methodName}`
    : `Using ${methodName}`;
  return {
    icon: status === "invoked" ? "◆" : "◇",
    label,
    meta: "Creator method"
  };
}

function skillRunStatusLabel(event) {
  const methodName = methodDisplayName(event.name);
  if (event.status === "completed") return `Creator method applied: ${methodName}`;
  if (event.status === "failed") return `Couldn't apply Creator method: ${methodName}`;
  if (event.status === "cancelled") return `Stopped applying Creator method: ${methodName}`;
  if (event.status === "requested") return `Preparing Creator method: ${methodName}`;
  return `Applying Creator method: ${methodName}`;
}

function methodDisplayName(name) {
  const value = String(name ?? "").trim();
  if (!value) return "Creator method";
  if (!/^[a-z0-9_-]+$/.test(value)) return value;
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function toolArtifactTarget(part) {
  const candidates = [
    part?.result?.path,
    part?.result?.artifact_path,
    part?.result?.file_path,
    part?.args?.path
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim())?.trim() || "";
}

function artifactRelativePath(artifactPath, workspaceRoot) {
  const artifact = String(artifactPath || "").trim().replaceAll("\\", "/");
  const root = String(workspaceRoot || "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!artifact || !root) return "";
  const prefix = `${root}/`;
  if (artifact.startsWith(prefix)) return artifact.slice(prefix.length);
  // Runtime artifacts may already be workspace-relative. Absolute paths that
  // do not share the current display root remain untrusted and are rejected;
  // Rust performs the authoritative containment check again.
  if (artifact.startsWith("/") || /^[A-Za-z]:\//.test(artifact)) return "";
  return artifact;
}

function toolResultCopyTarget(part) {
  const result = part?.result;
  if (typeof result?.output === "string") return result.output;
  if (typeof result?.content === "string") return result.content;
  if (typeof result?.diff === "string") return result.diff;
  if (result && typeof result === "object") {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      // Fall through to the tool call id, which is still a useful support
      // reference if a malformed tool result cannot be serialized.
    }
  }
  return String(part?.toolCallId || part?.tool_call_id || "").trim();
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return error.message;
  return JSON.stringify(error);
}

async function prepareNativeDropAttachments(files) {
  const pending = Array.isArray(files) ? files : [];
  const seen = new Set();
  const preparedById = new Map();
  const missingIds = [];
  for (const file of pending) {
    const contextId = typeof file?.contextId === "string" ? file.contextId : "";
    if (!contextId || seen.has(contextId)) {
      throw new Error("The dropped-file list is invalid. Remove it and drop the file again.");
    }
    seen.add(contextId);
    if (file?.attachment?.attachment_id === contextId) {
      preparedById.set(contextId, file.attachment);
    } else {
      missingIds.push(contextId);
    }
  }

  if (missingIds.length > 0) {
    const snapshots = await invokeTauri("read_native_drop_contexts", { contextIds: missingIds });
    if (!Array.isArray(snapshots) || snapshots.length !== missingIds.length) {
      throw new Error("Native attachment snapshots were incomplete. Drop the files again.");
    }
    const expectedIds = new Set(missingIds);
    for (const snapshot of snapshots) {
      const normalized = normalizeNativeDropAttachment(snapshot);
      if (!normalized || !expectedIds.delete(normalized.contextId) || preparedById.has(normalized.contextId)) {
        throw new Error("Native attachment snapshot was invalid. Drop the files again.");
      }
      preparedById.set(normalized.contextId, normalized.attachment);
    }
    if (expectedIds.size > 0) {
      throw new Error("Native attachment snapshots did not match the dropped files.");
    }
  }

  return {
    attachments: pending.map((file) => preparedById.get(file.contextId)),
    files: pending.map((file) => file.attachment?.attachment_id === file.contextId
      ? file
      : { ...file, attachment: preparedById.get(file.contextId) })
  };
}

async function discardNativeDropContexts(contextIds) {
  const ids = [...new Set((Array.isArray(contextIds) ? contextIds : [])
    .filter((contextId) => typeof contextId === "string" && contextId.startsWith("drop_")))];
  if (ids.length === 0 || !globalThis.window?.__TAURI_INTERNALS__) return;
  try {
    await invokeTauri("discard_native_drop_contexts", { contextIds: ids });
  } catch {
    // The handle may already have been consumed or expired. It never carries
    // a path, so cleanup failure cannot increase renderer authority.
  }
}

async function invokeTauri(command, args) {
  return invokeDesktopCommand(command, args, {
    invokeImpl: invoke,
    packaged: Boolean(globalThis.window?.__TAURI_INTERNALS__)
  });
}

createRoot(document.getElementById("root")).render(<App />);
