import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { draftAttachmentReference } from "./conversation-draft.js";
import { createConversationSessionManager } from "./conversation-session.js";
import { createConversationOwner } from "./conversation-owner.js";
import { DesktopComposerInput } from "./desktop-composer-input.jsx";
import { ConversationRuntimeProvider } from "./conversation-runtime-provider.jsx";
import { createRoot } from "react-dom/client";
import "@hatch/ui/fonts";
import "@hatch/ui/theme.css";
import {
  Button,
  ButtonControl,
  DropdownMenu,
  FormField,
  HatchBrand,
  HatchUIProvider,
  InlineAlert,
  IconButton,
  Input,
  NavigationItem,
  Select,
  SelectControl
} from "@hatch/ui";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
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
  Paperclip,
  Plug,
  Plus,
  RefreshCw,
  Settings,
  ShieldAlert,
  Square,
  SquareTerminal,
  Wrench
} from "lucide-react";
import "streamdown/styles.css";
import "./styles.css";
import {
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_OPTIONS,
  creatorAgentFromBoundSession,
  creatorAgentFromEntitlement,
  PLATFORM_LOCAL_TOOLS,
  normalizePermissionPolicy,
  permissionPolicyLabel,
  workspaceGrantLabel
} from "./product-policy.js";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";
import {
  assertConversationIdentity,
  createConversation,
  canConnectConversation,
  getConversationSnapshot,
  getConversationAsset,
  getConversationHistoryPage,
  getConversationJournalPage,
  getConversationToolDetail,
  getConversationRun,
  getConversationSubmission,
  reconcileActiveRunFromSnapshot,
  isServerConversationId,
  isTerminalRunStatus,
  listConversations,
  restorableConversationId,
  updateConversation
} from "./conversation-client.js";
import { bridgeConversationHistory, drainConversationJournal, includeActiveConversationRun, mergeConversationPage, validateHistoryPage, validateSnapshotPage } from "./conversation-pagination.js";
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
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  SYSTEM_LANGUAGE,
  createTranslator,
  normalizeLanguagePreference,
  resolveLanguage
} from "./i18n.js";
import {
  importLegacyProfileSettings,
  purgeLegacySensitiveStorage
} from "./legacy-settings-migration.js";
import {
  normalizeWorkspaceGrant,
  validateRestoredWorkspace,
  workspacePickerSelection
} from "./workspace-restore.js";
import {
  usesLegacyProfileRunFallback
} from "./desktop-window-context.js";
import { createTurnAccessSnapshot, requirePendingAccessSnapshot } from "./turn-access-snapshot.js";
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
  subscribeNativeCommands,
  taskStartFromLocation
} from "./native-commands.js";
import {
  normalizeProductOpenPayload,
  PRODUCT_OPEN_EVENT
} from "./product-open.js";
import {
  MAX_NATIVE_DROP_SOURCE_BYTES,
  normalizeNativeDropAttachment,
  normalizeNativeDropFile
} from "./native-drop-context.js";
import { readLocalAttachmentImage } from "./local-attachment-preview.js";
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
  shouldHideWorkedSummary,
  terminalTimelineParts,
  toolActionLabel,
  toolDisplay,
  toolResultSummary,
  toolState,
  toolTarget,
  upsertTimelinePart
} from "./activity-ui.js";

const PROTOCOL_VERSION = "0.8";
const OUTPUT_FILTERED_COPY = "This response was blocked by the output safety check.";
const DEFAULT_RUNTIME_URL = import.meta.env.VITE_HATCH_RUNTIME_URL || "wss://hatch.tokenquadrant.cn/v1/runtime";
const DEFAULT_AUTH_URL = import.meta.env.VITE_HATCH_AUTH_URL || "https://hatch.tokenquadrant.cn";
const BROWSE_CATALOG_URL = import.meta.env.VITE_HATCH_CATALOG_URL || "https://hatch.tokenquadrant.cn/explore";
const EMPTY_PROFILE = Object.freeze({ id: "anonymous", name: "User", initials: "U" });
const DEFAULT_PERMISSION_MODE = DEFAULT_PERMISSION_POLICY;
const MAX_AUTOMATIC_RUNTIME_RETRIES = 4;
const ApprovalContext = createContext(null);
const NativeContextMenuContext = createContext(null);
const I18nContext = createContext(createTranslator(DEFAULT_LANGUAGE));

function useI18n() {
  return useContext(I18nContext);
}

function auxiliaryWindowMode(locationLike = globalThis.location) {
  const params = new URLSearchParams(typeof locationLike?.search === "string" ? locationLike.search : "");
  if (params.get("settings") === "1") return "settings";
  if (params.get("about") === "1") return "about";
  return "";
}

function DesktopAuxiliaryWindow({ kind }) {
  const about = kind === "about";
  const [languagePreference, setLanguagePreference] = useState(SYSTEM_LANGUAGE);
  const language = resolveLanguage(languagePreference, browserPreferredLocales());
  const t = useMemo(() => createTranslator(language), [language]);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  }, [language]);
  return (
    <main className="desktop-auxiliary-window" aria-labelledby="auxiliary-window-title">
      <header className="desktop-auxiliary-header" data-tauri-drag-region>
        <HatchBrand className="desktop-auxiliary-brand" aria-label="Hatch." />
        <div>
          <h1 id="auxiliary-window-title">{about ? "About Hatch" : t("settings.title")}</h1>
        </div>
      </header>
      {about ? (
        <section className="desktop-auxiliary-content">
          <p className="desktop-auxiliary-lede">Creator agents, on your terms.</p>
          <p>Hatch keeps the desktop boundary native while React renders the conversation work surface.</p>
          <dl className="desktop-auxiliary-facts">
          <div><dt>Version</dt><dd>0.1.32</dd></div>
            <div><dt>Architecture</dt><dd>Tauri Hybrid</dd></div>
          </dl>
        </section>
      ) : (
        <section className="desktop-auxiliary-content">
          <AuxiliaryLanguageSettings onLanguageChange={setLanguagePreference} />
        </section>
      )}
    </main>
  );
}

// Contract marker: function AuxiliaryLanguageSettings()
function AuxiliaryLanguageSettings({ onLanguageChange }) {
  const settingsStoreRef = useRef(null);
  if (!settingsStoreRef.current) {
    settingsStoreRef.current = createTauriSettingsStore(invoke, {
      strict: typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__)
    });
  }
  const systemLanguage = resolveLanguage(SYSTEM_LANGUAGE, browserPreferredLocales());
  const [preference, setPreference] = useState(SYSTEM_LANGUAGE);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const language = resolveLanguage(preference, browserPreferredLocales());
  const t = useMemo(() => createTranslator(language), [language]);

  useEffect(() => {
    let cancelled = false;
    void settingsStoreRef.current.load().then(() => {
      if (cancelled) return;
       const savedPreference = normalizeLanguagePreference(settingsStoreRef.current.getApp("language", SYSTEM_LANGUAGE));
       setPreference(savedPreference);
       onLanguageChange?.(savedPreference);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [onLanguageChange]);

  async function updateLanguage(value) {
    const next = normalizeLanguagePreference(value);
    setPreference(next);
    onLanguageChange?.(next);
    setSaveError("");
    setSaving(true);
    try {
      await settingsStoreRef.current.setApp("language", next);
      window.dispatchEvent(new CustomEvent("hatch-language-preference", { detail: { language: next } }));
      if (window.__TAURI_INTERNALS__) {
        void emit("hatch://language-preference", { language: next }).catch(() => {});
      }
    } catch {
      setSaveError(t("settings.language.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="desktop-auxiliary-language" aria-busy={!ready || saving}>
      <div className="desktop-auxiliary-row">
        <span>{t("settings.language.label")}</span>
        <Select
          className="desktop-language-select"
          label={t("settings.language.label")}
          disabled={!ready || saving}
          value={preference}
          onValueChange={(value) => void updateLanguage(value)}
          options={LANGUAGE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.value === SYSTEM_LANGUAGE
              ? `${t(option.labelKey)} (${languageNativeName(systemLanguage)})`
              : option.nativeLabel
          }))}
        />
      </div>
      {saveError ? <small className="desktop-settings-save-error" role="alert">{saveError}</small> : null}
    </div>
  );
}

const ConversationAssetContext = createContext(null);
const ConversationSessionContext = createContext(null);

function useConversationUiState(key, initial) {
  const session = useContext(ConversationSessionContext);
  const [fallback, setFallback] = useState(initial);
  const state = useSyncExternalStore(session?.subscribe ?? emptySessionSubscribe,
    session?.snapshot ?? emptySessionSnapshot);
  const value = Object.hasOwn(state.ui, key) ? state.ui[key] : fallback;
  return [value, (update) => session ? session.setUi(key, update, initial) : setFallback(update)];
}
const emptySessionSubscribe = () => () => {};
const EMPTY_SESSION_UI = { ui: {} };
const emptySessionSnapshot = () => EMPTY_SESSION_UI;


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
  const [buyerSession, setBuyerSession] = useState(null);
  const authEpochRef = useRef(0);
  const authTeardownRef = useRef(false);
  const [selectedEntitlementId, setSelectedEntitlementId] = useState("");
  const [sessionCloseError, setSessionCloseError] = useState("");
  const [conversationId, setConversationId] = useState(() => conversationIdFromLocation() || "desktop-chat");
  const sessionManagerRef = useRef(null);
  if (!sessionManagerRef.current) sessionManagerRef.current = createConversationSessionManager();
  const sessionManager = sessionManagerRef.current;
  const ownerActivationRef = useRef(null);
  const ownerErrorRef = useRef(null);
  const pendingOwnerActivationRef = useRef(null);
  const conversationOwnerRef = useRef(null);
  ownerErrorRef.current = (error) => setStatus(errorMessage(error));
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const owner = createConversationOwner({
      invoke: invokeTauri, listen,
      onActivate: (payload) => ownerActivationRef.current?.(payload),
      onError: (error) => ownerErrorRef.current?.(error)
    });
    conversationOwnerRef.current = owner;
    const dispose = () => owner.dispose();
    window.addEventListener("pagehide", dispose);
    return () => {
      window.removeEventListener("pagehide", dispose);
      owner.dispose();
      if (conversationOwnerRef.current === owner) conversationOwnerRef.current = null;
    };
  }, []);
  const conversationSession = sessionManager.get({
    accountId: buyerSession?.profile?.id || "",
    entitlementId: selectedEntitlementId,
    conversationId
  });
  sessionManager.select(conversationSession);
  if (window.__TAURI_INTERNALS__) {
    conversationSession.ensureOwnership = () => {
      if (!conversationOwnerRef.current) throw new Error("Conversation owner listener is not ready");
      return conversationOwnerRef.current.claim(conversationSession);
    };
  }
  const sessionState = useSyncExternalStore(conversationSession.subscribe, conversationSession.snapshot);
  conversationSession.localSettingsInitialized = true;
  const sessionStateField = (name) => [sessionState[name], (update) => conversationSession.set(name, update)];
  const socketRef = conversationSession.ref("socketRef", null);
  // Runtime messages arrive on a WebSocket listener created before React has
  // necessarily re-rendered after a folder grant. Local tool execution must
  // therefore use the latest explicit grant, not a stale render closure.
  const workspaceRef = conversationSession.ref("workspaceRef", "");
  const workspaceGrantRef = conversationSession.ref("workspaceGrantRef", null);
  const activeRunRef = conversationSession.ref("activeRunRef", null);
  const runtimeCapabilitiesRef = conversationSession.ref("runtimeCapabilitiesRef", { richAssets: false });
  const permissionRef = conversationSession.ref("permissionRef", DEFAULT_PERMISSION_MODE);
  const imeRef = useRef({ composing: false });
  const connectedRef = conversationSession.ref("connectedRef", false);
  const connectingRef = conversationSession.ref("connectingRef", false);
  const connectionTokenRef = conversationSession.ref("connectionTokenRef", 0);
  const connectionConfigRef = conversationSession.ref("connectionConfigRef", null);
  const reconnectTimerRef = conversationSession.ref("reconnectTimerRef", null);
  const reconnectAttemptRef = conversationSession.ref("reconnectAttemptRef", 0);
  const intentionalDisconnectRef = conversationSession.ref("intentionalDisconnectRef", true);
  const approvalResolversRef = conversationSession.ref("approvalResolversRef", new Map());
  const pendingLocalToolsRef = conversationSession.ref("pendingLocalToolsRef", new Map());
  const buyerSessionRef = useRef(null);
  const textRevealSinkRef = conversationSession.ref("textRevealSinkRef", null);
  const textRevealRef = conversationSession.ref("textRevealRef", null);
  const entitlementRefreshRef = useRef(false);
  const lastEntitlementRefreshRef = useRef(0);
  const nativeCommandHandlersRef = useRef({});
  const nativeContextTargetsRef = useRef(new Map());
  const nativeContextTargetSequenceRef = useRef(0);
  const requestedConversationIdRef = useRef(conversationIdFromLocation());
  const requestedTaskStartRef = useRef(taskStartFromLocation());
  const requestedConversationBindingRef = useRef(conversationBindingFromLocation());
  const pendingProductOpenBindingRef = useRef(null);
  // Preserve the launch role even after Conversation Library hydration clears
  // the one-shot URL request. Dynamic Conversation windows must never write
  // their workspace back into the main window's legacy profile fallback.
  const conversationWindowRef = useRef(Boolean(requestedConversationIdRef.current));
  const workspaceRestoredAccountRef = useRef("");
  const navigationRequestRef = useRef(0);
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
  const conversationCursorRef = conversationSession.ref("conversationCursorRef", 0);
  const pendingTaskStartRef = conversationSession.ref("pendingTaskStartRef", "");
  const taskStartSentRef = conversationSession.ref("taskStartSentRef", new Set());
  const taskBriefRef = conversationSession.ref("taskBriefRef", null);
  const viewportRef = useRef(null);
  const viewportScrollTopRef = conversationSession.ref("viewportScrollTopRef", 0);
  const viewportScrollPersistTimerRef = conversationSession.ref("viewportScrollPersistTimerRef", null);
  // Window context is deliberately separate from profile preferences. A
  // second Conversation window must be able to use another Conversation and
  // Workspace without last-writer-wins updates from the first window.
  const windowContextRef = useRef({});
  const [serverUrl] = useState(DEFAULT_RUNTIME_URL);
  const [workspace, setWorkspace] = sessionStateField("workspace");
  const [workspaceDraft, setWorkspaceDraft] = sessionStateField("workspaceDraft");
  const [workspaceGrant, setWorkspaceGrant] = sessionStateField("workspaceGrant");
  const [workspaceDraftGrant, setWorkspaceDraftGrant] = sessionStateField("workspaceDraftGrant");
  const [workspaceSettingsReady] = sessionStateField("workspaceSettingsReady");
  const [authState, setAuthState] = useState("loading");
  const [startupError, setStartupError] = useState("");
  const [settingsMigrationNotice, setSettingsMigrationNotice] = useState("");
  const [settingsReady, setSettingsReady] = useState(false);
  const [languagePreference, setLanguagePreference] = useState(SYSTEM_LANGUAGE);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [entitlementRefreshing, setEntitlementRefreshing] = useState(false);
  const [entitlementError, setEntitlementError] = useState("");

  const [creatorAgentEntitlements, setCreatorAgentEntitlements] = useState([]);

  const selectedEntitlementIdRef = useRef("");
  const [signInStatus, setSignInStatus] = useState("idle");
  const [signInError, setSignInError] = useState("");
  const [workspaceGranted, setWorkspaceGranted] = sessionStateField("workspaceGranted");
  const [droppedFiles, storeDroppedFiles] = sessionStateField("droppedFiles");
  const droppedFilesRef = conversationSession.ref("droppedFilesRef", []);
  const [permissionMode, setPermissionMode] = sessionStateField("permissionMode");

  const [conversations, setConversations] = useState([]);
  const [conversationLibraryStatus, setConversationLibraryStatus] = useState("idle");
  const [conversationLibraryError, setConversationLibraryError] = useState("");
  const [conversationLibraryRetryNonce, setConversationLibraryRetryNonce] = useState(0);
  const [renamingConversationId, setRenamingConversationId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [status, setStatus] = sessionStateField("status");
  const [connected, setConnected] = sessionStateField("connected");
  const [runtimeRetryExhausted, setRuntimeRetryExhausted] = sessionStateField("runtimeRetryExhausted");
  const [chatLoading, setChatLoading] = sessionStateField("chatLoading");
  const [running, setRunning] = sessionStateField("running");
  const [messages, storeMessages] = sessionStateField("messages");
  const messagesRef = conversationSession.ref("messagesRef", []);
  const setMessages = useCallback((update) => {
    const next = typeof update === "function" ? update(messagesRef.current) : update;
    messagesRef.current = next;
    storeMessages(next);
  }, [conversationSession]);
  const historyPageRef = conversationSession.ref("historyPageRef", null);
  const [historyPage, setHistoryPage] = sessionStateField("historyPage");
  const olderRequestRef = conversationSession.ref("olderRequestRef", null);
  const [olderLoading, setOlderLoading] = sessionStateField("olderLoading");
  const [olderError, setOlderError] = sessionStateField("olderError");
  const historyAnchorRef = conversationSession.ref("historyAnchorRef", null);
  useLayoutEffect(() => {
    const anchor = historyAnchorRef.current;
    if (!anchor) return;
    historyAnchorRef.current = null;
    if (anchor.token !== connectionTokenRef.current || anchor.viewport !== viewportRef.current) return;
    const offset = anchor.element?.isConnected
      ? anchor.element.getBoundingClientRect().top - anchor.offset
      : anchor.viewport.scrollHeight - anchor.height;
    anchor.viewport.scrollTop = anchor.top + offset;
    conversationSession.saveReadingPosition(anchor.viewport);
  }, [conversationSession, messages]);
  const [briefTask, setBriefTask] = useState(null);
  const [taskBrief, setTaskBrief] = sessionStateField("taskBrief");
  const [composerDraft, setComposerDraft] = sessionStateField("composerDraft");
  const [composerRestoreRequest, setComposerRestoreRequest] = sessionStateField("composerRestoreRequest");
  const [approvalRequests, setApprovalRequests] = sessionStateField("approvalRequests");
  const creatorAgent = sessionState.creatorAgent ?? creatorAgentFromEntitlement(
    creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId)
  );
  const [sidebarPreference, setSidebarPreference] = useState("open");
  const [sidebarWidth, setSidebarWidth] = useState(DESKTOP_LAYOUT.sidebar.default);
  const [inspectorPreference, setInspectorPreference] = useState("open");
  const [inspectorWidth, setInspectorWidth] = useState(DESKTOP_LAYOUT.inspector.default);
  const [applicationZoom, setApplicationZoom] = useState(DESKTOP_ZOOM.default);
  const [windowLayoutReady, setWindowLayoutReady] = useState(false);
  const [windowContextReady, setWindowContextReady] = useState(false);
  const [windowStateRestored, setWindowStateRestored] = useState(false);
  const composerDraftRef = conversationSession.ref("composerDraftRef", "");
  const buyerProfile = buyerSession?.profile ?? EMPTY_PROFILE;
  const draftKey = JSON.stringify([buyerProfile.id || "", conversationId]);
  const sessionDraftKeyRef = conversationSession.ref("sessionDraftKeyRef", draftKey);
  sessionDraftKeyRef.current = draftKey;
  const draftSessionRef = conversationSession.ref("draftSessionRef", null);
  const submissionPreparingRef = conversationSession.ref("submissionPreparingRef", false);
  const [draftState, setDraftState] = sessionStateField("draftState");
  const [draftRetry, setDraftRetry] = sessionStateField("draftRetry");
  const draftEditable = draftState.key === draftKey && ["ready", "saving", "error"].includes(draftState.status)
    && draftSessionRef.current?.key === draftKey;
  const pendingSubmission = draftSessionRef.current?.key === draftKey ? draftSessionRef.current.session.snapshot().pending : null;
  const signedIn = authState === "signed-in";
  const language = resolveLanguage(languagePreference, browserPreferredLocales());
  const t = useMemo(() => createTranslator(language), [language]);
  useEffect(() => {
    taskBriefRef.current = taskBrief;
  }, [taskBrief]);
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = language;
  }, [language]);

  // Settings is a separate Tauri WebView. Persisting the preference there is
  // not enough to update this main window: browser events stay inside their
  // source WebView, so subscribe to the app-wide event as well. This keeps a
  // language change live without requiring a restart (or a second bootstrap).
  useEffect(() => {
    const applyLanguagePreference = (value) => {
      const next = typeof value === "string" ? value : value?.language;
      if (typeof next !== "string") return;
      setLanguagePreference(normalizeLanguagePreference(next));
    };
    const handleBrowserEvent = (event) => applyLanguagePreference(event?.detail);
    window.addEventListener("hatch-language-preference", handleBrowserEvent);

    if (!window.__TAURI_INTERNALS__) {
      return () => window.removeEventListener("hatch-language-preference", handleBrowserEvent);
    }

    let disposed = false;
    let unlisten;
    void listen("hatch://language-preference", ({ payload }) => {
      if (disposed) return;
      applyLanguagePreference(payload);
    }).then((dispose) => {
      unlisten = dispose;
      if (disposed) unlisten?.();
    }).catch(() => {});

    return () => {
      disposed = true;
      window.removeEventListener("hatch-language-preference", handleBrowserEvent);
      unlisten?.();
    };
  }, []);

  // A live socket is not enough to make the current thread usable. The
  // Conversation Library must have selected a server-issued Conversation;
  // every user-facing surface derives its state from this same readiness bit.
  const conversationReady = connected
    && conversationLibraryStatus === "ready"
    && isServerConversationId(conversationId);
  const conversationLoadingKey = desktopConversationLoadingKey({
    conversationReady,
    conversationLibraryStatus,
    windowStateRestored,
    chatLoading,
    status,
    runtimeRetryExhausted,
    intentionallyOffline: intentionalDisconnectRef.current && !chatLoading,
    workspaceGranted,
    hasConversation: isServerConversationId(conversationId)
  });
  buyerSessionRef.current = buyerSession;

  useEffect(() => {
    const title = signedIn ? creatorAgentContextTitle(creatorAgent) : "Hatch";
    if (typeof document !== "undefined") document.title = title;
    if (!window.__TAURI_INTERNALS__) return;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [creatorAgent, signedIn]);

  useEffect(() => {
    conversationLibraryStatusRef.current = conversationLibraryStatus;
  }, [conversationLibraryStatus]);

  useEffect(() => {
    if (!buyerProfile.id || !isServerConversationId(conversationId)) return;
    void conversationSession.openDraft(invokeTauri).catch((error) => {
      setDraftState({ key: draftKey, status: "unavailable", error: errorMessage(error) });
    });
    // Navigation retains the native draft lease and pending receipt owner.
  }, [conversationSession, draftRetry]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let disposed = false;
    let unlisten;
    void getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      setSessionCloseError("");
      try {
        await sessionManager.closeAll();
        await getCurrentWindow().destroy();
      } catch (error) {
        setSessionCloseError(errorMessage(error));
      }
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  textRevealSinkRef.current = appendAssistantText;
  if (!textRevealRef.current) {
    textRevealRef.current = createTextRevealController({
      onReveal: ({ assistantId, content }) => {
        textRevealSinkRef.current?.(assistantId, content);
      },
      shouldRevealImmediately: () => (
        !sessionManager.isSelected(conversationSession)
        || document.visibilityState !== "visible"
        || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      )
    });
  }

  selectedEntitlementIdRef.current = selectedEntitlementId;

  function getProfileSetting(key, fallback = undefined, profileId = buyerProfile.id) {
    const context = windowContextRef.current || {};
    if (key === "workspace_grant") return context.workspaceGrant ?? fallback;
    if (key === "permission_mode") return context.permissionMode ?? fallback;
    if (key === "last_selected_entitlement_id") return context.entitlementId ?? fallback;
    if (key === "conversation_id") return context.conversationId ?? fallback;
    if (key === "conversation_id_by_entitlement") {
      return context.entitlementId && context.conversationId
        ? { [context.entitlementId]: context.conversationId }
        : fallback;
    }
    return fallback;
  }

  function setProfileSetting(key, value, profileId = buyerProfile.id) {
    if (key === "workspace_grant") patchWindowContext({ workspaceGrant: value || null });
    else if (key === "permission_mode") patchWindowContext({ permissionMode: value || null });
    else if (key === "last_selected_entitlement_id") patchWindowContext({ entitlementId: value || null });
    else if (key === "conversation_id") patchWindowContext({ conversationId: value || null });
  }

  function persistWorkspaceGrant(grant, profileId = buyerProfile.id) {
    // An explicit validated selection supersedes any older restore callback.
    conversationSession.ref("workspaceRestoreRevision", 0).current++;
    conversationSession.set("workspaceSettingsReady", true);
    patchWindowContext({ workspaceGrant: grant });
  }

  function beginWorkspaceRestore(targetSession) {
    const revision = targetSession.ref("workspaceRestoreRevision", 0);
    const token = ++revision.current;
    targetSession.set("workspaceSettingsReady", false);
    return () => !targetSession.disposed && revision.current === token;
  }

  function patchWindowContext(patch = {}) {
    if (!sessionManager.isSelected(conversationSession)) return;
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
    const persistedContext = {};
    if (Object.hasOwn(patch, "conversationId")) persistedContext.conversationId = next.conversationId || null;
    if (Object.hasOwn(patch, "entitlementId")) persistedContext.entitlementId = next.entitlementId || null;
    if (Object.hasOwn(patch, "creatorId")) persistedContext.creatorId = next.creatorId || null;
    if (Object.hasOwn(patch, "productId")) persistedContext.productId = next.productId || null;
    if (Object.hasOwn(patch, "workspaceGrant")) {
      persistedContext.workspaceGrant = normalizeWorkspaceGrant(next.workspaceGrant);
    }
    if (Object.hasOwn(patch, "permissionMode")) persistedContext.permissionMode = next.permissionMode || null;
    if (Object.keys(persistedContext).length === 0) return;
    void invokeTauri("patch_window_settings", { patch: { context: persistedContext } }).catch(() => {});
  }

  function setComposerDraftValue(value) {
    if (sessionDraftKeyRef.current !== draftKey) return;
    const next = String(value ?? "");
    composerDraftRef.current = next;
    setComposerDraft(next);
    if (draftSessionRef.current?.key === draftKey) draftSessionRef.current.session.update({ text: next });
  }

  function setDroppedFiles(update) {
    if (sessionDraftKeyRef.current !== draftKey) return;
    const next = typeof update === "function" ? update(droppedFilesRef.current) : update;
    droppedFilesRef.current = next;
    storeDroppedFiles(next);
    if (draftSessionRef.current?.key === draftKey) {
      draftSessionRef.current.session.update({ attachments: next.map(draftAttachmentReference) });
    }
  }

  function restoreComposerDraft(value) {
    if (sessionDraftKeyRef.current !== draftKey) return;
    const next = String(value ?? "");
    setComposerDraftValue(next);
    setComposerRestoreRequest((current) => ({
      nonce: current.nonce + 1,
      value: next
    }));
  }

  function publishDraftSession(holder) {
    if (holder !== draftSessionRef.current) return;
    conversationSession.publishDraft();
  }

  async function reconcilePendingSubmission() {
    const holder = draftSessionRef.current;
    const pending = holder?.session.snapshot().pending;
    if (!pending) return "none";
    const result = await getConversationSubmission(serverUrl, buyerSessionRef.current?.accessToken,
      conversationBindingFor(), holder.session.scope.conversationId, pending.runId);
    if (draftSessionRef.current !== holder || sessionDraftKeyRef.current !== holder.key) return "waiting";
    const currentPending = holder.session.snapshot().pending;
    // A socket acknowledgement may have cleared this submission while the
    // receipt lookup was in flight. Never restore or overwrite it afterward.
    if (!currentPending || currentPending.runId !== pending.runId
      || currentPending.clientMessageId !== pending.clientMessageId) return "none";
    if (result.submission) {
      if (!await holder.session.acceptSubmission(result.submission)) throw new Error("Submission identity does not match the saved message.");
      publishDraftSession(holder);
      return "accepted";
    }
    if (!result.run) {
      if (activeRunRef.current?.runId === pending.runId) {
        activeRunRef.current = null;
        setRunning(false);
        patchWindowContext({ activeRun: null });
      }
      if (!pending.accessSnapshot) {
        // Read-time migration only: never reconstruct an old run's authority.
        // The server confirmed no acceptance/run; allow an explicit new message.
        holder.session.update({ pending: { ...pending, status: "failed" } });
        await holder.session.flush();
        return "rejected";
      }
      return "retry";
    }
    if (isTerminalRunStatus(result.run.status)) {
      holder.session.update({ pending: { ...pending, status: "failed" } });
      await holder.session.flush();
      return "rejected";
    }
    return "waiting";
  }

  async function checkPendingSubmission() {
    const holder = draftSessionRef.current;
    try {
      const outcome = await reconcilePendingSubmission();
      if (draftSessionRef.current !== holder || sessionDraftKeyRef.current !== holder?.key) return;
      setStatus(t(outcome === "retry" ? "submission.retryReady" : outcome === "rejected" ? "submission.rejected"
        : outcome === "accepted" ? "submission.accepted" : "submission.unknown"));
    } catch (error) {
      if (draftSessionRef.current === holder && sessionDraftKeyRef.current === holder?.key) setStatus(errorMessage(error));
    }
  }

  async function returnPendingToDraft() {
    const holder = draftSessionRef.current;
    try {
      if (await reconcilePendingSubmission() !== "rejected") return;
      if (draftSessionRef.current !== holder || sessionDraftKeyRef.current !== holder?.key) return;
      // A terminal unaccepted Run, or a confirmed absent legacy Run without
      // an execution snapshot, can be explicitly returned to a new draft.
      await holder.session.restoreRejectedSubmission();
      publishDraftSession(holder);
    } catch (error) {
      if (draftSessionRef.current === holder && sessionDraftKeyRef.current === holder?.key) setStatus(errorMessage(error));
    }
  }

  useEffect(() => {
    if (!signedIn || !connected || !draftEditable) return;
    const holder = draftSessionRef.current;
    if (!holder?.session.snapshot().pending) return;
    let cancelled = false;
    void reconcilePendingSubmission().then((outcome) => {
      if (cancelled || draftSessionRef.current !== holder || sessionDraftKeyRef.current !== holder.key) return;
      if (outcome === "rejected") setStatus(t("submission.rejected"));
      if (outcome === "retry") setStatus(t("submission.retryReady"));
    }).catch((error) => {
      if (!cancelled && draftSessionRef.current === holder && sessionDraftKeyRef.current === holder.key) {
        setStatus(errorMessage(error));
      }
    });
    return () => { cancelled = true; };
    // Only editor/connection transitions trigger recovery, not each keystroke
    // or pending-state save. Unknown messages are never automatically resent.
  }, [draftKey, draftEditable, connected, signedIn]);

  function handleViewportScroll(event) {
    conversationSession.saveReadingPosition(event.currentTarget);
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
    patchWindowContext({ entitlementId, conversationId: value });
  }

  function chooseEntitlement(entitlements, profileId, currentId = "", preferredBinding = null) {
    if (!Array.isArray(entitlements) || entitlements.length === 0) return null;
    const active = entitlements
      .filter((item) => item?.status === "active")
      .sort((left, right) => Date.parse(right.granted_at || "") - Date.parse(left.granted_at || ""));
    if (active.length === 0) return null;
    if (preferredBinding?.entitlementId) {
      return active.find((item) => item.entitlement_id === preferredBinding.entitlementId) || null;
    }
    const current = active.find((item) => item.entitlement_id === currentId);
    if (current) return current;
    const previousId = settingsStoreRef.current?.getProfile(profileId, "last_selected_entitlement_id", "");
    return active.find((item) => item.entitlement_id === previousId) || active[0];
  }

  function applySignedInSession(session, entitlements, { preserveCurrent = false } = {}) {
    const profileId = session.profile?.id || EMPTY_PROFILE.id;
    const launchBinding = requestedConversationBindingRef.current
      || pendingProductOpenBindingRef.current
      || (conversationWindowRef.current ? normalizeConversationBinding(windowContextRef.current) : null);
    const selected = chooseEntitlement(
      entitlements,
      profileId,
      preserveCurrent ? selectedEntitlementIdRef.current : "",
      launchBinding
    );
    const mustRebindRuntime = entitlementRefreshNeedsReconnect(connectionConfigRef.current, selected);
    for (const owned of sessionManager.values()) {
      if (owned.scope.accountId && (owned.scope.accountId !== profileId
        || !entitlements.some((item) => item.entitlement_id === owned.scope.entitlementId && item.status === "active"))) {
        void owned.close().catch(() => {});
      }
    }
    if (mustRebindRuntime) {
      // A legacy Runtime may still expose the historical single transcript
      // route, but a new Conversation ID must always come from the Library.
      // Never mint an authoritative conversation id in the renderer.
      const fallback = "desktop-chat";
      const savedConversationId = selected
        ? getConversationId(profileId, selected.entitlement_id, fallback)
        : fallback;
      setConversationId(requestedConversationIdRef.current
        || restorableConversationId(savedConversationId, fallback));
    }
    setBuyerSession(session);
    setCreatorAgentEntitlements(entitlements);
    setSelectedEntitlementId(selected?.entitlement_id || "");
    setEntitlementError(launchBinding && !selected
      ? "This Conversation window's Creator Agent binding is no longer available in this account."
      : "");
    if (selected) setProfileSetting("last_selected_entitlement_id", selected.entitlement_id, profileId);
    setStartupError("");
    setAuthState("signed-in");
    setSignInStatus("ready");
    if (selected && pendingProductOpenBindingRef.current?.entitlementId === selected.entitlement_id) {
      pendingProductOpenBindingRef.current = null;
    }
  }

  function applyUnsupportedRoleSession(session) {
    setBuyerSession(session);
    setCreatorAgentEntitlements([]);
    setSelectedEntitlementId("");
    setStartupError("");
    setAuthState("unsupported-role");
    setSignInStatus("ready");
  }

  async function applyResolvedDesktopSession(result, options = {}) {
    const epoch = options.authEpoch ?? authEpochRef.current;
    if (epoch !== authEpochRef.current || authTeardownRef.current) return;
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
    if (epoch !== authEpochRef.current || authTeardownRef.current) return;
    await sessionManager.closeAll();
    if (epoch !== authEpochRef.current || authTeardownRef.current) return;
    sessionManager.endTeardown();
    entitlementRefreshRef.current = false;
    setEntitlementRefreshing(false);
    buyerSessionRef.current = result.session;
    if (result.state === "unsupported-role") {
      applyUnsupportedRoleSession(result.session);
      return;
    }
    applySignedInSession(result.session, result.entitlements, options);
  }

  function resetToSignedOut() {
    authEpochRef.current++;
    sessionManager.beginTeardown();
    buyerSessionRef.current = null;
    void sessionManager.closeAll().catch((error) => setSignInError(errorMessage(error)));
    activeRunRef.current = null;
    workspaceRestoredAccountRef.current = "";
    setBuyerSession(null);
    setAuthState("signed-out");
    setCreatorAgentEntitlements([]);
    setEntitlementError("");
    setSelectedEntitlementId("");
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

  // A browser receipt opens the native app with a non-secret routing hint.
  // The Registry entitlement list remains the authority: this only selects a
  // matching entitlement and never creates access from the URL itself.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let disposed = false;
    let unlisten;
    const handlePayload = (payload) => {
      const binding = normalizeProductOpenPayload(payload)[0];
      if (!binding || disposed) return;
      pendingProductOpenBindingRef.current = binding;
      if (buyerSession?.accessToken) {
        void refreshEntitlements({ preserveCurrent: false });
      }
    };
    void listen(PRODUCT_OPEN_EVENT, ({ payload }) => handlePayload(payload))
      .then((dispose) => {
        unlisten = dispose;
        if (disposed) unlisten?.();
      })
      .catch(() => {});
    void invokeDesktopCommand("read_product_open_links", {}, { invokeImpl: invoke })
      .then(handlePayload)
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [buyerSession?.accessToken]);

  async function synchronizeNativeToolContext(accessSnapshot, taskId, runId) {
    const workspaceGrantId = String(accessSnapshot?.workspaceGrantId || "").trim();
    if (!workspaceGrantId) throw new Error("Choose a workspace folder before starting a task.");
    return conversationSession.registerNativeContext(invokeTauri, {
      conversationId: taskId, runId, workspaceGrantId, permissionPolicy: accessSnapshot.permissionMode
    });
  }

  async function clearSessionNativeToolContexts() {
    await conversationSession.clearNativeContexts(invokeTauri);
  }

  async function clearSavedSession(session, clearPromise) {
    const ownsTeardown = !authTeardownRef.current;
    authTeardownRef.current = true;
    sessionManager.beginTeardown();
    authEpochRef.current++;
    try {
      await (clearPromise ?? clearAuthSession(session, authStorageRef.current));
    } catch {
      resetToSignedOut();
      setSignInError("Hatch couldn't clear the saved sign-in from this Mac. Sign in again to replace it.");
      return false;
    } finally {
      if (ownsTeardown) authTeardownRef.current = false;
    }
    resetToSignedOut();
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    const authEpoch = authEpochRef.current;
    async function bootstrapAuth() {
      if (window.__TAURI_INTERNALS__) {
        try {
          purgeLegacySensitiveStorage(window.localStorage);
        } catch {
          // Legacy cleanup is best effort and must not block normal Sign in.
        }
      }
      await settingsStoreRef.current.load();
      if (cancelled || authEpoch !== authEpochRef.current) return;
      setLanguagePreference(normalizeLanguagePreference(
        settingsStoreRef.current.getApp("language", SYSTEM_LANGUAGE)
      ));
      setSettingsReady(true);
      const savedSession = await loadSavedAuthSession(authStorageRef.current);
      if (cancelled || authEpoch !== authEpochRef.current) return;
      if (!savedSession) {
        setAuthState("signed-out");
        return;
      }
      try {
        const result = await resolveDesktopSession(savedSession, DEFAULT_AUTH_URL);
        if (!cancelled) await applyResolvedDesktopSession(result, { authEpoch });
      } catch (error) {
        if (cancelled || authEpoch !== authEpochRef.current) return;
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
    if (authTeardownRef.current || !buyerSession?.accessToken || entitlementRefreshRef.current) return;
    const epoch = authEpochRef.current;
    const current = () => epoch === authEpochRef.current && !authTeardownRef.current
      && buyerSessionRef.current?.accessToken === buyerSession.accessToken;
    entitlementRefreshRef.current = true;
    setEntitlementRefreshing(true);
    lastEntitlementRefreshRef.current = Date.now();
    try {
      const entitlements = await fetchPurchasedCreatorAgents(DEFAULT_AUTH_URL, buyerSession.accessToken);
      if (!current()) return;
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
      if (!current()) return;
      if (isAuthInvalidError(error)) {
        await signOut();
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
      if (epoch === authEpochRef.current) {
        entitlementRefreshRef.current = false;
        setEntitlementRefreshing(false);
      }
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
      productId: entitlement.product_id
    } : null;
  }

  function briefSpecForSelectedEntitlement(entitlementId = selectedEntitlementId) {
    const entitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === entitlementId);
    const entitlementSpec = entitlement?.brief_spec ?? entitlement?.product?.brief_spec;
    if (entitlementSpec) return entitlementSpec;
    // The entitlement projection and the authenticated Runtime session are
    // normally identical. During a rollout the entitlement may omit the
    // optional projection, so use the already verified session product only
    // when it belongs to the selected Product.
    return creatorAgent?.id === entitlement?.product_id
      ? creatorAgent?.briefSpec ?? null
      : null;
  }

  function newBriefTask({ openInNewWindow = false } = {}) {
    const spec = briefSpecForSelectedEntitlement();
    const answers = Object.fromEntries((Array.isArray(spec?.fields) ? spec.fields : []).map((field) => [field.id, ""]));
    // A form is one user action. Give it its own idempotency scope so a
    // network retry can safely reuse its key, while a later New Task can
    // never replay the abandoned form's request.
    return {
      spec,
      answers,
      openInNewWindow,
      creationPurpose: `brief:${stableRandomId()}`,
      status: "editing",
      error: ""
    };
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
    if (!binding?.entitlementId) return false;
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
    if (!binding?.entitlementId) {
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
      if (requestId !== conversationLibraryRequestRef.current) return;
      if (nextId && nextId !== conversationId) {
        await activateConversation(nextId);
      }
      if (!nextId && !requestedServerConversation) {
        setBriefTask(newBriefTask());
        setTaskBrief(null);
        pendingTaskStartRef.current = "";
      } else if (nextId) {
        setBriefTask(null);
        const selectedConversation = nextConversations.find((item) => item.id === nextId);
        const targetSession = sessionForConversation(nextId);
        targetSession.set("taskBrief", selectedConversation?.brief_snapshot ?? null);
        targetSession.ref("taskBriefRef").current = selectedConversation?.brief_snapshot ?? null;
        if (requestedTaskStartRef.current && nextId === requestedServerConversation) {
          targetSession.ref("pendingTaskStartRef", "").current = nextId;
        }
      }
      if (requested && isServerConversationId(requested) && !requestedServerConversation) {
        setConversationLibraryError("That Conversation is not available for the selected Creator Agent.");
      }
      requestedConversationIdRef.current = "";
      requestedTaskStartRef.current = false;
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
    return conversationSession.isTransport(socket, requestToken);
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
      if (document.visibilityState !== "visible") {
        for (const session of sessionManager.values()) session.ref("textRevealRef").current?.flush();
      }
    };
    document.addEventListener("visibilitychange", flushHiddenText);
    return () => document.removeEventListener("visibilitychange", flushHiddenText);
  }, []);

  const send = useCallback((message) => conversationSession.send(message), [conversationSession]);
  const cancelRun = useCallback(() => conversationSession.cancel(), [conversationSession]);

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
  }, [conversationSession]);

  const sendUserMessage = useCallback(async (appendMessage) => {
    if (!draftEditable || submissionPreparingRef.current) return;
    submissionPreparingRef.current = true;
    try {
    const submittingSession = draftSessionRef.current.session;
    const submittedTextVersion = submittingSession.textVersion();
    try { await submittingSession.flush(); }
    catch (error) {
      if (sessionDraftKeyRef.current === draftKey) restoreComposerDraft(submittingSession.snapshot().text);
      setStatus(errorMessage(error));
      return;
    }
    if (sessionDraftKeyRef.current !== draftKey) return;
    if (!runtimeCapabilitiesRef.current.messageAcceptance) {
      restoreComposerDraft(submittingSession.snapshot().text);
      setStatus("Update Runtime before sending: durable message acceptance is required.");
      return;
    }
    const savedPending = submittingSession.snapshot().pending;
    if (savedPending && await reconcilePendingSubmission() !== "retry") {
      publishDraftSession(draftSessionRef.current);
      return;
    }
    if (sessionDraftKeyRef.current !== draftKey || draftSessionRef.current?.session !== submittingSession) return;
    const socket = socketRef.current;
    if (!conversationReady || !socket || socket.readyState !== WebSocket.OPEN) {
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
    const activeConversationId = conversationSession.scope.conversationId;
    if (!isServerConversationId(activeConversationId)) {
      setStatus(conversationLibraryStatus === "loading"
        ? "Preparing your Conversation Library…"
        : "Conversation Library unavailable. Try again when you're online.");
      return;
    }

    const content = savedPending?.text ?? textFromAppendMessage(appendMessage).trim();
    const submissionFiles = savedPending?.attachments ?? droppedFiles;
    if (!content && submissionFiles.length === 0) return;
    // Workspace and permission changes are pending Desktop preferences until a
    // new turn starts. The native window captures this exact snapshot before
    // the Runtime may request a local tool; the renderer never sends a path or
    // an `approved_by_user` flag to authorize the tool itself.
    const accessSnapshot = savedPending ? requirePendingAccessSnapshot(savedPending)
      : createTurnAccessSnapshot(workspaceGrant?.grant_id, workspace, permissionMode);
    const submissionRunId = savedPending?.runId ?? `run_${stableRandomId()}`;
    const submissionMessageId = savedPending?.clientMessageId ?? `message_${stableRandomId()}`;
    try {
      await synchronizeNativeToolContext(accessSnapshot, activeConversationId, submissionRunId);
    } catch (error) {
      restoreComposerDraft(submittingSession.snapshot().text);
      setStatus(`Couldn't prepare native workspace access: ${errorMessage(error)}`);
      return;
    }
    let attachments = [];
    if (submissionFiles.length > 0) {
      try {
        const prepared = await prepareNativeDropAttachments(submissionFiles);
        attachments = prepared.attachments;
      } catch (error) {
        restoreComposerDraft(submittingSession.snapshot().text);
        setStatus(`Couldn't attach the dropped files: ${errorMessage(error)}`);
        return;
      }
    }
    if (attachments.length > 0 && !runtimeCapabilitiesRef.current.localFileReferences) {
      restoreComposerDraft(submittingSession.snapshot().text);
      setStatus("Update Runtime before sending: local attachment references are required. Your draft is preserved.");
      return;
    }
    if (sessionDraftKeyRef.current !== draftKey) return;
    const pending = savedPending ?? await submittingSession.stageSubmission({
      runId: submissionRunId, clientMessageId: submissionMessageId,
      text: content, attachments: submissionFiles, textRevision: submittedTextVersion, accessSnapshot
    });
    const runId = pending.runId;
    const clientMessageId = pending.clientMessageId;
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
    await submittingSession.markSubmissionUnknown();
    if (sessionDraftKeyRef.current !== draftKey) return;
    // These refs remain current Desktop preferences. The run's immutable
    // accessSnapshot below is its only execution context, including on retry.
    workspaceRef.current = workspace;
    workspaceGrantRef.current = workspaceGrant;
    permissionRef.current = permissionMode;

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
    patchWindowContext({ activeRun: activeRunRef.current });
    setRunning(true);
    setStatus("Running");
    if (!send(outboundMessage)) {
      // The durable native copy remains readable after a failed submission.
      activeRunRef.current = null;
      patchWindowContext({ activeRun: null });
      setRunning(false);
      restoreComposerDraft(submittingSession.snapshot().text);
      setStatus("Service unavailable. Your message will stay here.");
      return;
    }
    // The outbox and composer remain intact until message.accepted (or the
    // canonical acceptance lookup) confirms server persistence.
    publishDraftSession(draftSessionRef.current);
    setMessages((current) => [
      ...current.filter((message) => message.id !== `${runId}_user` && message.id !== assistantId),
      // Runtime receives the user text plus structured attachments. Keep the
      // optimistic message text clean and retain only attachment metadata in
      // the local UI projection; the untrusted body is never flattened into
      // `message.content` by the renderer.
      makeUserMessage(`${runId}_user`, content, startedAt, { attachments }),
      makeAssistantPlaceholder(assistantId, runId, startedAt)
    ]);

    } catch (error) {
      publishDraftSession(draftSessionRef.current);
      setStatus(errorMessage(error));
    } finally {
      submissionPreparingRef.current = false;
    }
  }, [conversationSession, buyerProfile.id, conversationId, conversationLibraryStatus, conversationReady, draftEditable, droppedFiles, permissionMode, send, workspace, workspaceGrant]);

  async function sendTaskStartIfNeeded(sourceSocket = socketRef.current, sourceToken = connectionTokenRef.current) {
    const targetConversationId = pendingTaskStartRef.current;
    const snapshot = taskBriefRef.current;
    if (!targetConversationId || !isServerConversationId(targetConversationId) || !snapshot) return false;
    if (taskStartSentRef.current.has(targetConversationId) || activeRunRef.current) return false;
    if (!isCurrentRuntimeTransport(sourceSocket, sourceToken) || sourceSocket?.readyState !== WebSocket.OPEN) return false;
    // A handshake may finish before background folder validation. Keep the
    // pending Brief intact and wait for a validated grant, without a run/error.
    if (!workspaceGrantRef.current?.grant_id) return false;
    const preparing = conversationSession.ref("taskStartPreparingRef", false);
    if (preparing.current) return false;
    let accessSnapshot, runId, clientMessageId;
    preparing.current = true;
    try {
      accessSnapshot = createTurnAccessSnapshot(workspaceGrantRef.current.grant_id, workspaceRef.current, permissionRef.current);
      runId = `run_${stableRandomId()}`;
      clientMessageId = `message_${stableRandomId()}`;
      await synchronizeNativeToolContext(accessSnapshot, targetConversationId, runId);
    } catch (error) {
      setStatus(`Couldn't prepare native workspace access: ${errorMessage(error)}`);
      return false;
    } finally {
      preparing.current = false;
    }
    if (!isCurrentRuntimeTransport(sourceSocket, sourceToken) || activeRunRef.current) return false;
    const outboundMessage = {
      type: "client.message",
      run_id: runId,
      client_message_id: clientMessageId,
      conversation_id: targetConversationId,
      task_start: true,
      message: { role: "user", content: "" }
    };
    const assistantId = `${runId}_assistant`;
    const startedAt = Date.now();
    activeRunRef.current = {
      runId,
      clientMessageId,
      assistantId,
      text: "",
      startedAt,
      accessSnapshot,
      timing: { questionSentAt: startedAt }
    };
    patchWindowContext({ activeRun: activeRunRef.current });
    setRunning(true);
    setStatus("Starting your task…");
    if (!sendRuntimeMessage(sourceSocket, sourceToken, outboundMessage)) {
      activeRunRef.current = null;
      patchWindowContext({ activeRun: null });
      setRunning(false);
      return false;
    }
    taskStartSentRef.current.add(targetConversationId);
    pendingTaskStartRef.current = "";
    setMessages((current) => [...current, makeAssistantPlaceholder(assistantId, runId, startedAt)]);
    return true;
  }

  const runtimeAdapter = {
    messages,
    isRunning: running,
    isLoading: status === "Loading history...",
    isSendDisabled: !conversationReady
      || !draftEditable
      || running
      || conversationLibraryStatus !== "ready"
      || !isServerConversationId(conversationId),
    onNew: sendUserMessage,
    onCancel: cancelRun,
    unstable_capabilities: {
      copy: true
    }
  };

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
      const accountBoundContext = saved?.canonicalState
        ? context
        : accountScopedWindowContext(context, buyerSession.profile.id);
      windowContextRef.current = {
        ...accountBoundContext,
        accountId: buyerSession.profile.id,
        conversationId: typeof accountBoundContext.conversationId === "string" ? accountBoundContext.conversationId : "",
        workspaceGrant: normalizeWorkspaceGrant(accountBoundContext.workspaceGrant),
        permissionMode: accountBoundContext.permissionMode ? normalizePermissionPolicy(accountBoundContext.permissionMode) : "",
        activeRun: parseStoredJson(accountBoundContext.activeRun),
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
      viewportScrollTopRef.current = windowContextRef.current.scrollTop;
      if (windowContextRef.current.scrollTop > 0) {
        conversationSession.set("readingPosition", { top: windowContextRef.current.scrollTop, followTail: false });
      }
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
      && item.product_id === binding.productId);
    if (!selected) {
      if (selectedEntitlementId) setSelectedEntitlementId("");
      setEntitlementError("This Conversation window's Creator Agent binding is no longer available in this account.");
      return;
    }
    if (selectedEntitlementId !== selected.entitlement_id) {
      setSelectedEntitlementId(selected.entitlement_id);
      setEntitlementError("");
    }
  }, [creatorAgentEntitlements, selectedEntitlementId, signedIn, windowContextReady]);

  useEffect(() => {
    if (!settingsReady || !windowContextReady || !signedIn || !buyerSession?.profile?.id) return;
    if (workspaceRestoredAccountRef.current === buyerSession.profile.id) return;
    workspaceRestoredAccountRef.current = buyerSession.profile.id;
    let cancelled = false;
    const ownsWorkspaceRestore = beginWorkspaceRestore(conversationSession);
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
    const restorableRun = savedRun?.runId
      && !isTerminalRunStatus(savedRun.status)
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
    viewportScrollTopRef.current = Number.isFinite(Number(windowContext.scrollTop))
      ? Math.max(0, Number(windowContext.scrollTop))
      : 0;
    setWorkspaceGranted(false);
    // Conversation selection is owned by Library hydration, not workspace restoration.
    permissionRef.current = nextPermission;
    setPermissionMode(nextPermission);
    if (restorableRun) {
      activeRunRef.current = restorableRun;
      setStatus("Loading history...");
    } else {
      activeRunRef.current = null;
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
      if (cancelled || !ownsWorkspaceRestore()) return;
      if (restored.state === "valid") {
        setWorkspace(restored.workspace);
        workspaceRef.current = restored.workspace;
        workspaceGrantRef.current = restored.grant;
        setWorkspaceGrant(restored.grant);
        setWorkspaceDraft(restored.workspace);
        setWorkspaceDraftGrant(restored.grant);
        setWorkspaceGranted(true);
        conversationSession.set("workspaceSettingsReady", true);
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
        // A failed background read is not authority to erase saved settings.
        // Keep the saved candidate for retry, but never publish it as a grant.
        setStatus(restored.status);
      } else if (!cancelled && !restorableRun) {
        conversationSession.set("workspaceSettingsReady", true);
        setStatus(legacySavedWorkspace
          ? legacyClearFailed
            ? "Choose your previous workspace again. Hatch couldn't clear the legacy path and will retry next launch."
            : "Choose your previous workspace again so macOS can grant Hatch access from the folder picker."
          : restored.status);
      }
    }
    // Cloud navigation/history needs only restored window identity, not OS I/O.
    setWindowStateRestored(true);
    void restoreWorkspace().catch((error) => {
      if (!cancelled && ownsWorkspaceRestore()) setStatus(errorMessage(error));
    });
    return () => { cancelled = true; };
  }, [buyerProfile.id, buyerSession?.profile?.id, settingsReady, signedIn, windowContextReady]);

  // Persist only after the native window context has been read and the
  // identity has been restored. Omit unresolved local settings so a pending
  // folder read cannot replace the saved grant with the initial null state.
  useEffect(() => {
    if (!windowContextReady || !windowStateRestored || !signedIn) return;
    patchWindowContext({
      conversationId,
      ...(conversationBindingFor() || {}),
      ...(workspaceSettingsReady ? { workspaceGrant, permissionMode } : {}),
      draft: workspaceDraft,
      activeRun: activeRunRef.current,
      conversationCursor: conversationCursorRef.current,
      scrollTop: viewportScrollTopRef.current
    });
  }, [conversationId, permissionMode, signedIn, windowContextReady, windowStateRestored, workspaceDraft, workspaceGrant, workspaceSettingsReady]);

  useLayoutEffect(() => {
    if (!signedIn || olderLoading || historyAnchorRef.current) return;
    conversationSession.restoreReadingPosition(viewportRef.current);
  }, [conversationSession, messages, signedIn, olderLoading]);

  useEffect(() => () => {
    window.clearTimeout(viewportScrollPersistTimerRef.current);
    viewportScrollPersistTimerRef.current = null;
    if (windowContextReady && signedIn) {
      patchWindowContext({ scrollTop: viewportScrollTopRef.current });
    }
  }, [signedIn, windowContextReady]);

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

  conversationSession.clearContexts = clearSessionNativeToolContexts;
  useEffect(() => () => {
    void sessionManager.closeAll().catch(() => {});
  }, []);

  useEffect(() => {
    if (!signedIn || !windowStateRestored || !selectedEntitlementId) return;
    if (!canConnectConversation({ libraryStatus: conversationLibraryStatus, conversationId })) return;
    const entitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId);
    const desiredBinding = runtimeBindingForEntitlement(entitlement);
    const hasConnection = connectedRef.current || socketRef.current || connectingRef.current;
    if (hasConnection && connectionConfigRef.current?.conversationId === conversationId
      && runtimeBindingMatches(connectionConfigRef.current, desiredBinding)) return;
    if (hasConnection) disconnectRuntime();
    void connectRuntime({
      workspaceGrant,
      conversationId,
      entitlementId: desiredBinding?.entitlementId,
      creatorId: desiredBinding?.creatorId,
      preserveMessages: true
    });
  }, [conversationSession, connected, conversationId, conversationLibraryStatus, creatorAgentEntitlements, selectedEntitlementId, signedIn, windowStateRestored]);

  useEffect(() => {
    if (connected && workspaceGranted) void sendTaskStartIfNeeded().catch((error) => {
      if (!conversationSession.disposed) setStatus(errorMessage(error));
    });
  }, [conversationSession, connected, workspaceGranted]);

  function scheduleRuntimeReconnect() {
    if (conversationSession.disposed || intentionalDisconnectRef.current || reconnectTimerRef.current || !connectionConfigRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_AUTOMATIC_RUNTIME_RETRIES) {
      setRuntimeRetryExhausted(true);
      setChatLoading(false);
      setStatus("Connection unavailable. Retry when you are ready.");
      return;
    }
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
      productId: creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId)?.product_id,
      creatorId: creatorAgentEntitlements.find((item) => item.entitlement_id === selectedEntitlementId)?.creator_id
    };
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    setRuntimeRetryExhausted(false);
    connectionTokenRef.current += 1;
    intentionalDisconnectRef.current = true;
    const staleSocket = socketRef.current;
    socketRef.current = null;
    staleSocket?.close();
    connectedRef.current = false;
    setConnected(false);
    setChatLoading(true);
    setStatus("Restoring connection…");
    void connectRuntime({ ...retryConnection, preserveMessages: true });
  }

  function projectDurableSnapshotRun(snapshot) {
    const active = activeRunRef.current;
    if (!active || reconcileActiveRunFromSnapshot(snapshot, active)) return;
    textRevealRef.current?.flush(active.runId);
    activeRunRef.current = null;
    setRunning(false);
    patchWindowContext({ activeRun: null });
  }

  async function reconcileLiveSnapshot(socket, requestToken) {
    const config = connectionConfigRef.current;
    if (!config || socketRef.current !== socket || requestToken !== connectionTokenRef.current) return;
    try {
      const isCurrent = () => socketRef.current === socket && requestToken === connectionTokenRef.current;
      const journalCursor = await drainConversationJournal(
        (options) => getConversationJournalPage(config.serverUrl, buyerSession.accessToken,
          { entitlementId: config.entitlementId }, config.conversationId, options),
        conversationCursorRef.current, isCurrent
      );
      if (journalCursor === null || !isCurrent()) return;
      const baseline = messagesRef.current;
      // Fetch only the latest message page after draining a fixed journal
      // boundary. Preserve rows updated by the live stream during this read.
      const snapshot = await getConversationSnapshot(
        config.serverUrl,
        buyerSession.accessToken,
        {
          entitlementId: config.entitlementId
        },
        config.conversationId,
        conversationCursorRef.current
      );
      if (socketRef.current !== socket || requestToken !== connectionTokenRef.current) return;
      let reconciled = await bridgeConversationHistory(validateSnapshotPage(snapshot, journalCursor), baseline,
        (options) => getConversationHistoryPage(config.serverUrl, buyerSession.accessToken,
          { entitlementId: config.entitlementId }, config.conversationId, options), isCurrent);
      if (!reconciled || !isCurrent()) return;
      reconciled = await includeActiveConversationRun(reconciled, activeRunRef.current?.runId,
        (runId) => getConversationRun(config.serverUrl, buyerSession.accessToken,
          { entitlementId: config.entitlementId }, config.conversationId, runId), isCurrent);
      if (!reconciled || !isCurrent()) return;
      // Keep the loaded history prefix and its oldest-page cursor intact.
      setMessages((current) => mergeConversationPage(current, reconciled.messages.map(historyMessageToThreadMessage), { baseline }));
      const briefSnapshot = reconciled.brief_snapshot ?? snapshot.conversation?.brief_snapshot ?? null;
      setTaskBrief(briefSnapshot);
      taskBriefRef.current = briefSnapshot;
      projectDurableSnapshotRun(reconciled);
      if (reconciled.cursor > conversationCursorRef.current) {
        conversationCursorRef.current = reconciled.cursor;
        patchWindowContext({ conversationCursor: reconciled.cursor });
      }
      return true;
    } catch (error) {
      if (socketRef.current !== socket || requestToken !== connectionTokenRef.current) return;
      connectedRef.current = false;
      setConnected(false);
      setChatLoading(false);
      setRuntimeRetryExhausted(true);
      setStatus("Conversation recovery could not be verified. Reconnect to continue.");
      return false;
    }
  }

  async function loadOlderHistory() {
    const config = connectionConfigRef.current;
    const page = historyPageRef.current;
    if (!config || !page?.has_more || olderRequestRef.current) return;
    const request = { token: connectionTokenRef.current, page };
    olderRequestRef.current = request;
    setOlderLoading(true);
    setOlderError("");
    const isCurrent = () => olderRequestRef.current === request
      && request.token === connectionTokenRef.current && historyPageRef.current === page;
    try {
      const result = validateHistoryPage(await getConversationHistoryPage(config.serverUrl,
        buyerSessionRef.current?.accessToken, { entitlementId: config.entitlementId },
        config.conversationId, { beforeCursor: page.before_cursor }));
      if (!isCurrent()) return;
      if (result.has_more && result.before_cursor === page.before_cursor) throw new Error("History cursor did not advance.");
      const viewport = sessionManager.isSelected(conversationSession) ? viewportRef.current : null;
      if (viewport) {
        const element = [...viewport.querySelectorAll(".chat-message")].find((node) => node.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
        historyAnchorRef.current = { viewport, element, token: request.token,
          offset: element?.getBoundingClientRect().top, height: viewport.scrollHeight, top: viewport.scrollTop };
      }
      setMessages((current) => mergeConversationPage(current, result.messages.map(historyMessageToThreadMessage), { older: true }));
      historyPageRef.current = { has_more: result.has_more, before_cursor: result.before_cursor, conversationId: config.conversationId };
      setHistoryPage(historyPageRef.current);
    } catch (error) {
      if (isCurrent()) setOlderError(error.message || "Could not load older messages.");
    } finally {
      if (olderRequestRef.current === request) {
        olderRequestRef.current = null;
        setOlderLoading(false);
      }
    }
  }

  async function connectRuntime(connection = {}) {
    if (conversationSession.disposed || connectedRef.current || socketRef.current || connectingRef.current) return;
    const targetServerUrl = connection.serverUrl || serverUrl;
    const targetConversationId = conversationSession.scope.conversationId;
    const targetEntitlementId = conversationSession.scope.entitlementId;
    if ((connection.conversationId && connection.conversationId !== targetConversationId)
      || (connection.entitlementId && connection.entitlementId !== targetEntitlementId)) {
      throw new Error("Cannot attach another Conversation or Agent to this session");
    }
    const selectedEntitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === targetEntitlementId);
    const targetProductId = selectedEntitlement?.product_id;
    const targetCreatorId = selectedEntitlement?.creator_id;
    if (!canConnectConversation({
      libraryStatus: conversationLibraryStatus,
      conversationId: targetConversationId
    })) {
      setChatLoading(false);
      setStatus(conversationLibraryStatus === "unavailable"
        ? "Conversation Library unavailable. Hatch will not connect an unverified Conversation."
        : "Preparing your Conversation Library…");
      return;
    }
    if (!targetServerUrl.trim() || !buyerSession?.accessToken || !targetEntitlementId) {
      setChatLoading(false);
      setStatus("Sign in and choose a Creator Agent before starting the connection.");
      return;
    }

    try {
      if (conversationSession.ensureOwnership && !await conversationSession.ensureOwnership()) return;
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    if (conversationSession.disposed || connectedRef.current || socketRef.current || connectingRef.current) return;
    const requestToken = ++connectionTokenRef.current;
    connectingRef.current = true;
    intentionalDisconnectRef.current = false;
    setRuntimeRetryExhausted(false);
    setChatLoading(true);
    setStatus("Connecting…");
    connectionConfigRef.current = {
      serverUrl: targetServerUrl.trim(),
      conversationId: targetConversationId.trim() || "desktop-chat",
      entitlementId: targetEntitlementId,
      ...(targetProductId ? { productId: targetProductId } : {}),
      ...(targetCreatorId ? { creatorId: targetCreatorId } : {})
    };
    // Legacy `desktop-chat` remains read-only during Runtime rollout. Never
    // persist it over a server-issued Conversation selected by the Library.
    if (isServerConversationId(targetConversationId)) {
      setConversationIdForEntitlement(buyerProfile.id, targetEntitlementId, targetConversationId.trim());
    }

    try {
      setStatus("Loading history...");
      const activeConversationId = targetConversationId.trim() || "desktop-chat";
      const baseline = messagesRef.current;
      const sameConversation = historyPageRef.current?.conversationId === activeConversationId;
      olderRequestRef.current = null;
      setOlderLoading(false);
      setOlderError("");
      if (!sameConversation) {
        historyPageRef.current = null;
        setHistoryPage(null);
      }
      const snapshot = await getConversationSnapshot(
        targetServerUrl.trim(), buyerSession.accessToken,
        { entitlementId: targetEntitlementId }, activeConversationId
      );
      if (requestToken !== connectionTokenRef.current) return;
      let reconciledSnapshot = await bridgeConversationHistory(
        validateSnapshotPage(snapshot, sameConversation ? conversationCursorRef.current : 0), sameConversation ? baseline : [],
        (options) => getConversationHistoryPage(targetServerUrl.trim(), buyerSession.accessToken,
          { entitlementId: targetEntitlementId }, activeConversationId, options),
        () => requestToken === connectionTokenRef.current);
      if (!reconciledSnapshot || requestToken !== connectionTokenRef.current) return;
      reconciledSnapshot = await includeActiveConversationRun(reconciledSnapshot, activeRunRef.current?.runId,
        (runId) => getConversationRun(targetServerUrl.trim(), buyerSession.accessToken,
          { entitlementId: targetEntitlementId }, activeConversationId, runId),
        () => requestToken === connectionTokenRef.current);
      if (!reconciledSnapshot || requestToken !== connectionTokenRef.current) return;
      const briefSnapshot = reconciledSnapshot.brief_snapshot ?? snapshot.conversation?.brief_snapshot ?? null;
      setTaskBrief(briefSnapshot);
      taskBriefRef.current = briefSnapshot;
      projectDurableSnapshotRun(reconciledSnapshot);
      setMessages((current) => mergeConversationPage(sameConversation ? current : [],
        reconciledSnapshot.messages.map(historyMessageToThreadMessage), { baseline }));
      if (!sameConversation) {
        historyPageRef.current = { has_more: reconciledSnapshot.has_more, before_cursor: reconciledSnapshot.before_cursor, conversationId: activeConversationId };
        setHistoryPage(historyPageRef.current);
      }
      conversationCursorRef.current = reconciledSnapshot.cursor;
      patchWindowContext({ conversationCursor: reconciledSnapshot.cursor });
      setStatus("Connecting...");
    } catch (error) {
      if (requestToken === connectionTokenRef.current) {
        setChatLoading(true);
        setStatus(`Connection unavailable — ${errorMessage(error)}`);
        scheduleRuntimeReconnect();
      }
      return;
    } finally {
      if (requestToken === connectionTokenRef.current) connectingRef.current = false;
    }

    if (requestToken !== connectionTokenRef.current || intentionalDisconnectRef.current) return;

    const socket = new WebSocket(targetServerUrl.trim());
    socketRef.current = socket;
    // Capabilities are connection-scoped. Treat them as unavailable until
    // this socket's authenticated session explicitly advertises them.
    runtimeCapabilitiesRef.current = { richAssets: false };
    conversationSession.attachSocket(socket, requestToken, {
    open: () => {
      if (socketRef.current !== socket) return;
      socket.send(JSON.stringify({
        type: "client.hello",
        protocol_version: PROTOCOL_VERSION,
        auth_token: buyerSession.accessToken,
        entitlement_id: targetEntitlementId,
        conversation_id: conversationSession.scope.conversationId,
        client_version: "0.1.32",
        local_tools: [...PLATFORM_LOCAL_TOOLS],
      }));
    },
    message: (event) => {
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
    },
    error: () => {
      if (socketRef.current !== socket) return;
      setStatus("Connection problem. Your work has been kept.");
      void cancelPendingLocalTools("transport_failure").then((stopped) => {
        if (!stopped && isCurrentRuntimeTransport(socket, requestToken)) {
          setStatus(LOCAL_TOOL_STOP_UNCONFIRMED);
        }
      });
    },
    close: () => {
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
      if (!intentionalDisconnectRef.current) {
        setChatLoading(true);
        setStatus("Connection lost — restoring your session…");
        scheduleRuntimeReconnect();
      } else {
        setChatLoading(false);
        setStatus("Offline");
      }
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
    setRuntimeRetryExhausted(false);
    setChatLoading(false);
    setRunning(false);
    setStatus("Offline");
  }

  async function handleRuntimeMessage(message, sourceSocket = socketRef.current, sourceToken = connectionTokenRef.current) {
    if (!isCurrentRuntimeTransport(sourceSocket, sourceToken)) return;
    if (message.type === "message.accepted" || message.type === "session.ready") {
      assertConversationIdentity(message.conversation_id, conversationSession.scope.conversationId, "protocol_error");
    }
    if (message.type === "message.accepted") {
      try { await conversationSession.acceptSubmission(message); }
      catch (error) { setStatus(errorMessage(error)); }
      return;
    }
    if (message.type === "session.ready") {
      runtimeCapabilitiesRef.current = {
        richAssets: message.runtime_capabilities?.rich_assets === true,
        messageAcceptance: message.runtime_capabilities?.message_acceptance === true,
        localFileReferences: message.runtime_capabilities?.local_file_references === true
      };
      const selectedEntitlement = creatorAgentEntitlements.find(
        (entitlement) => entitlement.entitlement_id === conversationSession.scope.entitlementId
      );
      const nextAgent = creatorAgentFromBoundSession(
        message,
        selectedEntitlement,
        creatorAgent
      );
      conversationSession.set("creatorAgent", nextAgent);
      if (sessionManager.isSelected(conversationSession) && nextAgent.briefSpec) {
        setBriefTask((current) => {
          if (!current || current.status !== "editing") return current;
          const answers = Object.fromEntries(nextAgent.briefSpec.fields.map((field) => [
            field.id,
            current.answers?.[field.id] ?? ""
          ]));
          return { ...current, spec: nextAgent.briefSpec, answers, error: "" };
        });
      }
      const socket = socketRef.current;
      if (socket) {
        setChatLoading(true);
        setStatus("Loading history...");
        if (!await reconcileLiveSnapshot(socket, sourceToken)) return;
        if (!isCurrentRuntimeTransport(socket, sourceToken)) return;
        connectedRef.current = true;
        reconnectAttemptRef.current = 0;
        setRuntimeRetryExhausted(false);
        setConnected(true);
        setChatLoading(false);
        setStatus("Connected");
        // Background sessions still start their pending Brief after handshake;
        // local preparation must not delay cloud readiness.
        void sendTaskStartIfNeeded(socket, sourceToken).catch((error) => {
          if (isCurrentRuntimeTransport(socket, sourceToken)) setStatus(errorMessage(error));
        });
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
      if (localToolsStopped) await conversationSession.clearNativeContext(invokeTauri, message.run_id);
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
        patchWindowContext({ activeRun: null });
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
      // Protocol/schema failures are emitted without a run_id because the
      // Runtime could not safely parse the client frame. There is only one
      // active outbound turn per Desktop socket, so associate that transport
      // error with the current optimistic turn instead of leaving Thinking
      // on screen forever.
      const failedRunId = message.run_id || sourceRun?.runId;
      if (!failedRunId || !sourceRun || sourceRun.runId !== failedRunId) {
        if (!message.run_id) {
          setStatus(`Runtime rejected the message: ${message.error?.message || "Unknown protocol error"}`);
        }
        return;
      }
      const localToolsStopped = await cancelPendingLocalTools("turn_failed", failedRunId);
      if (localToolsStopped) await conversationSession.clearNativeContext(invokeTauri, failedRunId);
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
      patchWindowContext({ activeRun: null });
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
    return conversationSession.executeTool(message, {
      invoke: invokeTauri, isTransportCurrent, requestApproval: requestToolApproval
    });
  }

  async function cancelPendingLocalTools(reason, runId = null) {
    return conversationSession.cancelTools(reason, runId);
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

  async function chooseWorkspace({ activate = true } = {}) {
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
    if (draftSessionRef.current?.key !== sessionDraftKeyRef.current) {
      return [];
    }
    const files = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
    if (files.length === 0) return [];
    const current = droppedFilesRef.current;
    const byId = new Map(current.map((file) => [file.contextId, file]));
    for (const file of files) byId.set(file.contextId, file);
    if (byId.size > 8) {
      setStatus(t("draft.tooManyFiles"));
      return [];
    }
    const next = [...byId.values()];
    droppedFilesRef.current = next;
    setDroppedFiles(next);
    return next;
  }

  function nativeDropStatus(files, rejectedFiles) {
    const acceptedCount = Array.isArray(files) ? files.length : 0;
    const rejected = Array.isArray(rejectedFiles) ? rejectedFiles.filter(Boolean) : [];
    const acceptedLabel = acceptedCount > 0
      ? `${acceptedCount} file${acceptedCount === 1 ? "" : "s"} ready to attach`
      : "";
    if (rejected.length === 0) return acceptedLabel;
    const rejectedLabel = `${rejected.length} file${rejected.length === 1 ? "" : "s"} couldn't be attached`;
    const reason = typeof rejected[0]?.reason === "string" ? rejected[0].reason : "Try a file under 100 MiB.";
    return acceptedLabel ? `${acceptedLabel}; ${rejectedLabel}` : `${rejectedLabel} — ${reason}`;
  }

  async function chooseContextFiles() {
    if (!draftEditable) return;
    const holder = draftSessionRef.current;
    try {
      let result;
      const draft = await holder.session.prepareAttachments(async () => {
        result = await invokeTauri("pick_native_drop_files");
        return Array.isArray(result?.files) ? result.files.map(normalizeNativeDropFile).filter(Boolean) : [];
      });
      if (sessionDraftKeyRef.current !== holder.key) return;
      droppedFilesRef.current = draft.attachments;
      storeDroppedFiles(draft.attachments);
      const message = nativeDropStatus(result?.files, result?.rejectedFiles);
      if (message) setStatus(message);
    } catch (error) {
      setStatus(`Couldn't attach files: ${errorMessage(error)}`);
    }
  }

  async function handleComposerPaste(event) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const item = items.find((candidate) => candidate?.kind === "file" && typeof candidate.type === "string" && candidate.type.includes("/"));
    const file = item?.getAsFile?.();
    if (!file) return;
    event.preventDefault();
    if (!draftEditable) return;
    const holder = draftSessionRef.current;
    try {
      const mediaType = file.type || "application/octet-stream";
      const displayName = file.name?.trim() || (mediaType.startsWith("image/") ? `pasted-image.${mediaType.split("/")[1] || "png"}` : "pasted-file");
      const draft = await holder.session.prepareAttachments(async () => {
        if (file.size > MAX_NATIVE_DROP_SOURCE_BYTES) throw new Error("Pasted files are limited to 100 MiB.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = normalizeNativeDropFile(await invokeTauri("import_clipboard_attachment", {
          displayName, mediaType, dataBase64: bytesToBase64(bytes)
        }));
        if (!saved) throw new Error("Native attachment import returned an invalid reference.");
        return [saved];
      });
      if (sessionDraftKeyRef.current !== holder.key) return;
      droppedFilesRef.current = draft.attachments;
      storeDroppedFiles(draft.attachments);
      setStatus(mediaType.startsWith("image/") ? "Pasted image ready" : "Pasted file ready");
    } catch (error) {
      setStatus(`Couldn't attach pasted file: ${errorMessage(error)}`);
    }
  }

  // Native drops carry managed-copy references, never new tool grants.
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
    conversationSession.ref("permissionSettingsRevision", 0).current++;
    setPermissionMode(nextMode);
    setProfileSetting("permission_mode", nextMode);
    setStatus(`Permission updated for the next turn: ${permissionPolicyLabel(nextMode)}`);
  }

  async function createLibraryConversation({ briefAnswers = undefined, purpose = "create" } = {}) {
    const binding = conversationBindingFor();
    if (!binding || !buyerSession?.accessToken) {
      setStatus("Choose a Creator Agent before starting a conversation.");
      return "";
    }
    const creation = conversationCreationRequest(binding, purpose);
    try {
      const result = await createConversation(serverUrl, buyerSession.accessToken, binding, {
        title: `New ${creatorAgent.name} task`,
        clientRequestId: creation.clientRequestId,
        briefAnswers
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
      return conversation;
    } catch (error) {
      settleConversationCreation(creation.scope, error);
      setConversationLibraryError(errorMessage(error));
      if (String(error?.code || "").startsWith("brief_")) {
        setBriefTask((current) => current ? { ...current, error: errorMessage(error) } : current);
        setStatus(errorMessage(error));
      } else {
        setStatus("Conversation Library unavailable. Try again when you're online.");
      }
      return "";
    }
  }

  async function startNewConversation() {

    setBriefTask(newBriefTask());
    return "";
  }

  async function openConversationInNewWindow(nextConversationId, { announce = true, startTask = false } = {}) {
    const target = String(nextConversationId || "").trim();
    if (!isServerConversationId(target)) {
      setStatus("Only a server Conversation can be opened in a new window.");
      return false;
    }
    const binding = conversationBindingFor();
    if (!binding?.entitlementId) {
      setStatus("Choose a Creator Agent before opening a Conversation window.");
      return false;
    }
    try {
      await invokeTauri("open_conversation_window", {
        conversationId: target,
        entitlementId: binding.entitlementId,
        creatorId: binding.creatorId,
        productId: binding.productId,
        startTask
      });
      if (announce) setStatus("Conversation opened in a new window");
      return true;
    } catch (error) {
      setStatus(`Hatch couldn't open the conversation window: ${errorMessage(error)}`);
      return false;
    }
  }

  async function startNewConversationInWindow() {
    setBriefTask(newBriefTask({ openInNewWindow: true }));
    return true;
  }

  async function submitBriefTask() {
    const draft = briefTask;
    const spec = draft?.spec ?? briefSpecForSelectedEntitlement();
    if (!Array.isArray(spec?.fields) || spec.fields.length === 0) {
      setBriefTask((current) => current ? { ...current, error: "This Creator Agent has not published a Brief yet." } : current);
      return false;
    }
    const answers = draft?.answers ?? {};
    const missing = spec.fields.find((field) => field.required && !String(answers[field.id] ?? "").trim());
    if (missing) {
      setBriefTask((current) => current ? { ...current, error: `Please answer: ${missing.label}` } : current);
      return false;
    }
    setBriefTask((current) => current ? { ...current, status: "submitting", error: "" } : current);
    const briefAnswers = spec.fields.map((field) => ({
      field_id: field.id,
      value: String(answers[field.id] ?? "")
    }));
    const created = await createLibraryConversation({
      purpose: draft?.creationPurpose || "create",
      briefAnswers
    });
    if (!created) {
      setBriefTask((current) => current ? { ...current, status: "editing" } : current);
      return false;
    }
    const nextId = created.id;
    const snapshot = created.brief_snapshot ?? null;
    if (draft?.openInNewWindow) {
      setBriefTask(null);
      return openConversationInNewWindow(nextId, { startTask: true });
    }
    const targetSession = sessionForConversation(nextId);
    targetSession.ref("taskStartSentRef", new Set()).current.delete(nextId);
    targetSession.ref("pendingTaskStartRef", "").current = nextId;
    targetSession.ref("taskBriefRef").current = snapshot;
    targetSession.set("taskBrief", snapshot);
    targetSession.set("chatLoading", true);
    targetSession.set("status", "Starting your task…");
    await activateConversation(nextId, targetSession);
    setConversationIdForEntitlement(buyerProfile.id, selectedEntitlementId, nextId);
    setBriefTask(null);
    return true;
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

  const openSettingsWindow = useCallback(() => {
    void invokeTauri("open_settings_window").catch((error) => {
      setStatus(`Hatch couldn't open Settings: ${errorMessage(error)}`);
    });
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
    onOpenSettings: openSettingsWindow,
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


  async function signIn(credentials) {
    if (authTeardownRef.current) return;
    const authEpoch = ++authEpochRef.current;
    setSignInStatus("loading");
    setSignInError("");
    try {
      if (!credentials) throw new Error("Enter your email and password.");
      const result = await signInDesktopSession(credentials, DEFAULT_AUTH_URL, authStorageRef.current);
      if (authEpoch !== authEpochRef.current || authTeardownRef.current) return;
      await applyResolvedDesktopSession(result, { authEpoch });
    } catch (error) {
      if (authEpoch !== authEpochRef.current || authTeardownRef.current) return;
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
    if (authTeardownRef.current) return;
    authTeardownRef.current = true;
    authEpochRef.current++;
    sessionManager.beginTeardown();
    try {
      setSessionCloseError("");
      await sessionManager.closeAll();
    } catch (error) {
      setSessionCloseError(errorMessage(error));
      authTeardownRef.current = false;
      return;
    }
    const { serverRevoke, localClear } = startAuthSessionSignOut(
      DEFAULT_AUTH_URL,
      buyerSession,
      authStorageRef.current
    );
    void serverRevoke;
    const cleared = await clearSavedSession(buyerSession, localClear);
    buyerSessionRef.current = null;
    authTeardownRef.current = false;
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
    navigationRequestRef.current++;
    conversationSession.saveReadingPosition(viewportRef.current);
    const sameEntitlement = entitlement.entitlement_id === selectedEntitlementId;
    if (sameEntitlement && runtimeBindingMatches(
      connectionConfigRef.current,
      runtimeBindingForEntitlement(entitlement)
    )) return;
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
        activeRun: null,
      });
    }
    setSelectedEntitlementId(entitlement.entitlement_id);
    setBriefTask(null);
    setProfileSetting("last_selected_entitlement_id", entitlement.entitlement_id);
    if (!sameEntitlement) {
      setConversations([]);
      setConversationLibraryStatus("loading");
      // Never carry a Conversation ID across Creator Agents. The Library
      // effect will select or create an ID bound to the newly selected Agent.
      setConversationId("desktop-chat");
    }
  }

  function sessionForConversation(taskId, entitlementId = selectedEntitlementId) {
    const target = sessionManager.get({ accountId: buyerProfile.id, entitlementId, conversationId: taskId });
    if (conversationOwnerRef.current) target.ensureOwnership = () => conversationOwnerRef.current.claim(target);
    if (!target.localSettingsInitialized) {
      target.localSettingsInitialized = true;
      for (const name of ["workspace", "workspaceDraft", "workspaceGrant", "workspaceDraftGrant", "workspaceGranted", "permissionMode"]) {
        target.set(name, conversationSession.snapshot()[name]);
      }
    }
    return target;
  }

  async function restoreTaskLocalSettings(taskId, targetSession) {
    if (!window.__TAURI_INTERNALS__ || targetSession.localSettingsRestored) return;
    targetSession.localSettingsRestored = true;
    const ownsRestore = beginWorkspaceRestore(targetSession);
    const permissionRevision = targetSession.ref("permissionSettingsRevision", 0).current;
    const fallbackGrant = targetSession.snapshot().workspaceGrant
      || targetSession.snapshot().workspaceDraftGrant
      || normalizeWorkspaceGrant(windowContextRef.current.workspaceGrant);
    // Selection is immediate, but inherited/unverified settings are not run authority.
    targetSession.set("workspaceGrant", null);
    targetSession.ref("workspaceGrantRef").current = null;
    targetSession.set("workspaceGranted", false);
    let saved;
    try {
      saved = await invokeTauri("read_task_settings", { taskId });
    } catch (error) {
      if (ownsRestore()) targetSession.set("status", errorMessage(error));
      return;
    }
    if (!ownsRestore()) return;
    if (saved && targetSession.ref("permissionSettingsRevision", 0).current === permissionRevision) {
      const permission = normalizePermissionPolicy(saved.permissionMode);
      targetSession.set("permissionMode", permission);
      targetSession.ref("permissionRef").current = permission;
    }
    const savedGrant = normalizeWorkspaceGrant(saved ? saved.workspaceGrant : fallbackGrant);
    const restored = await validateRestoredWorkspace(savedGrant,
      (grantId) => invokeTauri("ensure_workspace", { workspaceGrantId: grantId }));
    if (!ownsRestore()) return;
    const restoredGrant = restored.state === "valid" ? restored.grant : null;
    targetSession.set("workspace", restoredGrant?.display_path || "");
    targetSession.ref("workspaceRef").current = restoredGrant?.display_path || "";
    targetSession.set("workspaceDraft", restoredGrant?.display_path || "");
    targetSession.set("workspaceGrant", restoredGrant);
    targetSession.set("workspaceDraftGrant", restoredGrant);
    targetSession.ref("workspaceGrantRef").current = restoredGrant;
    targetSession.set("workspaceGranted", Boolean(restoredGrant));
    targetSession.set("workspaceSettingsReady", restored.state !== "stale");
    if (restored.state === "stale") targetSession.set("status", restored.status);
  }

  async function activateConversation(taskId, targetSession = sessionForConversation(taskId)) {
    const navigation = ++navigationRequestRef.current;
    if (targetSession.ensureOwnership && !await targetSession.ensureOwnership()) return false;
    const restoring = restoreTaskLocalSettings(taskId, targetSession);
    const restoreRevision = targetSession.ref("workspaceRestoreRevision", 0).current;
    void restoring.catch((error) => {
      if (!targetSession.disposed && targetSession.ref("workspaceRestoreRevision", 0).current === restoreRevision) {
        targetSession.set("status", errorMessage(error));
      }
    });
    if (navigation !== navigationRequestRef.current || targetSession.disposed
      || selectedEntitlementIdRef.current !== targetSession.scope.entitlementId) return;
    conversationSession.saveReadingPosition(viewportRef.current);
    sessionManager.select(targetSession);
    setConversationId(taskId);
    setConversationIdForEntitlement(buyerProfile.id, targetSession.scope.entitlementId, taskId);
    return true;
  }

  ownerActivationRef.current = async (payload) => {
    if (payload.accountId !== buyerSessionRef.current?.profile?.id || authTeardownRef.current) return;
    const target = sessionManager.values().find((session) => !session.disposed
      && session.scope.accountId === payload.accountId && session.scope.entitlementId === payload.entitlementId
      && session.scope.conversationId === payload.conversationId);
    if (!target) return;
    if (selectedEntitlementIdRef.current !== payload.entitlementId) {
      const entitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === payload.entitlementId);
      if (!entitlement) return;
      selectCreatorAgent(entitlement);
      pendingOwnerActivationRef.current = payload;
      requestedConversationIdRef.current = payload.conversationId;
      return;
    }
    setBriefTask(null);
    await activateConversation(payload.conversationId, target);
  };

  useEffect(() => {
    const pending = pendingOwnerActivationRef.current;
    if (!pending || pending.entitlementId !== selectedEntitlementId) return;
    pendingOwnerActivationRef.current = null;
    void Promise.resolve().then(() => ownerActivationRef.current?.(pending))
      .catch((error) => ownerErrorRef.current?.(error));
  }, [selectedEntitlementId]);

  async function selectConversation(conversation) {
    const nextId = String(conversation?.id || "").trim();
    if (!isServerConversationId(nextId)) {
      setStatus("That Conversation is not a server record.");
      return;
    }
    const targetSession = sessionForConversation(nextId);
    if (!targetSession.ref("taskBriefRef").current) {
      targetSession.set("taskBrief", conversation?.brief_snapshot ?? null);
      targetSession.ref("taskBriefRef").current = conversation?.brief_snapshot ?? null;
    }
    setBriefTask(null);
    await activateConversation(nextId, targetSession);
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

  const localized = (content) => <I18nContext.Provider value={t}>{content}</I18nContext.Provider>;

  if (authState === "loading") return localized(<LaunchScreen />);
  if (authState === "network-error") {
    return localized(
      <NetworkErrorScreen
          message={startupError}
          onRetry={() => { setAuthState("loading"); setBootstrapAttempt((value) => value + 1); }}
          onSignOut={canUseAnotherAccountFromNetworkError(buyerSession) ? () => void signOut() : null}
        />
    );
  }
  if (authState === "unsupported-role") {
    return localized(<UnsupportedRoleScreen profile={buyerProfile} onSignOut={() => void signOut()} />);
  }
  if (!signedIn) {
    return localized(<SignInScreen onSignIn={(credentials) => void signIn(credentials)} status={signInStatus} error={signInError} />);
  }
  if (creatorAgentEntitlements.length === 0) {
    return localized(
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

  return localized(
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
          onOpenSettings={openSettingsWindow}
          onSignOut={() => void signOut()}
        />
      )}
      toolbar={(
        <DesktopConversationToolbar
          creatorAgent={creatorAgent}
          connected={conversationReady}
          loadingKey={conversationLoadingKey}
          conversationLibraryReady={conversationLibraryStatus === "ready"}
          workspaceGranted={workspaceGranted}
          retryExhausted={runtimeRetryExhausted}
          onRetry={retryRuntimeConnection}
        />
      )}
      inspector={(
        <DesktopInspector
          creatorAgent={creatorAgent}
          workspace={workspace}
          workspaceGranted={workspaceGranted}
          permissionMode={permissionMode}
          onChooseWorkspace={() => void chooseWorkspace()}
          onPermissionChange={updatePermissionMode}
        />
      )}
    >
      <section className="chat-shell desktop-chat-shell">
        {!windowStateRestored ? (
          <EmptyThread creatorAgent={creatorAgent} loadingKey={conversationLoadingKey} />
        ) : briefTask ? (
          <TaskBriefForm
            spec={briefTask.spec ?? briefSpecForSelectedEntitlement()}
            productName={creatorAgent.name}
            answers={briefTask.answers}
            status={briefTask.status}
            error={briefTask.error}
            onChange={(fieldId, value) => setBriefTask((current) => current
              ? {
                  ...current,
                  answers: { ...current.answers, [fieldId]: value },
                  error: ""
                }
              : current)}
            onCancel={() => setBriefTask(null)}
            onSubmit={() => void submitBriefTask()}
          />
        ) : (
          <ApprovalContext.Provider value={{ requests: approvalRequests, resolveToolApproval }}>
            <NativeContextMenuContext.Provider value={showNativeContextMenu}>
              <ConversationSessionContext.Provider key={conversationSession.scope.key} value={conversationSession}>
              <ConversationAssetContext.Provider value={{ serverUrl, accessToken: buyerSession?.accessToken, entitlementId: selectedEntitlementId, conversationId }}>
              <ConversationRuntimeProvider adapter={runtimeAdapter}>
                <ThreadPrimitive.Root className="thread-root">
                <ThreadPrimitive.Viewport
                  ref={viewportRef}
                  autoScroll={false}
                  className="thread-viewport"
                  onScroll={handleViewportScroll}
                >
                  {historyPage?.conversationId === conversationId && historyPage.has_more ? (
                    <div className="history-pagination">
                      <Button type="button" variant="secondary" disabled={olderLoading} onClick={() => void loadOlderHistory()}>
                        {olderLoading ? "Loading older messages…" : olderError ? "Retry older messages" : "Load older messages"}
                      </Button>
                      {olderError ? <small role="alert">{olderError}</small> : null}
                    </div>
                  ) : null}
                  <TaskBriefCard snapshot={taskBrief} />
                  <ThreadPrimitive.Empty>
                    <EmptyThread
                      connected={conversationReady}
                      creatorAgent={creatorAgent}
                      loadingKey={conversationLoadingKey}
                    />
                  </ThreadPrimitive.Empty>
                  <ThreadPrimitive.Messages components={{ Message: HatchMessage }} />
                </ThreadPrimitive.Viewport>
                <ThreadPrimitive.ViewportFooter className="composer-footer">
                  {sessionCloseError ? <div role="alert">{sessionCloseError}</div> : null}
                  {pendingSubmission ? (
                    <div role="status">
                      <small>{t(pendingSubmission.status === "failed" ? "submission.rejected" : "submission.unknown")}</small>
                      <Button type="button" onClick={() => void checkPendingSubmission()}>{t("submission.check")}</Button>
                      {pendingSubmission.status === "failed" ? <Button type="button" onClick={() => void returnPendingToDraft()}>{t("submission.returnToDraft")}</Button> : null}
                    </div>
                  ) : null}
                  {draftState.key === draftKey && draftState.error ? (
                    <div role="alert">
                      <small>{t(draftState.error.includes("draft_in_use") ? "draft.inUse" : "draft.saveFailed")}</small>
                      <Button type="button" onClick={() => setDraftRetry((value) => value + 1)}>{t("common.retry")}</Button>
                    </div>
                  ) : null}
                  <ComposerPrimitive.Root className="composer">
                    <DesktopComposerInput
                      key={draftKey}
                      className="composer-input"
                      draftKey={draftKey}
                      initialDraft={composerDraft}
                      restoreDraftNonce={composerRestoreRequest.nonce}
                      restoreDraftValue={composerRestoreRequest.value}
                      ready={windowContextReady && windowStateRestored && draftEditable}
                      disabled={!draftEditable}
                      onDraftChange={setComposerDraftValue}
                      onBlur={resetImeComposition}
                      onCompositionEnd={endImeComposition}
                      onCompositionStart={startImeComposition}
                      onKeyDownCapture={stopImeEnterSubmit}
                      onPaste={handleComposerPaste}
                      placeholder={conversationReady
                        ? t("conversation.messageAgent", { name: creatorAgent.name })
                        : conversationLoadingKey
                          ? t(conversationLoadingKey)
                          : t("conversation.offlineTitle")}
                      submitMode="enter"
                      rows={1}
                    />
                    <div className="composer-actions">
                      <ComposerControls
                        attachmentsDisabled={!draftEditable}
                        droppedFiles={draftEditable ? droppedFiles : []}
                        workspace={workspace}
                        workspaceGranted={workspaceGranted}
                        permissionMode={permissionMode}
                        onChooseWorkspace={() => void chooseWorkspace()}
                        onChooseFiles={() => void chooseContextFiles()}
                        onPermissionChange={updatePermissionMode}
                        onRemoveDroppedFile={(contextId) => {
                          if (!draftEditable) return;
                          droppedFilesRef.current = droppedFilesRef.current.filter((item) => item.contextId !== contextId);
                          setDroppedFiles((current) => current.filter((item) => item.contextId !== contextId));
                        }}
                      />
                      {/* Contract labels: aria-label="Stop response" and aria-label="Send message" */}
                      {running ? (
                        <IconButton
                          label={t("accessibility.stopStreaming")}
                          className="send-button stop-button"
                          variant="primary"
                          title={t("common.stop")}
                          type="button"
                          onClick={() => void cancelRun()}
                        >
                          <Square aria-hidden="true" fill="currentColor" strokeWidth={0} />
                        </IconButton>
                      ) : (
                        <ComposerPrimitive.Send
                          disabled={!draftEditable}
                          aria-label={t("common.send")}
                          className="send-button"
                          title={t("common.send")}
                        >
                          <span className="send-button-icon">
                            <ArrowUp aria-hidden="true" />
                          </span>
                        </ComposerPrimitive.Send>
                      )}
                    </div>
                  </ComposerPrimitive.Root>
                </ThreadPrimitive.ViewportFooter>
                </ThreadPrimitive.Root>
              </ConversationRuntimeProvider>
              </ConversationAssetContext.Provider>
              </ConversationSessionContext.Provider>
            </NativeContextMenuContext.Provider>
          </ApprovalContext.Provider>
        )}

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
  onOpenSettings,
  onSignOut
}) {
  const t = useI18n();
  const listedConversations = Array.isArray(conversations) ? conversations : [];
  // The server-issued Library is the only list authority. Never synthesize a
  // row for a URL/profile ID that the selected Agent's Library did not return.
  const visibleConversations = listedConversations;

  return (
    <div className="desktop-sidebar-content">
      <div className="desktop-sidebar-heading">
        <HatchBrand className="desktop-sidebar-brand" aria-label="Hatch." />
      </div>
      <nav className="desktop-source-list" aria-label={t("sidebar.creatorAgents")}>
        <div className="desktop-source-list-label">{t("sidebar.yourExperts")}</div>
        {entitlements.map((entitlement) => {
          const agent = creatorAgentFromEntitlement(entitlement);
          const selected = entitlement.entitlement_id === selectedEntitlementId;
          return (
            <React.Fragment key={entitlement.entitlement_id}>
              <NavigationItem
                active={selected}
                aria-expanded={selected}
                className={`desktop-source-row agent ${selected ? "selected" : ""}`}
                icon={<span className="creator-avatar">{agent.creatorInitials}</span>}
                trailing={selected
                  ? <ChevronDown className="desktop-agent-disclosure" aria-hidden="true" />
                  : <ChevronRight className="desktop-agent-disclosure" aria-hidden="true" />}
                onClick={() => onSelectAgent(entitlement)}
              >
                <span className="desktop-source-row-copy">
                  <strong title={agent.name}>{agent.name}</strong>
                </span>
              </NavigationItem>
              {selected ? (
                <div className="desktop-agent-conversation-group" role="group" aria-label={`${agent.name} ${t("sidebar.tasks")}`}>
                  <NavigationItem
                    aria-label={t("sidebar.newTask")}
                    className="desktop-source-row sidebar-new-task"
                    disabled={!conversationLibraryReady}
                    title={t("sidebar.newTask")}
                    icon={<Plus aria-hidden="true" />}
                    onClick={onNewConversation}
                  >
                    {t("sidebar.newTask")}
                  </NavigationItem>
                  {conversationLibraryStatus === "loading" || conversationLibraryStatus === "idle" ? (
                    <div className="desktop-source-empty compact">
                      <DesktopConnectionStatus state="connecting" compact />
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
                    <div className="desktop-source-empty compact">{t("sidebar.noTasks")}</div>
                  )}
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </nav>
      <div className="desktop-sidebar-footer">
        <div className="desktop-sidebar-footer__identity">
          <span className="avatar">{profile.initials}</span>
          <span className="desktop-sidebar-account"><strong>{profile.name}</strong></span>
        </div>
        <div className="profile-menu">
          <DropdownMenu
            label={t("account.menu")}
            trigger={<IconButton className="profile-settings-button" label={t("settings.open")} size="small" surface="raised"><Settings aria-hidden="true" /></IconButton>}
            items={[
              { value: "settings", label: t("settings.title"), onSelect: () => onOpenSettings?.() },
              { type: "separator" },
              { value: "sign-out", label: t("auth.signOut"), destructive: true, onSelect: () => onSignOut?.() }
            ]}
          />
        </div>
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
  const t = useI18n();
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
        <span className="desktop-source-row-copy">
          <Input
            aria-label={t("conversation.renameTask")}
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
          <small>{t("conversation.renameHint")}</small>
        </span>
      </div>
    );
  }
  return (
    <NavigationItem
      className={`desktop-source-row conversation ${selected ? "selected" : ""}`}
      active={selected}
      title={conversation.title || conversation.id}
      onClick={() => onSelect?.(conversation)}
      onContextMenu={contextMenu}
    >
      <span className="desktop-source-row-copy">
        <strong>{conversation.title || conversationTitle(conversation.id)}</strong>
      </span>
    </NavigationItem>
  );
}

function desktopConversationLoadingKey({ conversationReady, conversationLibraryStatus, windowStateRestored, chatLoading, status, runtimeRetryExhausted, workspaceGranted, hasConversation, intentionallyOffline }) {
  if (conversationLibraryStatus === "unavailable") return null;
  if (!windowStateRestored) return "connection.loadingWorkspace";
  if (conversationLibraryStatus === "idle" || conversationLibraryStatus === "loading") return "connection.loadingLibrary";
  if (conversationReady || runtimeRetryExhausted || intentionallyOffline) return null;
  if (chatLoading && status === "Loading history...") return "connection.loadingHistory";
  if (chatLoading || hasConversation) return "connection.connecting";
  return null;
}

function DesktopConnectionStatus({ state = "offline", compact = false, loadingKey = null }) {
  const t = useI18n();
  const normalizedState = ["connected", "connecting", "offline"].includes(state) ? state : "offline";
  const label = normalizedState === "connected"
    ? t("connection.connected")
    : normalizedState === "connecting"
      ? t(loadingKey || "connection.connecting")
      : t("connection.offline");
  return (
    <span
      aria-live="polite"
      className={`desktop-connection-status ${normalizedState}${compact ? " compact" : ""}`}
      role="status"
    >
      {normalizedState === "connecting" ? (
        <LoaderCircle className="connection-spinner" aria-hidden="true" />
      ) : (
        <span className="desktop-connection-dot" aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
}

function DesktopConversationToolbar({ creatorAgent, connected, loadingKey, conversationLibraryReady, workspaceGranted, retryExhausted, onRetry }) {
  const t = useI18n();
  const showRetry = Boolean(conversationLibraryReady && !connected && retryExhausted);
  const creatorName = String(creatorAgent?.creator || "").trim() || t("app.defaultCreatorName");
  const agentName = String(creatorAgent?.name || "").trim() || t("app.defaultAgentName");
  const title = creatorAgentContextTitle(creatorAgent);
  return (
    <>
      <div
        aria-label={title}
        className="desktop-toolbar-context"
        data-tauri-drag-region
        title={title}
      >
        <strong className="desktop-toolbar-conversation">{creatorName}</strong>
        <span className="desktop-toolbar-context-divider" aria-hidden="true">|</span>
        <span className="desktop-toolbar-agent-name">{agentName}</span>
      </div>
      {loadingKey ? <DesktopConnectionStatus state="connecting" loadingKey={loadingKey} compact /> : null}
      {showRetry ? (
        <>
          {/* Contract marker: aria-label="Retry connection" */}
        <Button
          aria-label={t("connection.retry")}
          className="chrome-icon-button desktop-connection-action desktop-connection-retry-button"
          variant="ghost"
          size="small"
          leading={<RefreshCw aria-hidden="true" />}
          title={t("connection.retry")}
          type="button"
          onClick={onRetry}
        >
          {t("common.retry")}
        </Button>
        </>
      ) : null}
    </>
  );
}

function DesktopInspector({
  creatorAgent,
  workspace,
  workspaceGranted,
  permissionMode,
  onChooseWorkspace,
  onPermissionChange
}) {
  const t = useI18n();
  const permissionLabel = (mode) => mode.value === "allow-changes"
    ? t("permission.allowChanges")
    : t("permission.askBeforeChanges");
  return (
    <div className="desktop-inspector-content">
      <section className="inspector-section">
        <span className="inspector-kicker">{t("workspace.title")}</span>
        <strong className="inspector-workspace-path" title={workspace || t("workspace.noFolderSelected")}>
          {workspaceGranted ? workspaceGrantLabel(workspace) : t("workspace.noWorkspaceSelected")}
        </strong>
        <Button className="inspector-action" variant="secondary" size="small" type="button" onClick={onChooseWorkspace}>
          {workspaceGranted ? t("common.changeFolder") : t("workspace.chooseFolderShort")}
        </Button>
      </section>
      <section className="inspector-section">
        <span className="inspector-kicker">{t("permission.label")}</span>
        <div className="inspector-select-control">
          <Select
            aria-label={t("accessibility.workspacePermissions")}
            leading={<ShieldIcon />}
            value={permissionMode}
            onValueChange={onPermissionChange}
            options={PERMISSION_OPTIONS.map((mode) => ({ value: mode.value, label: permissionLabel(mode) }))}
          />
        </div>
        <p>{permissionMode === "allow-changes" ? t("permission.allowChangesDetail") : t("permission.askBeforeChangesDetail")}</p>
      </section>
      <section className="inspector-section agent-boundary-section">
        <span className="inspector-kicker">{t("common.agent")}</span>
        <strong>{creatorAgent.name}</strong>
        <p>{t("common.byCreator", { creator: creatorAgent.creator })}. {t("conversation.agentContextKept")}</p>
      </section>
    </div>
  );
}

function ComposerControls({ droppedFiles = [], attachmentsDisabled = false, workspace, workspaceGranted, permissionMode, onChooseWorkspace, onChooseFiles, onPermissionChange, onRemoveDroppedFile }) {
  const t = useI18n();
  const permissionLabel = (mode) => mode.value === "allow-changes"
    ? t("permission.allowChanges")
    : t("permission.askBeforeChanges");
  const attachmentControl = (
    <Button
      aria-label={t("composer.attachContextFiles")}
      disabled={attachmentsDisabled}
      className="composer-control attachment-composer-control"
      variant="ghost"
      size="small"
      leading={<Paperclip aria-hidden="true" />}
      title={t("composer.attachContextFiles")}
      type="button"
      onClick={onChooseFiles}
    >
      {t("composer.attachFiles")}
    </Button>
  );
  return (
    <div className="composer-controls">
      {droppedFiles.length > 0 ? (
        <div className="composer-attachments" aria-label={t("composer.droppedContextFiles")}>
          {droppedFiles.map((file) => (
            <span className="composer-attachment" key={file.contextId} title={file.displayName}>
              <span className="composer-attachment-name">{file.displayName}</span>
              <IconButton size="small" variant="ghost" label={t("composer.removeAttachment", { name: file.displayName })} onClick={() => onRemoveDroppedFile?.(file.contextId)}>×</IconButton>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-settings">
        {attachmentControl}
        <ButtonControl
          aria-label={t("accessibility.chooseWorkspaceFolder")}
          className="composer-control"
          size="compact"
          surface="raised"
          leading={<WorkspaceIcon />}
          trailing={<ChevronDown className="hui-control-caret" aria-hidden="true" />}
          title={workspace || t("workspace.chooseFolder")}
          type="button"
          onClick={onChooseWorkspace}
        >
          {workspaceGranted ? workspaceGrantLabel(workspace) : t("workspace.chooseWorkspace")}
        </ButtonControl>
        <SelectControl
          className="composer-control"
          size="compact"
          surface="raised"
          title={permissionMode === "allow-changes" ? t("permission.allowChangesDetail") : t("permission.askBeforeChangesDetail")}
          aria-label={t("accessibility.workspacePermissions")}
          leading={<ShieldIcon />}
          value={permissionMode}
          onValueChange={onPermissionChange}
          options={PERMISSION_OPTIONS.map((mode) => ({ value: mode.value, label: permissionLabel(mode, t) }))}
        />
      </div>
    </div>
  );
}

function creatorAgentContextTitle(agent) {
  const creator = String(agent?.creator || "").trim();
  const name = String(agent?.name || "").trim();
  return [creator, name].filter(Boolean).join(" | ") || "Hatch";
}

function conversationTitle(conversationId) {
  const value = String(conversationId || "").trim();
  if (!value || value === "desktop-chat") return "New task";
  return value.replace(/^conversation_[^_]+_/, "Task ").replaceAll("_", " ");
}

function stableRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replaceAll("-", "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function historyMessageToThreadMessage(message) {
  const id = message.id;
  const createdAt = messageCreatedAt(message.timestamp);
  if (message.role === "user") {
    return makeUserMessage(id, message.content ?? "", createdAt, {
      attachments: message.attachments,
      runId: message.run_id
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
    ...(attachments.length > 0 ? { attachments: assistantUiAttachments(options.attachments) } : {}),
    createdAt: new Date(createdAt),
    metadata: {
      custom: {
        source: "hatch",
        ...(options.runId ? { runId: options.runId } : {}),
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
      ...(attachment.kind === "local_file" ? {
        kind: "local_file", host_id: attachment.host_id, local_path: attachment.local_path,
        sha256: attachment.sha256
      } : attachment.kind === "asset" ? {
        kind: "asset",
        asset_id: typeof attachment.asset_id === "string" ? attachment.asset_id : attachmentId,
        sha256: typeof attachment.sha256 === "string" ? attachment.sha256 : ""
      } : { truncated: attachment.truncated === true })
    }];
  });
}

function assistantUiAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    if (!attachment || typeof attachment !== "object") return [];
    const attachmentId = typeof attachment.attachment_id === "string" ? attachment.attachment_id : "";
    const name = typeof attachment.display_name === "string" ? attachment.display_name : "Attachment";
    const mediaType = typeof attachment.media_type === "string" ? attachment.media_type : "application/octet-stream";
    if (!attachmentId) return [];
    const image = (attachment.kind === "asset" || attachment.kind === "local_file") && mediaType.startsWith("image/") && typeof attachment.data_base64 === "string"
      ? [{ type: "image", image: `data:${mediaType};base64,${attachment.data_base64}` }]
      : [];
    return [{
      id: attachmentId,
      type: mediaType.startsWith("image/") ? "image" : isDocumentMediaType(mediaType) ? "document" : "file",
      name,
      contentType: mediaType,
      status: { type: "complete" },
      content: image,
      hatch: {
        assetId: attachment.kind === "asset" ? attachment.asset_id : undefined,
        localReference: attachment.kind === "local_file" ? {
          attachmentId, hostId: attachment.host_id, localPath: attachment.local_path, sha256: attachment.sha256
        } : undefined,
        sourceBytes: Number.isSafeInteger(Number(attachment.source_bytes)) ? Number(attachment.source_bytes) : 0,
        mediaType
      }
    }];
  });
}

function isDocumentMediaType(mediaType) {
  return mediaType === "application/pdf"
    || mediaType.includes("word")
    || mediaType.includes("excel")
    || mediaType.includes("powerpoint")
    || mediaType.includes("spreadsheet")
    || mediaType.includes("presentation");
}

function formatAttachmentSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
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
      ? event.result ?? existing?.result ?? (event.detail_ref ? undefined : { status: "ok" })
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
      detailRef: event.detail_ref ?? existing?.artifact?.detailRef,
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
    detail_ref: toolCall.detail_ref,
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

function EmptyThread({ connected, creatorAgent, loadingKey }) {
  const t = useI18n();
  const preparing = Boolean(loadingKey);
  if (preparing) {
    return (
      <div className="empty-thread empty-thread-loading" role="status" aria-live="polite">
        <LoaderCircle className="empty-thread-spinner" aria-hidden="true" />
        <span>{t(loadingKey)}</span>
      </div>
    );
  }
  return (
    <div className="empty-thread">
      <span className="creator-avatar large">{creatorAgent.creatorInitials}</span>
      <span className="empty-kicker">{creatorAgent.creator}</span>
      <h2>
        {connected
          ? t("conversation.emptyTitle")
          : t("conversation.offlineTitle")}
      </h2>
      {connected ? <p>{creatorAgent.description}</p> : null}
      {creatorAgent.boundary ? <small className="boundary-copy">{creatorAgent.boundary}</small> : null}
    </div>
  );
}

function TaskBriefForm({ spec, productName, answers, status, error, onChange, onCancel, onSubmit }) {
  const t = useI18n();
  const fields = Array.isArray(spec?.fields) ? spec.fields : [];
  const submitting = status === "submitting";
  const complete = fields.length > 0 && fields.every((field) => (
    !field.required || String(answers?.[field.id] ?? "").trim().length > 0
  ));
  return (
    <div className="task-brief-stage">
      <section className="task-brief-form" aria-labelledby="task-brief-title">
        <div className="task-brief-heading">
          <span className="eyebrow">{t("brief.title")}</span>
          <h2 id="task-brief-title">{t("brief.title")}</h2>
          {productName ? <strong className="task-brief-product">{productName}</strong> : null}
          <p>{t("brief.subtitle")}</p>
        </div>
        {fields.length === 0 ? (
          <div className="task-brief-error" role="alert">{error || t("brief.missingSpec")}</div>
        ) : (
          <div className="task-brief-fields">
            {fields.map((field) => (
              <label className="task-brief-field" key={field.id}>
                <span className="task-brief-field-label">
                  <strong>{field.label}</strong>
                  <small>{field.required ? t("brief.required") : t("brief.optional")}</small>
                </span>
                <textarea
                  rows={4}
                  value={answers?.[field.id] ?? ""}
                  aria-required={field.required ? "true" : "false"}
                  disabled={submitting}
                  onChange={(event) => onChange(field.id, event.target.value)}
                />
              </label>
            ))}
          </div>
        )}
        {error && fields.length > 0 ? <div className="task-brief-error" role="alert">{error}</div> : null}
        <div className="task-brief-actions">
          <Button variant="secondary" type="button" onClick={onCancel} disabled={submitting}>
            {t("brief.cancel")}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={submitting || !complete}>
            {submitting ? t("brief.submitting") : t("brief.submit")}
          </Button>
        </div>
      </section>
    </div>
  );
}

function TaskBriefCard({ snapshot }) {
  const t = useI18n();
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  if (!snapshot || fields.length === 0) return null;
  return (
    <details className="task-brief-card">
      <summary className="task-brief-card-heading">
        <strong>{t("brief.cardTitle")}</strong>
        <span>{t("brief.readOnly")}</span>
      </summary>
      <dl>
        {fields.map((field) => (
          <div className="task-brief-card-row" key={field.id}>
            <dt>{field.label}</dt>
            <dd>{field.value || <em>{t("brief.empty")}</em>}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function WorkspaceIcon() {
  return <FolderOpen aria-hidden="true" />;
}

function ShieldIcon() {
  return <ShieldAlert aria-hidden="true" />;
}

function WorkspaceOnboarding({ creatorName, draft, onChoose, onGrant, status }) {
  const t = useI18n();
  return (
    <div className="workspace-onboarding">
      <section className="workspace-onboarding-card">
        <div className="workspace-onboarding-icon"><WorkspaceIcon /></div>
        <h2>{t("workspace.requiredTitle")}</h2>
        <p>{t("workspace.creatorScope", { creator: creatorName })}</p>

        <Button className={`workspace-picker ${draft ? "selected" : ""}`} variant="secondary" type="button" leading={<WorkspaceIcon />} onClick={onChoose}>
          <span className="workspace-picker-copy">
            <strong>{draft ? workspaceGrantLabel(draft) : t("workspace.chooseComputerFolder")}</strong>
          </span>
          <span className="workspace-picker-action">{draft ? t("common.change") : t("common.choose")}</span>
        </Button>

        <Button className="workspace-grant-button" type="button" onClick={onGrant} disabled={!draft.trim()}>
          {t("common.start")}
        </Button>
        {status && status !== "Offline" ? <small className="workspace-onboarding-status">{status}</small> : null}
      </section>
    </div>
  );
}

function LaunchScreen() {
  const t = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <WelcomeTitlebarDragRegion />
      <HatchBrand className="welcome-brand" aria-label="Hatch" />
      <section className="status-card">
        <span className="eyebrow">{t("app.name")}</span>
        <h1>{t("startup.openingWorkspace")}</h1>
        <p>{t("startup.checkingAccount")}</p>
      </section>
    </main>
  );
}

function NetworkErrorScreen({ message, onRetry, onSignOut }) {
  const t = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <WelcomeTitlebarDragRegion />
      <HatchBrand className="welcome-brand" aria-label="Hatch" />
      <section className="status-card">
        <span className="eyebrow">{t("connection.eyebrow")}</span>
        <h1>{t("connection.cannotReachTitle")}</h1>
        <p>{message || t("connection.checkAndRetry")}</p>
        <small>{t("connection.savedAccessLocal")}</small>
        <Button type="button" onClick={onRetry}>{t("common.retry")}</Button>
        {onSignOut ? <Button variant="secondary" type="button" onClick={onSignOut}>{t("auth.signOutOrAnotherAccount")}</Button> : null}
      </section>
    </main>
  );
}

function UnsupportedRoleScreen({ profile, onSignOut }) {
  const t = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <WelcomeTitlebarDragRegion />
      <HatchBrand className="welcome-brand" aria-label="Hatch" />
      <section className="status-card">
        <span className="eyebrow">{t("auth.consumerDesktopEyebrow")}</span>
        <h1>{t("auth.buyerAccountTitle")}</h1>
        <p>{CONSUMER_DESKTOP_ROLE_MESSAGE}</p>
        <small>{t("auth.creatorSignedIn", { name: profile.name })}</small>
        <Button type="button" onClick={onSignOut}>{t("auth.signOut")}</Button>
      </section>
    </main>
  );
}

function EmptyAgentsScreen({ profile, onBrowse, onRefresh, onSignOut, refreshing, error, notice }) {
  const t = useI18n();
  return (
    <main className="welcome-screen status-screen empty-agents-screen">
      <WelcomeTitlebarDragRegion />
      <HatchBrand className="welcome-brand" aria-label="Hatch" />
      <section className="status-card empty-agents-card">
        <div className="empty-agents-header">
          <span className="avatar">{profile.initials}</span>
          <span><strong>{profile.name}</strong></span>
          <Button className="profile-sign-out" variant="ghost" size="small" type="button" onClick={onSignOut}>{t("auth.signOut")}</Button>
        </div>
        <span className="eyebrow">{t("account.yourCreatorAgents")}</span>
        <h1>{t("account.findAgentTitle")}</h1>
        <p>{t("account.readyBrowse")}</p>
        {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <Button type="button" size="large" onClick={onBrowse}>{t("account.browseAgents")}</Button>
        <Button className="status-refresh" variant="secondary" type="button" onClick={onRefresh} loading={refreshing}>
          {t("common.refresh")}
        </Button>
      </section>
    </main>
  );
}

function SignInScreen({ onSignIn, status, error }) {
  const t = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loading = status === "loading";

  function submit(event) {
    event.preventDefault();
    onSignIn({ email, password });
  }

  return (
    <main className="welcome-screen">
      <WelcomeTitlebarDragRegion />
      <section className="sign-in-card">
        <HatchBrand className="welcome-brand" aria-label="Hatch" />
        <h1>{t("auth.signInTitle")}</h1>
        <form className="sign-in-form" onSubmit={submit}>
          <FormField className="field" label={t("auth.email")}>
            <Input autoCapitalize="none" autoComplete="email" spellCheck="false" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("auth.emailPlaceholder")} disabled={loading} />
          </FormField>
          <FormField className="field" label={t("auth.password")}>
            <Input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("auth.passwordPlaceholder")} disabled={loading} />
          </FormField>
          <Button type="submit" size="large" loading={loading} disabled={!email.trim() || !password.trim()}>{t("auth.signIn")}</Button>
        </form>
        {error ? <small className="sign-in-error" role="alert">{error}</small> : null}
      </section>
    </main>
  );
}

function WelcomeTitlebarDragRegion() {
  return <div className="welcome-titlebar-drag-region" data-tauri-drag-region aria-hidden="true" />;
}

function InlineChatAttachment({ attachment }) {
  const scope = useContext(ConversationAssetContext);
  const elementRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const assetId = attachment?.hatch?.assetId;
  const localReference = attachment?.hatch?.localReference;
  const localKey = localReference ? JSON.stringify(localReference) : "";
  const imagePart = Array.isArray(attachment?.content)
    ? attachment.content.find((part) => part?.type === "image" && typeof part.image === "string")
    : undefined;
  useEffect(() => {
    if (!elementRef.current || attachment?.type !== "image" || (!assetId && !localReference) || imagePart) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: elementRef.current.closest(".thread-viewport"), rootMargin: "160px" });
    observer.observe(elementRef.current);
    return () => observer.disconnect();
  }, [assetId, localKey, attachment?.type, imagePart]);
  useEffect(() => {
    if (!visible || (!localReference && (!scope || !assetId)) || imagePart) return;
    let cancelled = false;
    setError("");
    setPreview("");
    const load = localReference ? readLocalAttachmentImage(invokeTauri, localReference)
      : getConversationAsset(scope.serverUrl, scope.accessToken, scope, scope.conversationId, assetId)
        .then((data) => `data:${attachment.contentType};base64,${data}`);
    load.then((data) => { if (!cancelled) setPreview(data); })
      .catch((failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [visible, scope?.serverUrl, scope?.accessToken, scope?.entitlementId, scope?.conversationId, assetId, localKey, imagePart, attempt]);
  async function download() {
    if (!scope || !assetId || downloading) return;
    setDownloading(true);
    setError("");
    try {
      const data = imagePart?.image || preview || `data:${attachment.contentType};base64,${await getConversationAsset(scope.serverUrl, scope.accessToken, scope, scope.conversationId, assetId)}`;
      const link = document.createElement("a");
      link.href = data;
      link.download = attachment.name || "attachment";
      link.click();
    } catch (failure) { setError(failure.message); }
    finally { setDownloading(false); }
  }
  const controls = <>
    {localReference ? <button type="button" disabled={saving} onClick={() => {
      setSaving(true); setError("");
      void invokeTauri("save_local_attachment", { contextId: localReference.attachmentId,
        hostId: localReference.hostId, sha256: localReference.sha256 })
        .catch((failure) => setError(errorMessage(failure)))
        .finally(() => setSaving(false));
    }}>{saving ? "Saving…" : "Save as…"}</button> : null}
    {localReference ? <button type="button" disabled={opening} onClick={() => {
      setOpening(true); setError("");
      void invokeTauri("open_local_attachment", { contextId: localReference.attachmentId,
        hostId: localReference.hostId, sha256: localReference.sha256 })
        .catch((failure) => setError(errorMessage(failure)))
        .finally(() => setOpening(false));
    }}>{opening ? "Opening…" : "Open"}</button> : null}
    {assetId ? <button type="button" disabled={downloading} onClick={() => void download()}>{downloading ? "Downloading…" : "Download"}</button> : null}
    {error ? <span role="alert">{error}<button type="button" onClick={() => {
      if (attachment?.type !== "image") { if (localReference) setError(""); else void download(); return; }
      setError(""); setPreview(""); setAttempt((value) => value + 1);
    }}>{attachment?.type === "image" ? "Retry preview" : localReference ? "Dismiss" : "Retry download"}</button></span> : null}
  </>;
  const image = imagePart?.image || preview;
  if (attachment?.type === "image") {
    return (
      <div ref={elementRef} className="message-attachment message-attachment-image" aria-busy={visible && !image && !error}>
        {image ? <img key={attempt} src={image} alt={attachment.name || "Attached image"} loading="lazy" onError={() => setError("Image preview unavailable.")} /> : <span style={{ minHeight: 120, display: "block" }}>{attachment.name}</span>}
        <span className="message-attachment-caption">{attachment.name}</span>
        {visible && !image && !error ? <span role="status">Loading preview…</span> : null}
        {controls}
      </div>
    );
  }
  const sourceBytes = Number(attachment?.hatch?.sourceBytes);
  return (
    <div className="message-attachment message-attachment-file">
      <FileText aria-hidden="true" />
      <span className="message-attachment-file-name" title={attachment?.name}>{attachment?.name || "Attached file"}</span>
      {Number.isFinite(sourceBytes) && sourceBytes > 0 ? <small>{formatAttachmentSize(sourceBytes)}</small> : null}
      {controls}
    </div>
  );
}

function HatchMessage() {
  const role = useMessage((message) => message.role);
  if (role !== "assistant") {
    return (
      <MessagePrimitive.Root className={`chat-message ${role}`}>
        <div className={`message-surface ${role}`}>
          <MessagePrimitive.Attachments>
            {({ attachment }) => <InlineChatAttachment attachment={attachment} />}
          </MessagePrimitive.Attachments>
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
  const activityMessageId = useMessage((message) => message.id);
  const [open, setOpen] = useConversationUiState(`activity:${activityMessageId}:${indices[0]}`, isRunning && visibleActivityParts.length > 0);
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
  const toolItemCount = activityParts.filter((part) => part.type === "tool-call").length;
  const summary = activitySummary({
    isRunning,
    failed,
    filtered,
    elapsedMs,
    activeLabel: active?.label ?? (isRunning && hasAnswerText ? "Answering" : "")
  });
  if (shouldHideWorkedSummary({ isRunning, failed, filtered, toolItemCount })) {
    return visibleActivityParts.length > 0
      ? <div className="assistant-activity-items">{children}</div>
      : null;
  }
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
    <div className={`assistant-activity-shell ${tone}`}>
      <details
        className="assistant-activity-block"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="assistant-activity-summary expandable">{summaryContent}</summary>
        <div className="assistant-activity-items">{children}</div>
      </details>
      <div className="assistant-activity-divider" aria-hidden="true" />
    </div>
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
  const activityMessageId = useMessage((message) => message.id);
  const [open, setOpen] = useConversationUiState(`tools:${activityMessageId}:${indices[0]}`, status?.type === "running");
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
  const scope = useContext(ConversationAssetContext);
  const detailRef = props.artifact?.detailRef;
  const detailKey = `tool:${detailRef?.run_id || ""}:${props.toolCallId}`;
  const [detail, setDetail] = useConversationUiState(`${detailKey}:content`, null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailOpen, setDetailOpen] = useConversationUiState(`${detailKey}:open`, false);
  const detailRequestRef = useRef(0);
  useEffect(() => () => { detailRequestRef.current += 1; }, [scope?.conversationId, scope?.entitlementId, scope?.accessToken, detailRef?.run_id, detailRef?.tool_call_id]);
  useEffect(() => {
    if (detailOpen && !detail && !detailError) void loadDetail();
  }, [detailOpen, detail]);
  async function loadDetail() {
    if (!scope || !detailRef || detailLoading || detail) return;
    const request = ++detailRequestRef.current;
    setDetailLoading(true);
    setDetailError("");
    try {
      const tool = await getConversationToolDetail(scope.serverUrl, scope.accessToken, scope, scope.conversationId, detailRef);
      if (request === detailRequestRef.current) setDetail(tool);
    } catch (error) {
      if (request === detailRequestRef.current) setDetailError(error.message);
    } finally {
      if (request === detailRequestRef.current) setDetailLoading(false);
    }
  }
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
      {detailRef ? <details className="tool-detail" open={detailOpen} onToggle={(event) => {
        setDetailOpen(event.currentTarget.open);
        if (event.currentTarget.open && !detail && !detailError) void loadDetail();
      }}>
        <summary>Tool details</summary>
        {detailLoading ? <span role="status">Loading tool details…</span> : null}
        {detailError ? <div role="alert">{detailError}<button type="button" onClick={() => void loadDetail()}>Retry</button></div> : null}
        {detail ? <><pre aria-label="Tool arguments">{JSON.stringify(detail.arguments, null, 2)}</pre><pre aria-label="Tool result">{JSON.stringify(detail.result ?? detail.error, null, 2)}</pre></> : null}
      </details> : null}
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
              <Button type="button" onClick={() => approvals.resolveToolApproval(props.toolCallId, true)}>
                Allow
              </Button>
              <Button type="button" variant="secondary" onClick={() => approvals.resolveToolApproval(props.toolCallId, false)}>
                Deny
              </Button>
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

function browserPreferredLocales() {
  if (typeof navigator === "undefined") return [DEFAULT_LANGUAGE];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages.filter((locale) => typeof locale === "string" && locale.trim());
  }
  return typeof navigator.language === "string" && navigator.language.trim()
    ? [navigator.language]
    : [DEFAULT_LANGUAGE];
}

function languageNativeName(language) {
  return LANGUAGE_OPTIONS.find((option) => option.value === language)?.nativeLabel
    || LANGUAGE_OPTIONS.find((option) => option.value === DEFAULT_LANGUAGE)?.nativeLabel
    || "English";
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
    if (file?.attachment?.kind === "local_file" && file.attachment.attachment_id === contextId) {
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
    files: pending.map((file) => file.attachment?.kind === "local_file" && file.attachment.attachment_id === file.contextId
      ? file
      : { ...file, attachment: preparedById.get(file.contextId) })
  };
}

class RendererErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[hatch:renderer-error]", error, info);
  }

  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    const message = error instanceof Error ? error.message : String(error);
    return (
      <main
        role="alert"
        style={{
          boxSizing: "border-box",
          minHeight: "100%",
          padding: "96px 48px",
          color: "#221c17",
          background: "#f3ede3",
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif"
        }}
      >
        <h1 style={{ margin: 0, fontSize: "28px", fontWeight: 600 }}>Hatch could not open</h1>
        <p style={{ margin: "16px 0 0", maxWidth: "720px", lineHeight: 1.5 }}>
          The desktop renderer stopped during startup. Reopen Hatch after updating to the latest build.
        </p>
        <pre style={{ marginTop: "24px", whiteSpace: "pre-wrap", fontSize: "13px", lineHeight: 1.5 }}>{message}</pre>
      </main>
    );
  }
}

async function invokeTauri(command, args) {
  return invokeDesktopCommand(command, args, {
    invokeImpl: invoke,
    packaged: Boolean(globalThis.window?.__TAURI_INTERNALS__)
  });
}

createRoot(document.getElementById("root")).render(
  <RendererErrorBoundary>
    <HatchUIProvider atmosphere className="desktop-ui-root">
      <App />
    </HatchUIProvider>
  </RendererErrorBoundary>
);
