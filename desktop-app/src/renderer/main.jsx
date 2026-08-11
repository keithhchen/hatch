import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/dm-mono/400.css";
import { invoke } from "@tauri-apps/api/core";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage
} from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import "streamdown/styles.css";
import "../../../packages/brand/tokens.css";
import hatchMarkUrl from "../../../packages/brand/hatch-mark.svg";
import "./styles.css";
import {
  DEFAULT_CREATOR_AGENT,
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_OPTIONS,
  PERMISSION_POLICIES,
  canStartConversation,
  creatorAgentFromSession,
  creatorAgentFromEntitlement,
  CHANGE_TOOLS,
  PLATFORM_LOCAL_TOOLS,
  normalizePermissionPolicy,
  shouldRequestDesktopApproval,
  workspaceGrantLabel
} from "./product-policy.js";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";
import {
  clearAuthSession,
  createTauriAuthStorage,
  loadSavedAuthSession,
  isAuthInvalidError,
  isNetworkError,
  isSecureSessionReadError,
  startAuthSessionSignOut
} from "./auth-session.js";
import {
  persistedDesktopSessionFromError,
  resolveDesktopSession,
  signInDesktopSession
} from "./desktop-auth-flow.js";
import { openCreatorAgentCatalog } from "./catalog-opener.js";
import { projectApprovedRuntimeStream, summarizeTurnTiming } from "./stream-projection.js";
import { createTauriSettingsStore } from "./desktop-settings.js";
import {
  importLegacyProfileSettings,
  purgeLegacySensitiveStorage
} from "./legacy-settings-migration.js";
import {
  isInvalidWorkspaceGrantError,
  isWorkspaceGrantError,
  localizedWorkspaceCommandError,
  normalizeWorkspaceGrant,
  validateRestoredWorkspace,
  workspacePickerSelection
} from "./workspace-restore.js";
import { accessSnapshotForToolCall, createTurnAccessSnapshot } from "./turn-access-snapshot.js";
import { canUseAnotherAccountFromNetworkError } from "./network-error-recovery.js";
import {
  entitlementRefreshNeedsReconnect,
  runtimeBindingForEntitlement,
  runtimeBindingMatches
} from "./entitlement-binding.js";
import {
  committedResultAfterCancellation,
  localToolCancellationError,
  localToolTransportDeadlineMs,
  protocolToolError
} from "./local-tool-lifecycle.js";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  SYSTEM_LANGUAGE,
  createTranslator,
  englishMessage,
  formatDuration as formatLocalizedDuration,
  normalizeLanguagePreference,
  resolveLanguage,
  runtimeAssistantStatusDescriptor,
  runtimeTurnStatusDescriptor
} from "./i18n.js";

const PROTOCOL_VERSION = "0.6";
const SKILL_ACTIVITY_PART = "hatch.skill_activity";
const SKILL_RUN_ACTIVITY_PART = "hatch.skill_run_activity";
const DEFAULT_RUNTIME_URL = import.meta.env.VITE_HATCH_RUNTIME_URL || "wss://hatch.tokenquadrant.cn/v1/runtime";
const DEFAULT_AUTH_URL = import.meta.env.VITE_HATCH_AUTH_URL || "https://hatch.tokenquadrant.cn";
const BROWSE_CATALOG_URL = import.meta.env.VITE_HATCH_CATALOG_URL || "https://hatch.tokenquadrant.cn/agents";
const EMPTY_PROFILE = Object.freeze({ id: "anonymous", name: "", initials: "" });
const DEFAULT_PERMISSION_MODE = DEFAULT_PERMISSION_POLICY;
const ApprovalContext = createContext(null);
const I18nContext = createContext({
  language: DEFAULT_LANGUAGE,
  languagePreference: SYSTEM_LANGUAGE,
  systemLanguage: DEFAULT_LANGUAGE,
  t: createTranslator(DEFAULT_LANGUAGE)
});

function useI18n() {
  return useContext(I18nContext);
}

function App() {
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
  const entitlementRefreshRef = useRef(false);
  const lastEntitlementRefreshRef = useRef(0);
  const pendingClearSessionRef = useRef(null);
  const languageChangeRevisionRef = useRef(0);
  const systemLocalesRef = useRef(browserPreferredLocales());
  const initialSystemLanguage = resolveLanguage(SYSTEM_LANGUAGE, systemLocalesRef.current);
  const [languagePreference, setLanguagePreference] = useState(SYSTEM_LANGUAGE);
  const [language, setLanguage] = useState(initialSystemLanguage);
  const [systemLanguage, setSystemLanguage] = useState(initialSystemLanguage);
  const t = useMemo(() => createTranslator(language), [language]);
  const translatorRef = useRef(t);
  translatorRef.current = t;
  const [serverUrl] = useState(DEFAULT_RUNTIME_URL);
  const [workspace, setWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [workspaceGrant, setWorkspaceGrant] = useState(null);
  const [workspaceDraftGrant, setWorkspaceDraftGrant] = useState(null);
  const [authState, setAuthState] = useState("loading");
  const [startupError, setStartupError] = useState("");
  const [secureSessionError, setSecureSessionError] = useState("");
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
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  const [interruptedRun, setInterruptedRun] = useState(null);
  const [conversationId, setConversationId] = useState("desktop-chat");
  const [status, setStatus] = useState(() => uiStatus("connection.offline"));
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState([]);
  const [approvalRequests, setApprovalRequests] = useState({});
  const [creatorAgent, setCreatorAgent] = useState(DEFAULT_CREATOR_AGENT);
  const buyerProfile = buyerSession?.profile ?? EMPTY_PROFILE;
  const signedIn = authState === "signed-in";

  selectedEntitlementIdRef.current = selectedEntitlementId;

  function getProfileSetting(key, fallback = undefined, profileId = buyerProfile.id) {
    return settingsStoreRef.current?.getProfile(profileId, key, fallback) ?? fallback;
  }

  function setProfileSetting(key, value, profileId = buyerProfile.id) {
    settingsStoreRef.current?.setProfile(profileId, key, value);
  }

  function applyLanguagePreference(preference, locales = systemLocalesRef.current) {
    const normalized = normalizeLanguagePreference(preference);
    const detectedSystemLanguage = resolveLanguage(SYSTEM_LANGUAGE, locales);
    setLanguagePreference(normalized);
    setSystemLanguage(detectedSystemLanguage);
    setLanguage(resolveLanguage(normalized, locales));
  }

  async function changeLanguagePreference(nextPreference) {
    const revision = ++languageChangeRevisionRef.current;
    const normalized = normalizeLanguagePreference(nextPreference);
    applyLanguagePreference(normalized);
    try {
      await settingsStoreRef.current.setApp("language", normalized);
    } catch (error) {
      if (revision === languageChangeRevisionRef.current) {
        applyLanguagePreference(settingsStoreRef.current.getApp("language", SYSTEM_LANGUAGE));
      }
      throw error;
    }
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

  function chooseEntitlement(entitlements, profileId, currentId = "") {
    if (!Array.isArray(entitlements) || entitlements.length === 0) return null;
    const active = entitlements
      .filter((item) => item?.status === "active")
      .sort((left, right) => Date.parse(right.granted_at || "") - Date.parse(left.granted_at || ""));
    if (active.length === 0) return null;
    const current = active.find((item) => item.entitlement_id === currentId);
    if (current) return current;
    const previousId = settingsStoreRef.current?.getProfile(profileId, "last_selected_entitlement_id", "");
    return active.find((item) => item.entitlement_id === previousId) || active[0];
  }

  function applySignedInSession(session, entitlements, { preserveCurrent = false } = {}) {
    const profileId = session.profile?.id || EMPTY_PROFILE.id;
    const selected = chooseEntitlement(
      entitlements,
      profileId,
      preserveCurrent ? selectedEntitlementIdRef.current : ""
    );
    const mustRebindRuntime = entitlementRefreshNeedsReconnect(connectionConfigRef.current, selected);
    if (mustRebindRuntime) {
      disconnectRuntime();
      const fallback = selected
        ? `conversation_${profileId}_${selected.creator_id || "creator"}_${selected.agent_id || selected.product?.id || "agent"}`
        : `conversation_${profileId}_desktop`;
      setConversationId(selected
        ? getConversationId(profileId, selected.entitlement_id, fallback)
        : fallback);
      setMessages([]);
    }
    setBuyerSession(session);
    setCreatorAgentEntitlements(entitlements);
    setSelectedEntitlementId(selected?.entitlement_id || "");
    setCreatorAgent(selected ? creatorAgentFromEntitlement(selected) : DEFAULT_CREATOR_AGENT);
    setEntitlementError("");
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
        setSettingsMigrationNotice(migration.noticeKey ? localizedMessage(migration.noticeKey) : "");
      } catch {
        setSettingsMigrationNotice(localizedMessage("migration.failed"));
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
    pendingClearSessionRef.current = null;
    activeRunRef.current = null;
    setInterruptedRun(null);
    setBuyerSession(null);
    setAuthState("signed-out");
    setCreatorAgentEntitlements([]);
    setEntitlementError("");
    setSelectedEntitlementId("");
    setCreatorAgent(DEFAULT_CREATOR_AGENT);
    setMessages([]);
    setWorkspace("");
    setWorkspaceDraft("");
    setWorkspaceGrant(null);
    setWorkspaceDraftGrant(null);
    workspaceGrantRef.current = null;
    setWorkspaceGranted(false);
    setConversationId("desktop-chat");
    setSignInStatus("idle");
    setStartupError("");
    setSecureSessionError("");
    setSettingsMigrationNotice("");
    connectionConfigRef.current = null;
  }

  async function clearSavedSessionOrShowError(session, clearPromise) {
    pendingClearSessionRef.current = session;
    try {
      await (clearPromise ?? clearAuthSession(session, authStorageRef.current));
    } catch {
      setSecureSessionError(localizedMessage("error.auth.secureSessionClearFailed"));
      setAuthState("secure-session-error");
      return false;
    }
    resetToSignedOut();
    return true;
  }

  async function retrySecureSessionClear() {
    const session = pendingClearSessionRef.current;
    if (!session) {
      resetToSignedOut();
      return;
    }
    await clearSavedSessionOrShowError(session);
  }

  useEffect(() => {
    document.documentElement.lang = language;
    setMessages((current) => current.map((message) => localizeStoredUiMessage(message, t)));
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrapAuth() {
      if (window.__TAURI_INTERNALS__) {
        try {
          purgeLegacySensitiveStorage(window.localStorage);
        } catch (error) {
          if (cancelled) return;
          setSecureSessionError(localizedMessage("auth.removeLegacyDataFailed", {
            error: errorMessage(error)
          }));
          setAuthState("secure-session-read-error");
          return;
        }
      }
      const [, nativeLocales] = await Promise.all([
        settingsStoreRef.current.load(),
        loadNativeSystemLocales(invoke)
      ]);
      if (cancelled) return;
      systemLocalesRef.current = nativeLocales;
      const savedLanguage = settingsStoreRef.current.getApp("language", SYSTEM_LANGUAGE);
      applyLanguagePreference(savedLanguage, nativeLocales);
      setSettingsReady(true);
      let savedSession;
      try {
        savedSession = await loadSavedAuthSession(authStorageRef.current);
      } catch (error) {
        if (cancelled) return;
        setSecureSessionError(error);
        setAuthState(isSecureSessionReadError(error) ? "secure-session-read-error" : "network-error");
        return;
      }
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
          const cleared = await clearSavedSessionOrShowError(savedSession);
          if (cleared) setSignInError("");
          return;
        }
        setBuyerSession(savedSession);
        setStartupError(error);
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
    } catch (error) {
      if (isAuthInvalidError(error)) {
        await clearSavedSessionOrShowError(buyerSession);
        return;
      }
      if (startup) {
        setStartupError(error);
        setAuthState("network-error");
      } else {
        setEntitlementError(localizedMessage("account.connectionLost"));
        setStatus(uiStatus("account.refreshFailedOffline"));
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
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [buyerSession?.accessToken, signedIn, selectedEntitlementId]);

  const send = useCallback((message) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
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
    setStatus(uiStatus(localToolsStopped ? "run.cancelling" : "error.localTool.stopUnconfirmed"));
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
      setStatus(uiStatus("connection.serviceUnavailableMessageKept"));
      return;
    }
    if (activeRunRef.current) {
      setStatus(uiStatus("run.alreadyRunning"));
      return;
    }

    const content = textFromAppendMessage(appendMessage).trim();
    if (!content) return;

    // Workspace and permission changes are pending Desktop preferences until a
    // new turn starts. Tool calls within a turn always use this stable snapshot.
    const accessSnapshot = createTurnAccessSnapshot(workspaceGrant?.grant_id, workspace, permissionMode);
    workspaceRef.current = accessSnapshot.displayPath;
    workspaceGrantRef.current = workspaceGrant;
    permissionRef.current = accessSnapshot.permissionMode;

    const runId = `run_${Date.now()}`;
    const assistantId = `${runId}_assistant`;
    const startedAt = Date.now();
    activeRunRef.current = {
      runId,
      assistantId,
      text: "",
      startedAt,
      accessSnapshot,
      timing: { questionSentAt: startedAt }
    };
    setProfileSetting("active_run", {
      runId,
      assistantId,
      startedAt,
      conversationId,
      accessSnapshot,
      timing: { questionSentAt: startedAt }
    });
    setMessages((current) => [
      ...current,
      makeUserMessage(`${runId}_user`, content, startedAt),
      makeAssistantPlaceholder(assistantId, runId, startedAt)
    ]);
    setRunning(true);
    setStatus(uiStatus("run.running"));

    send({
      type: "client.message",
      run_id: runId,
      conversation_id: conversationId.trim() || "desktop-chat",
      message: {
        role: "user",
        content
      }
    });
  }, [buyerProfile.id, connected, conversationId, permissionMode, send, workspace, workspaceGrant]);

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    isLoading: statusKey(status) === "connection.loadingHistory",
    isSendDisabled: !connected || running,
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

  useEffect(() => {
    if (!settingsReady || !signedIn || !buyerSession?.profile?.id) return;
    let cancelled = false;
    const profileId = buyerSession.profile.id;
    const savedWorkspaceGrant = normalizeWorkspaceGrant(getProfileSetting("workspace_grant", null));
    const legacySavedWorkspace = getProfileSetting("workspace_root", "");
    const savedConversationId = getConversationId(
      buyerProfile.id,
      selectedEntitlementId,
      `conversation_${buyerProfile.id}_${selectedEntitlementId || "desktop"}`
    );
    const savedRun = parseStoredJson(getProfileSetting("active_run", null));
    const savedPermission = getProfileSetting("permission_mode");
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
    setWorkspaceGranted(false);
    setConversationId(savedConversationId);
    permissionRef.current = nextPermission;
    setPermissionMode(nextPermission);
    if (savedRun) {
      activeRunRef.current = savedRun;
      setInterruptedRun(savedRun);
      setStatus(uiStatus("run.pausedRestoring"));
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
          if (!cancelled) setStatus(uiStatus("workspace.choosePreviousRetryLegacyClear"));
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
          setProfileSetting("workspace_grant", restored.grant, profileId);
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
            settingsStoreRef.current.clearProfileKey(profileId, "workspace_grant"),
            invokeTauri("revoke_workspace_grant", { workspaceGrantId: restored.staleGrant.grant_id })
          ]);
          if (!cancelled) setStatus(uiStatus(restored.statusKey ?? "workspace.status.stale"));
        } catch {
          if (!cancelled) setStatus(uiStatus("workspace.stalePathClearRetry", {
            statusKey: restored.statusKey ?? "workspace.status.stale"
          }));
        }
      } else if (!cancelled && !savedRun) {
        setStatus(uiStatus(legacySavedWorkspace
          ? legacyClearFailed
            ? "workspace.choosePreviousRetryLegacyClear"
            : "workspace.choosePreviousMacAccess"
          : restored.statusKey ?? "workspace.status.chooseFolder"));
      }
    }
    void restoreWorkspace();
    return () => { cancelled = true; };
  }, [buyerProfile.id, buyerSession?.profile?.id, selectedEntitlementId, settingsReady, signedIn]);

  useEffect(() => () => {
    intentionalDisconnectRef.current = true;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    socketRef.current?.close();
    void cancelPendingLocalTools("transport_failure");
  }, []);

  useEffect(() => {
    if (!signedIn || !workspaceGranted || !workspaceGrant?.grant_id || !selectedEntitlementId) return;
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
  }, [connected, conversationId, creatorAgentEntitlements, selectedEntitlementId, signedIn, workspaceGrant, workspaceGranted]);

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
    setStatus(uiStatus("connection.restoring"));
    void connectRuntime({ ...retryConnection, preserveMessages: true });
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
    if (!targetServerUrl.trim() || !targetWorkspaceGrant?.grant_id || !buyerSession?.accessToken || !targetEntitlementId) {
      setStatus(uiStatus("workspace.chooseBeforeConnection"));
      return;
    }

    const requestToken = ++connectionTokenRef.current;
    connectingRef.current = true;
    intentionalDisconnectRef.current = false;
    connectionConfigRef.current = {
      serverUrl: targetServerUrl.trim(),
      workspaceGrant: targetWorkspaceGrant,
      conversationId: targetConversationId.trim() || `conversation_${buyerProfile.id}_${targetEntitlementId}`,
      entitlementId: targetEntitlementId,
      ...(targetAgentId ? { agentId: targetAgentId } : {}),
      ...(targetCreatorId ? { creatorId: targetCreatorId } : {})
    };
    setConversationIdForEntitlement(
      buyerProfile.id,
      targetEntitlementId,
      targetConversationId.trim() || `conversation_${buyerProfile.id}_${targetEntitlementId}`
    );

    let normalizedWorkspaceGrant;
    try {
      normalizedWorkspaceGrant = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
        workspaceGrantId: targetWorkspaceGrant.grant_id
      }));
      if (!normalizedWorkspaceGrant) throw localizedError("error.workspace.invalidGrantValidation");
      setWorkspace(normalizedWorkspaceGrant.display_path);
      workspaceRef.current = normalizedWorkspaceGrant.display_path;
      workspaceGrantRef.current = normalizedWorkspaceGrant;
      setWorkspaceGrant(normalizedWorkspaceGrant);
      connectionConfigRef.current.workspaceGrant = normalizedWorkspaceGrant;
      setProfileSetting("workspace_grant", normalizedWorkspaceGrant);
      setStatus(uiStatus("connection.loadingHistory"));
      const activeConversationId = targetConversationId.trim() || `conversation_${buyerProfile.id}_${targetEntitlementId}`;
      const history = await loadConversationHistory(
        targetServerUrl.trim(),
        activeConversationId,
        targetEntitlementId,
        buyerSession.accessToken,
        { agentId: targetAgentId, creatorId: targetCreatorId }
      );
      if (!connection.preserveMessages || messages.length === 0) {
        setMessages(history.map((message, index) => historyMessageToThreadMessage(
          message,
          index,
          translatorRef.current
        )));
      }
      setStatus(uiStatus("connection.connecting"));
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
          setStatus(uiStatus("workspace.accessUnavailable"));
          void Promise.allSettled([
            settingsStoreRef.current.clearProfileKey(buyerProfile.id, "workspace_grant"),
            invokeTauri("revoke_workspace_grant", { workspaceGrantId: targetWorkspaceGrant.grant_id })
          ]);
        } else {
          const displayError = isWorkspaceGrantError(error)
            ? localizedWorkspaceCommandError(error)
            : error;
          setStatus(uiStatus("connection.unavailableWithError", {
            errorValue: displayError
          }));
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
      void handleRuntimeMessage(JSON.parse(event.data));
    });
    socket.addEventListener("error", () => {
      setStatus(uiStatus("connection.problemWorkKept"));
      void cancelPendingLocalTools("transport_failure").then((stopped) => {
        if (!stopped) setStatus(uiStatus("error.localTool.stopUnconfirmed"));
      });
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      rejectPendingApprovals();
      void cancelPendingLocalTools("transport_failure").then((stopped) => {
        if (!stopped) setStatus(uiStatus("error.localTool.stopUnconfirmed"));
      });
      socketRef.current = null;
      connectedRef.current = false;
      setConnected(false);
      setRunning(false);
      if (activeRunRef.current) {
        setInterruptedRun(activeRunRef.current);
      }
      if (!intentionalDisconnectRef.current) {
        setStatus(uiStatus("connection.lostRestoringSession"));
        scheduleRuntimeReconnect();
      } else {
        setStatus(uiStatus(activeRunRef.current ? "run.pausedWorkKept" : "connection.offline"));
      }
    });
  }

  function disconnectRuntime() {
    intentionalDisconnectRef.current = true;
    connectionTokenRef.current += 1;
    connectingRef.current = false;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    rejectPendingApprovals();
    void cancelPendingLocalTools("transport_failure").then((stopped) => {
      if (!stopped) setStatus(uiStatus("error.localTool.stopUnconfirmed"));
    });
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    connectedRef.current = false;
    setConnected(false);
    setRunning(false);
    setStatus(uiStatus(activeRunRef.current ? "run.pausedWorkKept" : "connection.offline"));
  }

  async function handleRuntimeMessage(message) {
    if (message.type === "session.ready") {
      setCreatorAgent(creatorAgentFromSession(message));
      connectedRef.current = true;
      reconnectAttemptRef.current = 0;
      setConnected(true);
      setStatus(uiStatus("connection.ready"));
      return;
    }

    if (message.type === "assistant.delta") {
      if (message.delta.kind === "text") {
        const projection = projectApprovedRuntimeStream(activeRunRef.current, message);
        if (!projection) return;
        activeRunRef.current = projection.activeRun;
        appendAssistantText(projection.assistantId, projection.content);
      } else {
        const runtimeStatus = runtimeAssistantStatusDescriptor(message.delta.content);
        setStatus(uiStatus(runtimeStatus.key, runtimeStatus.values));
        updateAssistantMetadataForRun(message.run_id, {
          latestStatus: message.delta.content
        });
      }
      return;
    }

    if (message.type === "turn.state") {
      const runtimeStatus = runtimeTurnStatusDescriptor(message.status);
      setStatus(uiStatus(runtimeStatus.key, runtimeStatus.values));
      updateAssistantMetadataForRun(message.run_id, {
        runtimeStatus: message.status
      });
      return;
    }

    if (message.type === "approval.request" || message.type === "approval.result") {
      upsertToolEvent(toolEventFromApproval(message));
      setStatus(uiStatus(message.type === "approval.request"
        ? "approval.requested"
        : "approval.result", {
        name: message.name,
        statusKey: approvalStatusKey(message.status)
      }));
      return;
    }

    if (message.type === "tool_call.delta") {
      upsertToolEvent(message);
      return;
    }

    if (message.type === "tool_call.request") {
      upsertToolEvent({
        ...message,
        locality: "client",
        status: "requested"
      });
      await handleToolRequest(message);
      return;
    }

    if (message.type === "skill.activated" || message.type === "skill.invoked") {
      upsertSkillEvent(message);
      setStatus(uiStatus(message.status === "activated"
        ? "creatorMethod.status.ready"
        : "creatorMethod.status.applied", { name: message.name, method: message.name }));
      return;
    }

    if (message.type === "skill.run") {
      upsertSkillRun(message);
      setStatus(skillRunStatus(message));
      return;
    }

    if (message.type === "session.compacted") {
      setStatus(uiStatus("conversation.optimized"));
      return;
    }

    if (message.type === "turn.completed") {
      const localToolsStopped = await cancelPendingLocalTools("turn_completed", message.run_id);
      const projection = projectApprovedRuntimeStream(activeRunRef.current, message);
      if (projection) {
        activeRunRef.current = projection.activeRun;
        if (projection.finishReason === "content_filter") {
          finishAssistant(
            projection.assistantId,
            translatorRef.current("run.outputBlocked"),
            "content_filter",
            { key: "run.outputBlocked" }
          );
        } else if (projection.textKey) {
          finishAssistant(
            projection.assistantId,
            translatorRef.current(projection.textKey),
            "completed",
            { key: projection.textKey }
          );
        } else {
          finishAssistant(projection.assistantId, projection.text, "completed");
        }
        saveAssistantTiming(
          projection.assistantId,
          projection.runId,
          projection.activeRun.timing,
          projection.completedAt
        );
      }
      activeRunRef.current = null;
      setProfileSetting("active_run", undefined);
      setInterruptedRun(null);
      setRunning(false);
      setStatus(uiStatus(localToolsStopped ? "run.completed" : "error.localTool.stopUnconfirmed"));
      return;
    }

    if (message.type === "turn.failed") {
      const localToolsStopped = await cancelPendingLocalTools("turn_failed", message.run_id);
      const activeRun = activeRunRef.current;
      const failureValues = {
        error: message.error?.message || translatorRef.current("error.unknown")
      };
      const text = translatorRef.current("run.failedWithError", failureValues);
      if (activeRun) {
        finishAssistant(activeRun.assistantId, text, "failed", {
          key: "run.failedWithError",
          values: failureValues
        });
      } else {
        setMessages((current) => [
          ...current,
          makeAssistantMessage(`error_${Date.now()}`, text, {
            status: "failed",
            custom: {
              uiMessageKey: "run.failedWithError",
              uiMessageValues: failureValues
            }
          })
        ]);
      }
      activeRunRef.current = null;
      setProfileSetting("active_run", undefined);
      setInterruptedRun(null);
      setRunning(false);
      setStatus(uiStatus(localToolsStopped ? "run.failed" : "error.localTool.stopUnconfirmed"));
    }
  }

  async function handleToolRequest(message) {
    const accessSnapshot = accessSnapshotForToolCall(activeRunRef.current, {
      workspaceGrantId: workspaceGrantRef.current?.grant_id,
      displayPath: workspaceRef.current,
      permissionMode: permissionRef.current
    });
    const isChange = CHANGE_TOOLS.includes(message.name);
    let authorizedByDesktop = accessSnapshot.permissionMode === PERMISSION_POLICIES.ALLOW_CHANGES && isChange;
    if (!authorizedByDesktop && shouldRequestDesktopApproval(message, accessSnapshot.permissionMode)) {
      const approved = await requestToolApproval(message);
      if (!approved) {
        const denialError = {
          code: "approval_denied",
          message: createTranslator(DEFAULT_LANGUAGE)("approval.toolRejectedByUser", { name: message.name }),
          i18nKey: "approval.toolRejectedByUser",
          i18nValues: { name: message.name }
        };
        upsertToolEvent({
          ...message,
          locality: "client",
          status: "failed",
          error: denialError
        });
        send({
          type: "tool_call.result",
          run_id: message.run_id,
          tool_call_id: message.tool_call_id,
          status: "error",
          error: protocolToolError(denialError)
        });
        return;
      }
      authorizedByDesktop = true;
    }

    try {
      const result = await invokeLocalToolCall(message, authorizedByDesktop, accessSnapshot.workspaceGrantId);
      send(result);
    } catch (error) {
      const localError = {
        code: ["local_tool_timeout", "local_tool_cancelled", "local_tool_cancel_failed"].includes(error?.code)
          ? error.code
          : "local_runner_error",
        message: errorMessage(error),
        ...(error?.i18nKey ? {
          i18nKey: error.i18nKey,
          i18nValues: error.i18nValues ?? {}
        } : {})
      };
      if (localError.code === "local_tool_cancel_failed") {
        setStatus(uiStatus("error.localTool.stopUnconfirmed"));
      } else if (localError.code === "local_tool_timeout") {
        setStatus(uiStatus("run.localToolTimeoutStopped"));
      }
      upsertToolEvent({
        ...message,
        locality: "client",
        status: "failed",
        error: localError
      });
      send({
        type: "tool_call.result",
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        status: "error",
        error: protocolToolError(localError)
      });
    }
  }

  function invokeLocalToolCall(message, authorizedByDesktop, workspaceGrantId) {
    const request = authorizedByDesktop ? { ...message, approval: "approved_by_user" } : message;
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
              const missing = localizedError("error.localToolJobMissing", { id: request.tool_call_id });
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

      invokeTauri("execute_tool_call", {
        workspaceGrantId,
        request
      }).then(poll).catch((error) => finish(reject, error));
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
      if (!workspaceDraftGrant?.grant_id) throw localizedError("workspace.chooseBeforeStart");
      const normalized = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
        workspaceGrantId: workspaceDraftGrant.grant_id
      }));
      if (!normalized) throw localizedError("error.workspace.invalidGrantValidation");
      setWorkspace(normalized.display_path);
      workspaceRef.current = normalized.display_path;
      workspaceGrantRef.current = normalized;
      setWorkspaceGrant(normalized);
      setWorkspaceDraft(normalized.display_path);
      setWorkspaceDraftGrant(normalized);
      setWorkspaceGranted(true);
      setProfileSetting("workspace_grant", normalized);
      setStatus(uiStatus("workspace.accessGranted"));
      await connectRuntime({ workspaceGrant: normalized, conversationId, preserveMessages: false });
    } catch (error) {
      setStatus(errorStatus(localizedWorkspaceCommandError(error)));
    }
  }

  async function chooseWorkspace({ activate = workspaceGranted } = {}) {
    try {
      const selected = await invokeTauri("pick_workspace_folder", {
        title: translatorRef.current("workspace.chooseFolder")
      });
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
      setStatus(errorStatus(localizedWorkspaceCommandError(error)));
    }
  }

  async function switchWorkspace(nextWorkspaceGrant) {
    const candidate = normalizeWorkspaceGrant(nextWorkspaceGrant);
    if (!candidate) throw localizedError("workspace.pickerGrantInvalid");
    const normalized = normalizeWorkspaceGrant(await invokeTauri("ensure_workspace", {
      workspaceGrantId: candidate.grant_id
    }));
    if (!normalized) throw localizedError("error.workspace.invalidGrantValidation");
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
    setProfileSetting("workspace_grant", normalized);
    setStatus(uiStatus("workspace.updatedNextTurn"));
  }

  function updatePermissionMode(nextMode) {
    if (!PERMISSION_OPTIONS.some((mode) => mode.value === nextMode)) return;
    setPermissionMode(nextMode);
    setProfileSetting("permission_mode", nextMode);
    setStatus(uiStatus("permission.updatedNextTurn", {
      permissionKey: nextMode === PERMISSION_POLICIES.ALLOW_CHANGES
        ? "permission.allowChanges"
        : "permission.askBeforeChanges"
    }));
  }

  function startNewConversation() {
    const guard = canStartConversation({ activeRun: activeRunRef.current, connected });
    if (!guard.allowed) {
      setStatus(activeRunRef.current
        ? uiStatus("conversation.stopBeforeNew")
        : uiStatus("conversation.connectBeforeNew"));
      return;
    }
    const nextId = `conversation_${buyerProfile.id}_${Date.now()}`;
    setConversationId(nextId);
    setMessages([]);
    setConversationIdForEntitlement(buyerProfile.id, selectedEntitlementId, nextId);
    setStatus(uiStatus("conversation.newReady"));
  }

  function clearInterruptedRun() {
    activeRunRef.current = null;
    setInterruptedRun(null);
    setProfileSetting("active_run", undefined);
    setStatus(uiStatus("conversation.pausedClosed"));
  }

  async function signIn(credentials) {
    setSignInStatus("loading");
    setSignInError("");
    try {
      if (!credentials) throw localizedError("auth.emailAndPasswordRequired");
      const result = await signInDesktopSession(credentials, DEFAULT_AUTH_URL, authStorageRef.current);
      await applyResolvedDesktopSession(result);
    } catch (error) {
      const persistedSession = persistedDesktopSessionFromError(error);
      if (persistedSession) {
        if (isAuthInvalidError(error)) {
          const cleared = await clearSavedSessionOrShowError(persistedSession);
          if (cleared) setSignInError(localizedMessage("auth.verifyNewSessionFailed"));
          return;
        }
        setBuyerSession(persistedSession);
        setStartupError(error);
        setSignInStatus("ready");
        setAuthState("network-error");
        return;
      }
      setSignInStatus("error");
      setSignInError(isNetworkError(error)
        ? localizedMessage("error.network.unreachable")
        : error);
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
    const cleared = await clearSavedSessionOrShowError(buyerSession, localClear);
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
      setEntitlementError(error);
    }
  }

  function selectCreatorAgent(entitlement) {
    const sameEntitlement = entitlement.entitlement_id === selectedEntitlementId;
    if (sameEntitlement && runtimeBindingMatches(
      connectionConfigRef.current,
      runtimeBindingForEntitlement(entitlement)
    )) return;
    disconnectRuntime();
    setSelectedEntitlementId(entitlement.entitlement_id);
    setCreatorAgent(creatorAgentFromEntitlement(entitlement));
    setProfileSetting("last_selected_entitlement_id", entitlement.entitlement_id);
    if (!sameEntitlement) setMessages([]);
    const fallback = `conversation_${buyerProfile.id}_${entitlement.creator_id || "creator"}_${entitlement.agent_id || entitlement.product.id}`;
    setConversationId(getConversationId(buyerProfile.id, entitlement.entitlement_id, fallback));
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
      const parts = assistantParts(message);
      const textIndex = parts.findLastIndex((part) => part.type === "text");
      if (textIndex >= 0) {
        parts[textIndex] = { ...parts[textIndex], text: `${parts[textIndex].text}${delta}` };
      } else {
        parts.push({ type: "text", text: delta });
      }
      return {
        ...message,
        content: parts,
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

  function finishAssistant(id, text, statusValue, uiMessage = null) {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) return message;
      const parts = statusValue === "content_filter"
        ? []
        : assistantParts(message).filter((part) => part.type !== "text");
      if (text) {
        parts.push({ type: "text", text });
      }
      const custom = {
        ...(message.metadata?.custom ?? {}),
        status: statusValue,
        completedAt: Date.now(),
        ...(uiMessage ? {
          uiMessageKey: uiMessage.key,
          uiMessageValues: uiMessage.values ?? {}
        } : {})
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
      const withoutExisting = parts.filter((part) => !(
        part.type === "tool-call" && part.toolCallId === event.tool_call_id
      ));
      const firstTextIndex = withoutExisting.findIndex((part) => part.type === "text");
      if (firstTextIndex >= 0) {
        withoutExisting.splice(firstTextIndex, 0, nextPart);
      } else {
        withoutExisting.push(nextPart);
      }
      return {
        ...message,
        content: withoutExisting,
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
      const withoutExisting = parts.filter((part) => !isSameSkillActivityPart(part, nextPart));
      const firstTextIndex = withoutExisting.findIndex((part) => part.type === "text");
      if (firstTextIndex >= 0) {
        withoutExisting.splice(firstTextIndex, 0, nextPart);
      } else {
        withoutExisting.push(nextPart);
      }
      return {
        ...message,
        content: withoutExisting,
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
      const withoutExisting = parts.filter((part) => !isSameSkillRunActivityPart(part, nextPart));
      const firstTextIndex = withoutExisting.findIndex((part) => part.type === "text");
      if (firstTextIndex >= 0) {
        withoutExisting.splice(firstTextIndex, 0, nextPart);
      } else {
        withoutExisting.push(nextPart);
      }
      return {
        ...message,
        content: withoutExisting,
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

  function renderLocalizedApp(content) {
    return (
      <I18nContext.Provider value={{ language, languagePreference, systemLanguage, t }}>
        {content}
        <LanguageSettings
          onLanguageChange={changeLanguagePreference}
        />
      </I18nContext.Provider>
    );
  }

  if (!settingsReady) return <LocaleBootstrapScreen />;
  if (authState === "loading") return renderLocalizedApp(<LaunchScreen />);
  if (authState === "secure-session-error") {
    return renderLocalizedApp(
      <SecureSessionErrorScreen message={secureSessionError} onRetry={() => void retrySecureSessionClear()} />
    );
  }
  if (authState === "secure-session-read-error") {
    return renderLocalizedApp(
      <SignInScreen
        error={signInError || secureSessionError}
        onRetrySavedSession={() => { setAuthState("loading"); setBootstrapAttempt((value) => value + 1); }}
        onSignIn={(credentials) => void signIn(credentials)}
        status={signInStatus}
      />
    );
  }
  if (authState === "network-error") {
    return renderLocalizedApp(
      <NetworkErrorScreen
        message={startupError}
        onRetry={() => { setAuthState("loading"); setBootstrapAttempt((value) => value + 1); }}
        onSignOut={canUseAnotherAccountFromNetworkError(buyerSession) ? () => void signOut() : null}
      />
    );
  }
  if (authState === "unsupported-role") {
    return renderLocalizedApp(<UnsupportedRoleScreen profile={buyerProfile} onSignOut={() => void signOut()} />);
  }
  if (!signedIn) {
    return renderLocalizedApp(
      <SignInScreen onSignIn={(credentials) => void signIn(credentials)} status={signInStatus} error={signInError} />
    );
  }
  if (creatorAgentEntitlements.length === 0) {
    return renderLocalizedApp(
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

  const displayedCreatorAgent = localizedCreatorAgent(creatorAgent, t);
  const statusText = localizeStatus(status, t);
  const connectionBusy = [
    "connection.loadingHistory",
    "connection.connecting",
    "connection.restoring"
  ].includes(statusKey(status));

  return renderLocalizedApp(
    <main className="app-shell">
      <aside className="control-panel">
        <div className="brand">
          <img className="hatch-mark" src={hatchMarkUrl} alt="" />
          <div>
            <h1 className="hatch-wordmark">{t("app.name")}.</h1>
            <p>{t("app.tagline")}</p>
          </div>
        </div>

        <section className="profile-card">
          <span className="avatar">{profileInitials(buyerProfile, t)}</span>
          <div><strong>{buyerProfile.name || t("app.defaultUserName")}</strong><span>{t("common.signedIn")}</span></div>
          <button className="profile-sign-out" type="button" onClick={() => void signOut()}>{t("common.signOut")}</button>
        </section>

        <section className="side-section agent-nav">
          <h2>{t("sidebar.yourAgents")}</h2>
          {creatorAgentEntitlements.map((entitlement) => {
            const agent = creatorAgentFromEntitlement(entitlement);
            return (
              <button
                className={`agent-nav-item ${entitlement.entitlement_id === selectedEntitlementId ? "active" : ""}`}
                key={entitlement.entitlement_id}
                type="button"
                onClick={() => selectCreatorAgent(entitlement)}
              >
                <span className="creator-avatar">
                  {agent.creatorInitials || t("app.defaultCreatorName").slice(0, 1).toUpperCase()}
                </span>
                <span><strong>{agent.name}</strong><small>{t("common.byCreator", { creator: agent.creator })}</small></span>
              </button>
            );
          })}
        </section>
        <button className="secondary new-conversation" type="button" onClick={startNewConversation}>
          {t("conversation.new")}
        </button>
      </aside>

      <section className="chat-shell">
        <header className="chat-header">
          <div className="header-agent">
            <span className="label">{t("common.agent")}</span>
            <strong>{displayedCreatorAgent.name} · {displayedCreatorAgent.creator}</strong>
            {settingsMigrationNotice ? (
              <small className="settings-migration-notice" role="status">
                {localizeUserMessage(settingsMigrationNotice, t)}
              </small>
            ) : null}
          </div>
          {workspaceGranted && !connected ? (
            <div className="connection-recovery" role="status" aria-live="polite">
              <span>
                <strong>{t("connection.offline")}</strong>
                <small>{statusKey(status) === "connection.offline"
                  ? t("connection.conversationStays")
                  : statusText}</small>
              </span>
              <button
                className="secondary compact"
                type="button"
                onClick={retryRuntimeConnection}
                disabled={connectionBusy}
              >
                {connectionBusy ? t("connection.connecting") : t("common.retry")}
              </button>
            </div>
          ) : null}
        </header>

        {!workspaceGranted ? (
          <WorkspaceOnboarding
            creatorName={displayedCreatorAgent.creator}
            draft={workspaceDraft}
            onChoose={() => void chooseWorkspace({ activate: false })}
            onGrant={() => void grantWorkspace()}
            status={status}
          />
        ) : (
        <ApprovalContext.Provider value={{ requests: approvalRequests, resolveToolApproval }}>
          <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root className="thread-root">
              <ThreadPrimitive.Viewport className="thread-viewport">
                <ThreadPrimitive.Empty>
                  <EmptyThread connected={connected} creatorAgent={displayedCreatorAgent} />
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages components={{ Message: HatchMessage }} />
              </ThreadPrimitive.Viewport>
              <ThreadPrimitive.ViewportFooter className="composer-footer">
                <ComposerPrimitive.Root className="composer">
                  <ComposerPrimitive.Input
                    className="composer-input"
                    onBlur={resetImeComposition}
                    onCompositionEnd={endImeComposition}
                    onCompositionStart={startImeComposition}
                    onKeyDownCapture={stopImeEnterSubmit}
                    placeholder={connected
                      ? t("conversation.messageAgent", { name: displayedCreatorAgent.name })
                      : t("connection.restoring")}
                    submitMode="enter"
                    rows={1}
                  />
                  <div className="composer-actions">
                    <div className="composer-settings">
                      <button
                        aria-label={t("accessibility.chooseWorkspaceFolder")}
                        className="composer-control workspace-composer-control"
                        title={workspace || t("workspace.chooseFolder")}
                        type="button"
                        onClick={() => void chooseWorkspace()}
                      >
                        <WorkspaceIcon />
                        <span className="composer-control-label">
                          {workspaceGranted ? workspaceGrantLabel(workspace) : t("workspace.chooseWorkspace")}
                        </span>
                        <span className="composer-control-caret" aria-hidden="true">⌄</span>
                      </button>
                      <label
                        className="composer-control permission-composer-control"
                        title={localizedPermissionPolicyDetail(permissionMode, t)}
                      >
                        <ShieldIcon />
                        <select
                          aria-label={t("accessibility.workspacePermissions")}
                          value={permissionMode}
                          onChange={(event) => updatePermissionMode(event.target.value)}
                        >
                          {PERMISSION_OPTIONS.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                              {localizedPermissionPolicyLabel(mode.value, t)}
                            </option>
                          ))}
                        </select>
                        <span className="composer-control-caret" aria-hidden="true">⌄</span>
                      </label>
                    </div>
                    {running ? (
                      <button
                        aria-label={t("accessibility.stopStreaming")}
                        className="send-button stop-button"
                        type="button"
                        onClick={() => void cancelRun()}
                      >
                        {t("common.stop")}
                      </button>
                    ) : (
                      <ComposerPrimitive.Send className="send-button">{t("common.send")}</ComposerPrimitive.Send>
                    )}
                  </div>
                </ComposerPrimitive.Root>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Root>
          </AssistantRuntimeProvider>
        </ApprovalContext.Provider>
        )}
        {interruptedRun ? (
          <div className="recovery-banner" role="alert">
            <div>
              <strong>{t("conversation.taskSafeTitle")}</strong>
              <span>{t("conversation.taskSafeBody")}</span>
            </div>
            <button className="secondary compact" type="button" onClick={clearInterruptedRun}>
              {t("conversation.closeTask")}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

async function loadConversationHistory(serverUrl, conversationId, entitlementId, accessToken, binding = {}) {
  const response = await fetch(historyUrlForRuntime(serverUrl, conversationId, entitlementId, binding), {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw localizedError("conversation.reloadFailed");
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

function historyMessageToThreadMessage(message, index, t = createTranslator(DEFAULT_LANGUAGE)) {
  const id = `history_${message.run_id ?? "message"}_${index}`;
  const createdAt = messageCreatedAt(message.timestamp);
  if (message.role === "user") {
    return makeUserMessage(id, message.content ?? "", createdAt);
  }
  const filtered = message.finish_reason === "content_filter";
  const activityParts = filtered ? [] : historyActivityParts(message);
  const text = filtered ? t("run.outputBlocked") : message.content ?? "";
  const lastTool = [...activityParts].reverse().find((part) => part.type === "tool-call");
  const lastSkill = [...activityParts].reverse().find(isSkillActivityPart);
  return makeAssistantMessage(id, text, {
    status: filtered ? "content_filter" : "completed",
    createdAt,
    content: [
      ...activityParts,
      ...(text ? [{ type: "text", text }] : [])
    ],
    custom: {
      runId: message.run_id,
      hydrated: true,
      ...(filtered ? {
        outputGuardBlocked: true,
        uiMessageKey: "run.outputBlocked",
        uiMessageValues: {}
      } : {}),
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

function messageCreatedAt(timestamp) {
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function historyActivityParts(message) {
  const timeline = [
    ...(Array.isArray(message.skill_events)
      ? message.skill_events.map((event) => ({
          type: "skill",
          timestamp: event.timestamp ?? message.timestamp,
          event
        }))
      : []),
    ...(Array.isArray(message.skill_runs)
      ? message.skill_runs.map((event) => ({
          type: "skill-run",
          timestamp: event.timestamp ?? message.timestamp,
          event
        }))
      : []),
    ...(Array.isArray(message.tool_calls)
      ? message.tool_calls.map((event) => ({
          type: "tool",
          timestamp: event.first_timestamp ?? event.timestamp ?? message.timestamp,
          event
        }))
      : [])
  ];
  return timeline
    .sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
    .map((entry) => entry.type === "skill"
      ? skillActivityPartFromEvent(entry.event)
      : entry.type === "skill-run"
        ? skillRunActivityPartFromEvent(entry.event)
        : historyToolCallToPart(entry.event));
}

function makeUserMessage(id, text, createdAt = Date.now()) {
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: new Date(createdAt),
    metadata: {
      custom: {
        source: "hatch"
      }
    }
  };
}

function makeAssistantMessage(id, text, options = {}) {
  return {
    id,
    role: "assistant",
    content: options.content ?? (text ? [{ type: "text", text }] : []),
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
    content: [],
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
      ? message.reason
        ? { code: "approval_denied", message: message.reason }
        : {
            code: "approval_denied",
            message: englishMessage("approval.toolDenied"),
            i18nKey: "approval.toolDenied"
          }
      : undefined
  };
}

function LanguageSettings({ onLanguageChange }) {
  const { languagePreference, systemLanguage, t } = useI18n();
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    const returnFocus = document.activeElement;
    const focusableSelector = "button:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const focusables = () => [...(dialog?.querySelectorAll(focusableSelector) ?? [])];
    (dialog?.querySelector("select:not([disabled])") ?? focusables()[0] ?? dialog)?.focus();

    const keepFocusInDialog = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusables();
      if (elements.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const focusOutside = !dialog?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusOutside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keepFocusInDialog);
    return () => {
      document.removeEventListener("keydown", keepFocusInDialog);
      const target = returnFocus?.isConnected ? returnFocus : triggerRef.current;
      target?.focus?.();
    };
  }, [open]);

  async function updateLanguage(event) {
    const nextPreference = event.target.value;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      await onLanguageChange(nextPreference);
      setSaved(true);
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        aria-label={t("settings.open")}
        className="settings-trigger"
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
      >
        <SettingsIcon />
        <span>{t("settings.title")}</span>
      </button>
      {open ? (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            aria-labelledby="hatch-settings-title"
            aria-modal="true"
            className="settings-dialog"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <h2 id="hatch-settings-title">{t("settings.title")}</h2>
              <button
                aria-label={t("settings.close")}
                className="settings-close"
                type="button"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>
            <label className="settings-language-field">
              <span>{t("settings.language.label")}</span>
              <select
                aria-label={t("accessibility.language")}
                disabled={saving}
                value={languagePreference}
                onChange={(event) => void updateLanguage(event)}
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value === SYSTEM_LANGUAGE
                      ? `${t(option.labelKey)} (${languageNativeName(systemLanguage)})`
                      : option.nativeLabel}
                  </option>
                ))}
              </select>
            </label>
            <p>{t("settings.language.description")}</p>
            {saved ? <small className="settings-save-status" role="status">{t("settings.language.saved")}</small> : null}
            {saveError ? (
              <small className="settings-save-error" role="alert">
                {t("settings.language.saveFailed")}
              </small>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M8.9 2.3h2.2l.4 1.7 1.3.6 1.5-.8 1.5 1.5-.8 1.5.6 1.3 1.7.4v2.2l-1.7.4-.6 1.3.8 1.5-1.5 1.5-1.5-.8-1.3.6-.4 1.7H8.9l-.4-1.7-1.3-.6-1.5.8-1.5-1.5.8-1.5-.6-1.3-1.7-.4V8.5l1.7-.4L5 6.8l-.8-1.5 1.5-1.5 1.5.8L8.5 4l.4-1.7Z" />
      <circle cx="10" cy="9.6" r="2.3" />
    </svg>
  );
}

function EmptyThread({ connected, creatorAgent }) {
  const { t } = useI18n();
  return (
    <div className="empty-thread">
      <span className="creator-avatar large">{creatorAgent.creatorInitials}</span>
      <span className="empty-kicker">{creatorAgent.creator}</span>
      <h2>{connected ? t("conversation.emptyTitle") : t("conversation.offlineTitle")}</h2>
      <p>
        {connected
          ? creatorAgent.description
          : t("conversation.offlineBody")}
      </p>
      {creatorAgent.boundary ? <small className="boundary-copy">{creatorAgent.boundary}</small> : null}
    </div>
  );
}

function WorkspaceIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M2.75 5.75h5l1.5 1.75h8v7.25a1.5 1.5 0 0 1-1.5 1.5h-13V5.75Z" />
      <path d="M2.75 5.75v-.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 2" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M10 2.5 16 5v4.75c0 3.7-2.5 6.3-6 7.75-3.5-1.45-6-4.05-6-7.75V5l6-2.5Z" />
      <path d="M10 6.25v4" />
      <path d="M10 13.5h.01" />
    </svg>
  );
}

function WorkspaceOnboarding({ creatorName, draft, onChoose, onGrant, status }) {
  const { t } = useI18n();
  const statusText = localizeStatus(status, t);
  return (
    <div className="workspace-onboarding">
      <section className="workspace-onboarding-card">
        <div className="workspace-onboarding-icon"><WorkspaceIcon /></div>
        <h2>{t("workspace.requiredTitle")}</h2>
        <p>{t("workspace.creatorScope", { creator: creatorName })}</p>

        <button className={`workspace-picker ${draft ? "selected" : ""}`} type="button" onClick={onChoose}>
          <WorkspaceIcon />
          <span className="workspace-picker-copy">
            <strong>{draft ? workspaceGrantLabel(draft) : t("workspace.chooseComputerFolder")}</strong>
          </span>
          <span className="workspace-picker-action">{draft ? t("common.change") : t("common.choose")}</span>
        </button>

        <button className="workspace-grant-button" type="button" onClick={onGrant} disabled={!draft.trim()}>
          {t("common.start")}
        </button>
        {statusText && statusKey(status) !== "connection.offline" ? (
          <small className="workspace-onboarding-status">{statusText}</small>
        ) : null}
      </section>
    </div>
  );
}

function LaunchScreen() {
  const { t } = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">{t("app.name")}.</strong></div>
      <section className="status-card">
        <span className="eyebrow">{t("app.name")}</span>
        <h1>{t("startup.openingWorkspace")}</h1>
        <p>{t("startup.checkingAccount")}</p>
      </section>
    </main>
  );
}

function LocaleBootstrapScreen() {
  return (
    <main aria-busy="true" className="welcome-screen locale-bootstrap-screen">
      <img aria-hidden="true" className="hatch-mark" src={hatchMarkUrl} alt="" />
    </main>
  );
}

function NetworkErrorScreen({ message, onRetry, onSignOut }) {
  const { t } = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">{t("app.name")}.</strong></div>
      <section className="status-card">
        <span className="eyebrow">{t("connection.eyebrow")}</span>
        <h1>{t("connection.cannotReachTitle")}</h1>
        <p>{message ? localizeUserMessage(message, t) : t("connection.checkAndRetry")}</p>
        <small>{t("connection.savedAccessLocal")}</small>
        <button type="button" onClick={onRetry}>{t("common.retry")}</button>
        {onSignOut ? (
          <button className="secondary" type="button" onClick={onSignOut}>
            {t("auth.signOutUseAnother")}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function SecureSessionErrorScreen({ message, onRetry, title, actionLabel }) {
  const { t } = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">{t("app.name")}.</strong></div>
      <section className="status-card">
        <span className="eyebrow">{t("auth.secureSessionEyebrow")}</span>
        <h1>{title ? localizeUserMessage(title, t) : t("auth.signOutFailedTitle")}</h1>
        <p>{localizeUserMessage(message, t)}</p>
        <button type="button" onClick={onRetry}>
          {actionLabel ? localizeUserMessage(actionLabel, t) : t("auth.removeSessionAgain")}
        </button>
      </section>
    </main>
  );
}

function UnsupportedRoleScreen({ profile, onSignOut }) {
  const { t } = useI18n();
  return (
    <main className="welcome-screen status-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">{t("app.name")}.</strong></div>
      <section className="status-card">
        <span className="eyebrow">{t("auth.consumerDesktopEyebrow")}</span>
        <h1>{t("auth.buyerAccountTitle")}</h1>
        <p>{t("error.auth.unsupportedCreatorRole")}</p>
        <small>{t("auth.creatorSignedIn", { name: profile.name || t("app.defaultUserName") })}</small>
        <button type="button" onClick={onSignOut}>{t("common.signOut")}</button>
      </section>
    </main>
  );
}

function EmptyAgentsScreen({ profile, onBrowse, onRefresh, onSignOut, refreshing, error, notice }) {
  const { t } = useI18n();
  return (
    <main className="welcome-screen status-screen empty-agents-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">{t("app.name")}.</strong></div>
      <section className="status-card empty-agents-card">
        <div className="empty-agents-header">
          <span className="avatar">{profileInitials(profile, t)}</span>
          <span><strong>{profile.name || t("app.defaultUserName")}</strong><small>{t("common.signedIn")}</small></span>
          <button className="profile-sign-out" type="button" onClick={onSignOut}>{t("common.signOut")}</button>
        </div>
        <span className="eyebrow">{t("account.yourCreatorAgents")}</span>
        <h1>{t("account.findAgentTitle")}</h1>
        <p>{t("account.readyBrowse")}</p>
        {notice ? <p className="status-inline-notice" role="status">{localizeUserMessage(notice, t)}</p> : null}
        {error ? <p className="status-inline-error" role="status">{localizeUserMessage(error, t)}</p> : null}
        <button type="button" onClick={onBrowse}>{t("account.browseAgents")}</button>
        <button className="secondary status-refresh" type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? t("common.refreshing") : t("common.refresh")}
        </button>
      </section>
    </main>
  );
}

function SignInScreen({ onSignIn, status, error, onRetrySavedSession }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loading = status === "loading";

  function submit(event) {
    event.preventDefault();
    onSignIn({ email, password });
  }

  return (
    <main className="welcome-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">{t("app.name")}.</strong></div>
      <section className="sign-in-card">
        <span className="eyebrow">{t("auth.welcome")}</span>
        <h1>{t("auth.signInTitle")}</h1>
        <p>{t("auth.signInDescription")}</p>
        <form className="sign-in-form" onSubmit={submit}>
          <label className="field">
            <span>{t("auth.email")}</span>
            <input autoCapitalize="none" autoComplete="email" spellCheck="false" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("auth.emailPlaceholder")} disabled={loading} />
          </label>
          <label className="field">
            <span>{t("auth.password")}</span>
            <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("auth.passwordPlaceholder")} disabled={loading} />
          </label>
          <button type="submit" disabled={loading || (!email.trim() || !password.trim())}>
            {loading ? t("auth.signingIn") : t("auth.signIn")}
          </button>
        </form>
        {error ? <small className="sign-in-error" role="alert">{localizeUserMessage(error, t)}</small> : null}
        {onRetrySavedSession ? (
          <button className="secondary" type="button" onClick={onRetrySavedSession}>
            {t("auth.retrySavedSession")}
          </button>
        ) : null}
        <small>{t("auth.sessionStoredNotice")}</small>
      </section>
    </main>
  );
}

function HatchMessage() {
  const role = useMessage((message) => message.role);
  const status = useMessage((message) => message.status);
  const streaming = role === "assistant" && status?.type === "running";
  return (
    <MessagePrimitive.Root className={`chat-message ${role}`}>
      {role === "assistant" ? <AssistantRunHeader /> : null}
      <div className={`message-surface ${role}${streaming ? " streaming" : ""}`}>
        <MessagePrimitive.Parts
          unstable_showEmptyOnNonTextEnd={false}
          components={{
            Text: role === "assistant" ? MarkdownText : PlainText,
            Empty: AssistantEmptyText,
            data: {
              by_name: {
                [SKILL_ACTIVITY_PART]: SkillActivityPart,
                [SKILL_RUN_ACTIVITY_PART]: SkillRunActivityPart
              }
            },
            tools: {
              Fallback: HatchToolCall
            },
            ToolGroup: ToolGroup
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantRunHeader() {
  const { language, t } = useI18n();
  const custom = useMessage((message) => message.metadata?.custom ?? {});
  const status = useMessage((message) => message.status);
  const parts = useMessage((message) => message.content ?? []);
  const [now, setNow] = useState(Date.now());
  const isRunning = status?.type === "running";

  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  if (!custom.runId) return null;

  const startedAt = Number(custom.startedAt ?? Date.now());
  const completedAt = Number(custom.completedAt ?? now);
  const elapsed = formatLocalizedDuration(Math.max(0, completedAt - startedAt), language);
  const toolParts = Array.isArray(parts) ? parts.filter((part) => part.type === "tool-call") : [];
  const activeTool = [...toolParts].reverse().find((part) => !part.result && !part.isError);
  const latestTool = [...toolParts].reverse()[0];
  const failed = status?.type === "incomplete" || custom.status === "failed";
  const filtered = custom.status === "content_filter";
  const summary = filtered
    ? t("run.summary.blocked", { duration: elapsed })
    : failed
    ? t("run.summary.couldNotFinish", { duration: elapsed })
    : isRunning && activeTool
      ? t("run.summary.activeTool", {
          action: toolDisplay(activeTool.toolName, t).running,
          duration: elapsed
        })
      : isRunning
        ? t("run.summary.working", { duration: elapsed })
        : latestTool
          ? t("run.summary.finished", { duration: elapsed })
          : t("run.summary.answered", { duration: elapsed });

  return (
    <>
      <div className="run-summary">
        <span className={`activity-dot ${failed ? "failed" : isRunning ? "running" : "done"}`} />
        <span>{summary}</span>
      </div>
      {import.meta.env.DEV && custom.turnTiming ? (
        <details className="turn-timing">
          <summary>{t("common.timing")}</summary>
          <pre>{JSON.stringify(custom.turnTiming, null, 2)}</pre>
        </details>
      ) : null}
    </>
  );
}

function PlainText({ text }) {
  return <p className="plain-text">{text}</p>;
}

function MarkdownText() {
  return (
    <StreamdownTextPrimitive
      className="markdown-body"
      components={{
        li: MarkdownListItem
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

function AssistantEmptyText() {
  const { t } = useI18n();
  return <span className="assistant-pending">{t("run.thinking")}</span>;
}

function ToolGroup({ children }) {
  return (
    <div className="tool-group">
      {children}
    </div>
  );
}

function HatchToolCall(props) {
  const { language, t } = useI18n();
  const approvals = useContext(ApprovalContext);
  const approvalRequest = approvals?.requests?.[props.toolCallId];
  const display = toolDisplay(props.toolName, t);
  const state = toolState(props, approvalRequest);
  const target = toolTarget(props.args);
  const label = toolActionLabel(display.action, state, target, t, language);
  const summary = toolResultSummary(props, t);
  const pendingApproval = approvalRequest?.status === "pending";

  return (
    <div className={`tool-call ${state}`}>
      <div className="tool-summary">
        <span className="tool-icon">{display.icon}</span>
        <span className="tool-label">{label}</span>
        {summary ? <span className="tool-meta">{summary}</span> : null}
      </div>
      {pendingApproval || approvalRequest?.status ? <div className="tool-detail">
        {pendingApproval ? (
          <div className="approval-gate">
            <div>
              <strong>{t("approval.allowActionTitle")}</strong>
              <p>{approvalRequest.message.reason || approvalReasonText(approvalRequest.message, t)}</p>
            </div>
            <div className="approval-actions">
              <button type="button" onClick={() => approvals.resolveToolApproval(props.toolCallId, true)}>
                {t("common.allow")}
              </button>
              <button type="button" className="secondary" onClick={() => approvals.resolveToolApproval(props.toolCallId, false)}>
                {t("common.deny")}
              </button>
            </div>
          </div>
        ) : approvalRequest?.status ? (
          <div className={`approval-resolution ${approvalRequest.status}`}>
            {approvalRequest.status === "approved" ? t("common.allowed") : t("common.notAllowed")}
          </div>
        ) : null}
      </div> : null}
    </div>
  );
}

function SkillActivityPart({ data }) {
  const { t } = useI18n();
  const status = data.status === "invoked" ? "invoked" : "activated";
  const display = skillActivityDisplay(data, t);
  return (
    <details className={`skill-activity ${status}`}>
      <summary>
        <span className="skill-icon">{display.icon}</span>
        <span className="skill-label">{display.label}</span>
        <span className="skill-meta">{display.meta}</span>
      </summary>
      <div className="skill-detail">
        <SkillDetailRow label={t("creatorMethod.methodLabel")} value={methodDisplayName(data.name, t)} />
        <p className="skill-explanation">{t("creatorMethod.explanation")}</p>
      </div>
    </details>
  );
}

function SkillRunActivityPart({ data }) {
  const { t } = useI18n();
  const status = data.status;
  const methodName = methodDisplayName(data.name, t);
  const label = status === "completed"
    ? t("creatorMethod.run.applied", { method: methodName })
    : status === "failed"
      ? t("creatorMethod.run.couldNotApply", { method: methodName })
      : status === "cancelled"
        ? t("creatorMethod.run.stopped", { method: methodName })
        : status === "requested"
          ? t("creatorMethod.run.preparing", { method: methodName })
          : t("creatorMethod.run.applying", { method: methodName });
  const icon = status === "completed" ? "◆" : status === "failed" || status === "cancelled" ? "!" : "◇";
  return (
    <details className={`skill-activity skill-run-${status}`} open={status === "failed"}>
      <summary>
        <span className="skill-icon">{icon}</span>
        <span className="skill-label">{label}</span>
        <span className="skill-meta">{t("creatorMethod.generic")}</span>
      </summary>
      <div className="skill-detail">
        <SkillDetailRow label={t("creatorMethod.methodLabel")} value={methodName} />
        {data.error?.message ? (
          <SkillDetailRow label={t("creatorMethod.errorLabel")} value={localizedErrorMessage(data.error, t)} />
        ) : null}
      </div>
    </details>
  );
}

function SkillDetailRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="skill-detail-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function approvalReasonText(message, t) {
  if (message.name === "file_write") {
    return t("approval.writeFileReason", {
      target: toolTarget(message.arguments) || t("approval.fileFallback")
    });
  }
  if (message.name === "file_patch") {
    return t("approval.updateFileReason", {
      target: toolTarget(message.arguments) || t("approval.fileFallback")
    });
  }
  if (message.name === "shell_exec") {
    return t("approval.runCommandReason", {
      command: toolTarget(message.arguments) || t("approval.shellFallback")
    });
  }
  return t("approval.runLocalReason", { name: message.name });
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

function toolState(part, approvalRequest) {
  if (approvalRequest?.status === "pending") return "approval";
  if (approvalRequest?.status === "approved" && part.result === undefined && !part.isError) return "running";
  if (approvalRequest?.status === "denied") return "failed";
  if (part.isError || part.status?.type === "incomplete") return "failed";
  if (part.result !== undefined || part.status?.type === "complete") return "completed";
  if (part.status?.type === "requires-action" || part.approval?.approved === undefined && part.approval) return "approval";
  return "running";
}

function skillActivityDisplay(data, t) {
  const status = data.status === "invoked" ? "invoked" : "activated";
  const methodName = methodDisplayName(data.name, t);
  const label = status === "invoked"
    ? t("creatorMethod.activity.applied", { method: methodName })
    : t("creatorMethod.activity.using", { method: methodName });
  return {
    icon: status === "invoked" ? "◆" : "◇",
    label,
    meta: t("creatorMethod.generic")
  };
}

function skillRunStatus(event) {
  const method = normalizedMethodDisplayName(event.name);
  if (event.status === "completed") return uiStatus("creatorMethod.status.applied", { method });
  if (event.status === "failed") return uiStatus("creatorMethod.status.failed", { method });
  if (event.status === "cancelled") return uiStatus("creatorMethod.status.stopped", { method });
  if (event.status === "requested") return uiStatus("creatorMethod.status.preparing", { method });
  return uiStatus("creatorMethod.status.applying", { method });
}

function methodDisplayName(name, t) {
  return normalizedMethodDisplayName(name) || t("creatorMethod.generic");
}

function normalizedMethodDisplayName(name) {
  const value = String(name ?? "").trim();
  if (!value) return "";
  if (!/^[a-z0-9_-]+$/.test(value)) return value;
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function toolDisplay(name, t) {
  const canonical = String(name);
  const normalized = canonical.replaceAll("_", ".");
  if (normalized.includes("web.search")) return translatedToolDisplay("searchWeb", "◎", t);
  if (canonical.includes("file_search")) return translatedToolDisplay("searchFiles", "⌕", t);
  if (canonical.includes("file_read")) return translatedToolDisplay("readFile", "▣", t);
  if (canonical.includes("file_list")) return translatedToolDisplay("listFiles", "☷", t);
  if (canonical.includes("file_write")) return translatedToolDisplay("writeFile", "✎", t);
  if (canonical.includes("file_patch")) return translatedToolDisplay("editFile", "✎", t);
  if (canonical.includes("shell_exec")) return translatedToolDisplay("runCommand", ">_", t);
  if (canonical.includes("git_diff")) return translatedToolDisplay("reviewChanges", "Δ", t);
  if (normalized.includes("api.request")) return translatedToolDisplay("contactService", "↗", t);
  if (normalized.includes("mcp.call")) return translatedToolDisplay("useConnectedService", "◇", t);
  return translatedToolDisplay("runStep", "·", t);
}

function translatedToolDisplay(key, icon, t) {
  return {
    action: t(`tool.action.${key}`),
    running: t(`tool.running.${key}`),
    icon
  };
}

function toolActionLabel(action, state, target, t, language) {
  const suffix = target ? toolTargetSuffix(target, language) : "";
  if (state === "completed") return t("tool.state.complete", { action, target: suffix });
  if (state === "failed") return t("tool.state.failed", { action, target: suffix });
  if (state === "approval") return t("tool.state.needsApproval", { action, target: suffix });
  return t("tool.state.running", { action, target: suffix });
}

function toolTarget(args) {
  const value = args?.path ?? args?.query ?? args?.command ?? args?.endpoint ?? args?.tool;
  if (typeof value !== "string" || value.length === 0) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 55)}...` : compact;
}

function toolResultSummary(part, t) {
  if (part.isError) {
    const message = part.result
      ? localizedErrorMessage(part.result, t)
      : t("tool.result.failed");
    return String(message).slice(0, 80);
  }
  const result = part.result;
  if (!result) return "";
  if (typeof result.output === "string") return summarizeText(result.output, t);
  if (typeof result.content === "string") return summarizeText(result.content, t);
  if (typeof result.diff === "string") return t("tool.result.diffReady");
  if (Array.isArray(result.entries)) return t("tool.result.entries", { count: result.entries.length });
  if (Array.isArray(result.matches)) return t("tool.result.matches", { count: result.matches.length });
  return t("tool.result.completed");
}

function summarizeText(text, t) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return t("tool.result.empty");
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function uiStatus(key, values = {}) {
  return { kind: "ui", key, values };
}

function errorStatus(error) {
  return { kind: "error", error };
}

function statusKey(status) {
  return status?.kind === "ui" ? status.key : "";
}

function localizeStatus(status, t) {
  if (!status) return "";
  if (status.kind === "ui") {
    const values = { ...(status.values ?? {}) };
    if (Object.prototype.hasOwnProperty.call(values, "method") && !values.method) {
      values.method = t("creatorMethod.generic");
    }
    if (values.statusKey) {
      values.status = t(values.statusKey);
      delete values.statusKey;
    }
    if (values.permissionKey) {
      values.permission = t(values.permissionKey);
      delete values.permissionKey;
    }
    if (Object.prototype.hasOwnProperty.call(values, "errorValue")) {
      values.error = localizedErrorMessage(values.errorValue, t);
      delete values.errorValue;
    }
    return t(status.key, values);
  }
  if (status.kind === "error") return localizedErrorMessage(status.error, t);
  return localizeUserMessage(status, t);
}

function localizedMessage(i18nKey, i18nValues = {}) {
  return { i18nKey, i18nValues };
}

function localizedError(i18nKey, i18nValues = {}, code) {
  const error = new Error(createTranslator(DEFAULT_LANGUAGE)(i18nKey, i18nValues));
  error.i18nKey = i18nKey;
  error.i18nValues = i18nValues;
  if (code) error.code = code;
  return error;
}

function localizeUserMessage(value, t) {
  if (!value) return "";
  return localizedErrorMessage(value, t);
}

function localizedErrorMessage(error, t) {
  if (!error) return t("error.unknown");
  if (error?.i18nKey) return t(error.i18nKey, error.i18nValues ?? {});
  if (error?.error && typeof error.error === "object") return localizedErrorMessage(error.error, t);
  if (typeof error === "string") return error;
  if (typeof error?.message === "string" && error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return t("error.unknown");
  }
}

function localizedCreatorAgent(agent, t) {
  if (agent?.id !== DEFAULT_CREATOR_AGENT.id) {
    return {
      ...agent,
      description: agent?.description || t("app.defaultAgentDescription")
    };
  }
  const creator = t("app.defaultCreatorName");
  return {
    ...agent,
    creator,
    creatorInitials: creator.slice(0, 1).toUpperCase(),
    name: t("app.defaultAgentName"),
    description: t("app.defaultAgentDescription"),
    boundary: t("app.defaultAgentBoundary")
  };
}

function profileInitials(profile, t) {
  return profile?.initials || t("app.defaultUserName").slice(0, 1).toUpperCase();
}

function localizedPermissionPolicyLabel(policy, t) {
  return policy === PERMISSION_POLICIES.ALLOW_CHANGES
    ? t("permission.allowChanges")
    : t("permission.askBeforeChanges");
}

function localizedPermissionPolicyDetail(policy, t) {
  return policy === PERMISSION_POLICIES.ALLOW_CHANGES
    ? t("permission.allowChangesDetail")
    : t("permission.askBeforeChangesDetail");
}

function approvalStatusKey(status) {
  if (status === "approved") return "common.allowed";
  if (status === "denied") return "common.notAllowed";
  return "common.empty";
}

function localizeStoredUiMessage(message, t) {
  const key = message?.metadata?.custom?.uiMessageKey;
  if (!key) return message;
  const text = t(key, message.metadata.custom.uiMessageValues ?? {});
  const content = assistantParts(message);
  const textIndex = content.findLastIndex((part) => part.type === "text");
  if (textIndex >= 0) content[textIndex] = { ...content[textIndex], text };
  else content.push({ type: "text", text });
  return {
    ...message,
    content,
    ...(message.status?.type === "incomplete" ? {
      status: {
        ...message.status,
        error: { ...(message.status.error ?? {}), message: text }
      }
    } : {})
  };
}

function languageNativeName(language) {
  return LANGUAGE_OPTIONS.find((option) => option.value === language)?.nativeLabel
    ?? LANGUAGE_OPTIONS.find((option) => option.value === DEFAULT_LANGUAGE).nativeLabel;
}

function toolTargetSuffix(target, language) {
  return language === DEFAULT_LANGUAGE ? ` ${target}` : `：${target}`;
}

function browserPreferredLocales() {
  if (typeof navigator === "undefined") return [];
  const locales = Array.isArray(navigator.languages) ? navigator.languages : [];
  if (locales.length > 0) return locales.filter((locale) => typeof locale === "string" && locale.trim());
  return typeof navigator.language === "string" && navigator.language.trim()
    ? [navigator.language]
    : [];
}

async function loadNativeSystemLocales(invokeImpl) {
  try {
    const locale = await invokeImpl("system_locale");
    if (typeof locale === "string" && locale.trim()) return [locale];
  } catch {
    // Browser preview and renderer tests have no native locale bridge.
  }
  return browserPreferredLocales();
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return error.message;
  return JSON.stringify(error);
}

async function invokeTauri(command, args) {
  try {
    return await invoke(command, args);
  } catch (error) {
    if (command === "default_workspace") {
      return "";
    }
    if (command === "ensure_workspace") {
      return {
        grant_id: args?.workspaceGrantId ?? "browser-preview-grant",
        display_path: args?.displayPath ?? createTranslator(DEFAULT_LANGUAGE)("workspace.browserPreview")
      };
    }
    throw error;
  }
}

createRoot(document.getElementById("root")).render(<App />);
