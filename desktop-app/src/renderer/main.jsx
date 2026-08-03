import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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
  PERMISSION_POLICIES,
  PRODUCT_COPY,
  canStartConversation,
  creatorAgentFromSession,
  creatorAgentFromEntitlement,
  CHANGE_TOOLS,
  localToolsForPermissionPolicy,
  profileStorageKey,
  requiresUserApproval,
  workspaceGrantLabel
} from "./product-policy.js";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";
import {
  signInAuthSession,
  clearAuthSession,
  configuredAuthSession,
  loadSavedAuthSession,
  validateAndSaveAuthSession
} from "./auth-session.js";

const PROTOCOL_VERSION = "0.3";
const SKILL_ACTIVITY_PART = "hatch.skill_activity";
const SKILL_RUN_ACTIVITY_PART = "hatch.skill_run_activity";
const LOCAL_TOOL_TIMEOUT_MS = 45_000;
const DEFAULT_RUNTIME_URL = import.meta.env.VITE_HATCH_RUNTIME_URL || "wss://hatch.tokenquadrant.cn/v1/runtime";
const DEFAULT_AUTH_URL = import.meta.env.VITE_HATCH_AUTH_URL || "https://hatch.tokenquadrant.cn";
const CONFIGURED_AUTH_SESSION = configuredAuthSession();
const EMPTY_PROFILE = Object.freeze({ id: "anonymous", name: "User", initials: "U" });
const PERMISSION_MODES = Object.freeze([
  { value: PERMISSION_POLICIES.READ_ONLY, label: "Read only", detail: "Read files only" },
  { value: PERMISSION_POLICIES.ASK_BEFORE_CHANGES, label: "Ask before changes", detail: "Ask before file changes" },
  { value: PERMISSION_POLICIES.ALLOW_CHANGES, label: "Allow changes", detail: "Allow file changes" }
]);
const DEFAULT_PERMISSION_MODE = DEFAULT_PERMISSION_POLICY;
const ApprovalContext = createContext(null);

function App() {
  const socketRef = useRef(null);
  // Runtime messages arrive on a WebSocket listener created before React has
  // necessarily re-rendered after a folder grant. Local tool execution must
  // therefore use the latest explicit grant, not a stale render closure.
  const workspaceRef = useRef("");
  const activeRunRef = useRef(null);
  const permissionRef = useRef(DEFAULT_PERMISSION_MODE);
  const shellAccessRef = useRef(true);
  const imeRef = useRef({ composing: false });
  const connectedRef = useRef(false);
  const connectingRef = useRef(false);
  const connectionTokenRef = useRef(0);
  const connectionConfigRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalDisconnectRef = useRef(true);
  const approvalResolversRef = useRef(new Map());
  const [serverUrl] = useState(DEFAULT_RUNTIME_URL);
  const [workspace, setWorkspace] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [buyerSession, setBuyerSession] = useState(() => CONFIGURED_AUTH_SESSION ?? loadSavedAuthSession());
  const [creatorAgentEntitlements, setCreatorAgentEntitlements] = useState([]);
  const [selectedEntitlementId, setSelectedEntitlementId] = useState("");
  const [signInStatus, setSignInStatus] = useState("idle");
  const [signInError, setSignInError] = useState("");
  const [workspaceGranted, setWorkspaceGranted] = useState(false);
  const [permissionMode, setPermissionMode] = useState(DEFAULT_PERMISSION_MODE);
  const [shellAccess, setShellAccess] = useState(true);
  const [interruptedRun, setInterruptedRun] = useState(null);
  const [conversationId, setConversationId] = useState("desktop-chat");
  const [status, setStatus] = useState("Offline");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState([]);
  const [approvalRequests, setApprovalRequests] = useState({});
  const [creatorAgent, setCreatorAgent] = useState(DEFAULT_CREATOR_AGENT);
  const buyerProfile = buyerSession?.profile ?? EMPTY_PROFILE;

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
    setStatus("Cancelling");
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

    const content = textFromAppendMessage(appendMessage).trim();
    if (!content) return;

    const runId = `run_${Date.now()}`;
    const assistantId = `${runId}_assistant`;
    const startedAt = Date.now();
    activeRunRef.current = { runId, assistantId, text: "", startedAt };
    localStorage.setItem(profileStorageKey(buyerProfile.id, "activeRun"), JSON.stringify({
      runId, assistantId, startedAt, conversationId
    }));
    setMessages((current) => [
      ...current,
      makeUserMessage(`${runId}_user`, content, startedAt),
      makeAssistantPlaceholder(assistantId, runId, startedAt)
    ]);
    setRunning(true);
    setStatus("Running");

    send({
      type: "client.message",
      run_id: runId,
      conversation_id: conversationId.trim() || "desktop-chat",
      message: {
        role: "user",
        content
      }
    });
  }, [buyerProfile.id, connected, conversationId, send]);

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    isLoading: status === "Loading history...",
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
    const workspaceKey = profileStorageKey(buyerProfile.id, "workspaceRoot");
    const conversationKey = profileStorageKey(buyerProfile.id, "conversationId");
    const activeRunKey = profileStorageKey(buyerProfile.id, "activeRun");
    const permissionKey = profileStorageKey(buyerProfile.id, "permissionMode");
    const shellKey = profileStorageKey(buyerProfile.id, "shellAccess");
    const savedWorkspace = localStorage.getItem(workspaceKey) || "";
    const savedConversationId = localStorage.getItem(conversationKey) || `conversation_${buyerProfile.id}`;
    const savedRun = parseStoredJson(localStorage.getItem(activeRunKey));
    const savedPermission = localStorage.getItem(permissionKey);
    const nextPermission = PERMISSION_MODES.some((mode) => mode.value === savedPermission)
      ? savedPermission
      : DEFAULT_PERMISSION_MODE;
    const nextShellAccess = nextPermission === PERMISSION_POLICIES.READ_ONLY
      ? false
      : localStorage.getItem(shellKey) !== "false";
    setWorkspace(savedWorkspace);
    workspaceRef.current = savedWorkspace;
    setWorkspaceDraft(savedWorkspace);
    setWorkspaceGranted(Boolean(savedWorkspace));
    setConversationId(savedConversationId);
    permissionRef.current = nextPermission;
    setPermissionMode(nextPermission);
    shellAccessRef.current = nextShellAccess;
    setShellAccess(nextShellAccess);
    if (savedRun) {
      activeRunRef.current = savedRun;
      setInterruptedRun(savedRun);
      setStatus("Task paused — restoring connection");
    } else {
      activeRunRef.current = null;
      setInterruptedRun(null);
    }
  }, [buyerProfile.id]);

  useEffect(() => () => {
    intentionalDisconnectRef.current = true;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    socketRef.current?.close();
  }, []);

  useEffect(() => {
    if (!signedIn || !workspaceGranted || !workspace || !selectedEntitlementId) return;
    if (connectedRef.current || socketRef.current || connectingRef.current) return;
    void connectRuntime({ workspace, conversationId, preserveMessages: true });
  }, [conversationId, selectedEntitlementId, signedIn, workspace, workspaceGranted]);

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

  async function connectRuntime(connection = {}) {
    if (connectedRef.current || socketRef.current || connectingRef.current) return;
    const targetServerUrl = connection.serverUrl || serverUrl;
    const targetWorkspace = connection.workspace || workspace;
    const targetConversationId = connection.conversationId || conversationId;
    const targetEntitlementId = connection.entitlementId || selectedEntitlementId;
    const selectedEntitlement = creatorAgentEntitlements.find((item) => item.entitlement_id === targetEntitlementId);
    const targetAgentId = connection.agentId || selectedEntitlement?.agent_id;
    const targetCreatorId = connection.creatorId || selectedEntitlement?.creator_id;
    if (!targetServerUrl.trim() || !targetWorkspace.trim() || !buyerSession?.accessToken || !targetEntitlementId) {
      setStatus("Choose a folder before starting the connection.");
      return;
    }

    const requestToken = ++connectionTokenRef.current;
    connectingRef.current = true;
    intentionalDisconnectRef.current = false;
    connectionConfigRef.current = {
      serverUrl: targetServerUrl.trim(),
      workspace: targetWorkspace.trim(),
      conversationId: targetConversationId.trim() || `conversation_${buyerProfile.id}`,
      entitlementId: targetEntitlementId,
      ...(targetAgentId ? { agentId: targetAgentId } : {}),
      ...(targetCreatorId ? { creatorId: targetCreatorId } : {})
    };
    localStorage.setItem(profileStorageKey(buyerProfile.id, "workspaceRoot"), targetWorkspace.trim());
    localStorage.setItem(profileStorageKey(buyerProfile.id, "conversationId"), targetConversationId.trim() || `conversation_${buyerProfile.id}`);

    let normalizedWorkspace;
    try {
      normalizedWorkspace = await invokeTauri("ensure_workspace", {
        workspaceRoot: targetWorkspace.trim()
      });
      setWorkspace(normalizedWorkspace);
      workspaceRef.current = normalizedWorkspace;
      connectionConfigRef.current.workspace = normalizedWorkspace;
      setStatus("Loading history...");
      const activeConversationId = targetConversationId.trim() || "desktop-chat";
      const history = await loadConversationHistory(
        targetServerUrl.trim(),
        activeConversationId,
        targetEntitlementId,
        buyerSession.accessToken,
        { agentId: targetAgentId, creatorId: targetCreatorId }
      );
      if (!connection.preserveMessages || messages.length === 0) {
        setMessages(history.map(historyMessageToThreadMessage));
      }
      setStatus("Connecting...");
    } catch (error) {
      if (requestToken === connectionTokenRef.current) {
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
        workspace_root: normalizedWorkspace,
        local_tools: localToolsForPermissionPolicy(permissionRef.current, { enableShell: shellAccessRef.current }),
      }));
    });
    socket.addEventListener("message", (event) => {
      if (socketRef.current !== socket) return;
      void handleRuntimeMessage(JSON.parse(event.data));
    });
    socket.addEventListener("error", () => {
      setStatus("Connection problem. Your work has been kept.");
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      rejectPendingApprovals();
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
    intentionalDisconnectRef.current = true;
    connectionTokenRef.current += 1;
    connectingRef.current = false;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    rejectPendingApprovals();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    connectedRef.current = false;
    setConnected(false);
    setRunning(false);
    setStatus(activeRunRef.current ? "Task paused — your work has been kept" : "Offline");
  }

  async function handleRuntimeMessage(message) {
    if (message.type === "session.ready") {
      setCreatorAgent(creatorAgentFromSession(message));
      connectedRef.current = true;
      reconnectAttemptRef.current = 0;
      setConnected(true);
      setStatus("Ready");
      return;
    }

    if (message.type === "assistant.delta") {
      if (message.delta.kind === "text") {
        const activeRun = activeRunRef.current;
        if (!activeRun) return;
        activeRun.text += message.delta.content;
        appendAssistantText(activeRun.assistantId, message.delta.content);
      } else {
        setStatus(message.delta.content);
        updateAssistantMetadataForRun(message.run_id, {
          latestStatus: message.delta.content
        });
      }
      return;
    }

    if (message.type === "turn.state") {
      setStatus(message.status);
      updateAssistantMetadataForRun(message.run_id, {
        runtimeStatus: message.status
      });
      return;
    }

    if (message.type === "approval.request" || message.type === "approval.result") {
      upsertToolEvent(toolEventFromApproval(message));
      setStatus(message.type === "approval.request"
        ? `Approval requested: ${message.name}`
        : `Approval ${message.status}: ${message.name}`);
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
      setStatus(`${message.status === "activated" ? "Creator method ready" : "Creator method applied"}: ${message.name}`);
      return;
    }

    if (message.type === "skill.run") {
      upsertSkillRun(message);
      setStatus(skillRunStatusLabel(message));
      return;
    }

    if (message.type === "session.compacted") {
      setStatus("Conversation optimized");
      return;
    }

    if (message.type === "turn.completed") {
      const activeRun = activeRunRef.current;
      const finalText = message.output.map((item) => item.content).join("\n");
      if (activeRun) {
        finishAssistant(activeRun.assistantId, finalText || activeRun.text || "Done.", "completed");
      }
      activeRunRef.current = null;
      localStorage.removeItem(profileStorageKey(buyerProfile.id, "activeRun"));
      setInterruptedRun(null);
      setRunning(false);
      setStatus("Completed");
      return;
    }

    if (message.type === "turn.failed") {
      const activeRun = activeRunRef.current;
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
      localStorage.removeItem(profileStorageKey(buyerProfile.id, "activeRun"));
      setInterruptedRun(null);
      setRunning(false);
      setStatus("Failed");
    }
  }

  async function handleToolRequest(message) {
    if (message.name === "shell.exec" && !shellAccessRef.current) {
      sendToolDenied(message, "Shell access is disabled for this session.", "shell_disabled");
      return;
    }
    const isChange = CHANGE_TOOLS.includes(message.name);
    if (permissionRef.current === PERMISSION_POLICIES.READ_ONLY && isChange) {
      sendToolDenied(message, "This permission mode allows reads only.", "permission_denied");
      return;
    }
    let approvedByUser = permissionRef.current === PERMISSION_POLICIES.ALLOW_CHANGES && isChange;
    if (!approvedByUser && (message.approval === "ask" || requiresUserApproval(message.name, permissionRef.current))) {
      const approved = await requestToolApproval(message);
      if (!approved) {
        upsertToolEvent({
          ...message,
          locality: "client",
          status: "failed",
          error: {
            code: "approval_denied",
            message: `Tool call rejected by user: ${message.name}`
          }
        });
        send({
          type: "tool_call.result",
          run_id: message.run_id,
          tool_call_id: message.tool_call_id,
          status: "error",
          error: {
            code: "approval_denied",
            message: `Tool call rejected by user: ${message.name}`
          }
        });
        return;
      }
      approvedByUser = true;
    }

    try {
      const result = await withTimeout(
        invokeTauri("execute_tool_call", {
          workspaceRoot: workspaceRef.current,
          request: approvedByUser ? { ...message, approval: "approved_by_user" } : message
        }),
        LOCAL_TOOL_TIMEOUT_MS,
        `Local tool timed out after ${Math.round(LOCAL_TOOL_TIMEOUT_MS / 1000)}s: ${message.name}`
      );
      send(result);
    } catch (error) {
      const localError = {
        code: error?.code === "local_tool_timeout" ? "local_tool_timeout" : "local_runner_error",
        message: errorMessage(error)
      };
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
        error: localError
      });
    }
  }

  function sendToolDenied(message, reason, code = "approval_denied") {
    upsertToolEvent({ ...message, locality: "client", status: "failed", error: { code, message: reason } });
    send({
      type: "tool_call.result",
      run_id: message.run_id,
      tool_call_id: message.tool_call_id,
      status: "error",
      error: { code, message: reason }
    });
  }

  async function grantWorkspace() {
    try {
      const normalized = await invokeTauri("ensure_workspace", { workspaceRoot: workspaceDraft.trim() });
      setWorkspace(normalized);
      workspaceRef.current = normalized;
      setWorkspaceDraft(normalized);
      setWorkspaceGranted(true);
      localStorage.setItem(profileStorageKey(buyerProfile.id, "workspaceRoot"), normalized);
      setStatus("Folder access granted");
      await connectRuntime({ workspace: normalized, conversationId, preserveMessages: false });
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function chooseWorkspace({ activate = workspaceGranted } = {}) {
    try {
      const selected = await invokeTauri("pick_workspace_folder");
      if (!selected) return;
      setWorkspaceDraft(selected);
      if (activate) await switchWorkspace(selected);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function switchWorkspace(nextWorkspace) {
    const normalized = await invokeTauri("ensure_workspace", { workspaceRoot: nextWorkspace.trim() });
    if (normalized === workspaceRef.current && connectedRef.current) return;

    const activeRun = activeRunRef.current;
    if (activeRun) {
      send({ type: "turn.cancel", run_id: activeRun.runId, reason: "workspace_changed" });
      finishAssistant(activeRun.assistantId, "Task stopped because the workspace changed.", "failed");
      activeRunRef.current = null;
      localStorage.removeItem(profileStorageKey(buyerProfile.id, "activeRun"));
      setInterruptedRun(null);
    }
    disconnectRuntime();
    setWorkspace(normalized);
    workspaceRef.current = normalized;
    setWorkspaceDraft(normalized);
    setWorkspaceGranted(true);
    localStorage.setItem(profileStorageKey(buyerProfile.id, "workspaceRoot"), normalized);
    setStatus("Switching workspace…");
    await connectRuntime({ workspace: normalized, conversationId, preserveMessages: true });
  }

  function updatePermissionMode(nextMode) {
    if (!PERMISSION_MODES.some((mode) => mode.value === nextMode)) return;
    const nextShellAccess = nextMode === PERMISSION_POLICIES.READ_ONLY ? false : shellAccessRef.current;
    permissionRef.current = nextMode;
    setPermissionMode(nextMode);
    shellAccessRef.current = nextShellAccess;
    setShellAccess(nextShellAccess);
    localStorage.setItem(profileStorageKey(buyerProfile.id, "permissionMode"), nextMode);
    localStorage.setItem(profileStorageKey(buyerProfile.id, "shellAccess"), String(nextShellAccess));
    setStatus(`Permission updated: ${permissionModeLabel(nextMode)}`);
    void restartRuntimeSession();
  }

  function updateShellAccess(nextValue) {
    const nextShellAccess = Boolean(nextValue) && permissionRef.current !== PERMISSION_POLICIES.READ_ONLY;
    shellAccessRef.current = nextShellAccess;
    setShellAccess(nextShellAccess);
    localStorage.setItem(profileStorageKey(buyerProfile.id, "shellAccess"), String(nextShellAccess));
    setStatus(nextShellAccess ? "Shell access enabled — approval is still required" : "Shell access disabled");
    void restartRuntimeSession();
  }

  async function restartRuntimeSession() {
    const config = connectionConfigRef.current;
    if (!config || !workspaceGranted) return;
    disconnectRuntime();
    await connectRuntime({ ...config, workspace: workspaceRef.current, preserveMessages: true });
  }

  function startNewConversation() {
    const guard = canStartConversation({ activeRun: activeRunRef.current, connected });
    if (!guard.allowed) {
      setStatus(activeRunRef.current
        ? "Stop or close the active task before starting another conversation."
        : "Connect before starting a new conversation.");
      return;
    }
    const nextId = `conversation_${buyerProfile.id}_${Date.now()}`;
    setConversationId(nextId);
    setMessages([]);
    localStorage.setItem(profileStorageKey(buyerProfile.id, "conversationId"), nextId);
    setStatus("New conversation ready");
  }

  function clearInterruptedRun() {
    activeRunRef.current = null;
    setInterruptedRun(null);
    localStorage.removeItem(profileStorageKey(buyerProfile.id, "activeRun"));
    setStatus("Paused task closed by you");
  }

  async function signIn(credentials) {
    setSignInStatus("loading");
    setSignInError("");
    try {
      const nextSession = credentials ? await signInAuthSession(credentials, DEFAULT_AUTH_URL) : buyerSession;
      if (!nextSession) throw new Error("Sign in to continue.");
      const entitlements = await validateAndSaveAuthSession(
        nextSession,
        (accessToken) => fetchPurchasedCreatorAgents(DEFAULT_AUTH_URL, accessToken)
      );
      const selected = entitlements[0];
      setBuyerSession(nextSession);
      setCreatorAgentEntitlements(entitlements);
      setSelectedEntitlementId(selected?.entitlement_id || "");
      setCreatorAgent(selected ? creatorAgentFromEntitlement(selected) : DEFAULT_CREATOR_AGENT);
      setSignedIn(true);
      setSignInStatus("ready");
    } catch (error) {
      setSignInStatus("error");
      setSignInError(errorMessage(error));
    }
  }

  function signOut() {
    disconnectRuntime();
    clearAuthSession(buyerSession);
    activeRunRef.current = null;
    setInterruptedRun(null);
    setBuyerSession(null);
    setSignedIn(false);
    setCreatorAgentEntitlements([]);
    setSelectedEntitlementId("");
    setCreatorAgent(DEFAULT_CREATOR_AGENT);
    setMessages([]);
    setSignInStatus("idle");
    setSignInError("");
  }

  function selectCreatorAgent(entitlement) {
    if (entitlement.entitlement_id === selectedEntitlementId) return;
    disconnectRuntime();
    setSelectedEntitlementId(entitlement.entitlement_id);
    setCreatorAgent(creatorAgentFromEntitlement(entitlement));
    setMessages([]);
    setConversationId(`conversation_${buyerProfile.id}_${entitlement.creator_id || "creator"}_${entitlement.agent_id || entitlement.product.id}`);
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

  function finishAssistant(id, text, statusValue) {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) return message;
      const parts = assistantParts(message).filter((part) => part.type !== "text");
      if (text) {
        parts.push({ type: "text", text });
      }
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

  if (!signedIn) {
    return <SignInScreen profile={buyerSession?.profile} onSignIn={(credentials) => void signIn(credentials)} status={signInStatus} error={signInError} />;
  }

  return (
    <main className="app-shell">
      <aside className="control-panel">
        <div className="brand">
          <img className="hatch-mark" src={hatchMarkUrl} alt="" />
          <div>
            <h1 className="hatch-wordmark">Hatch.</h1>
            <p>Creator agents, on your terms</p>
          </div>
        </div>

        <section className="profile-card">
          <span className="avatar">{buyerProfile.initials}</span>
          <div><strong>{buyerProfile.name}</strong><span>Signed in</span></div>
          <button className="profile-sign-out" type="button" onClick={signOut}>Sign out</button>
        </section>

        <section className="side-section agent-nav">
          <h2>{PRODUCT_COPY.home}</h2>
          {creatorAgentEntitlements.map((entitlement) => {
            const agent = creatorAgentFromEntitlement(entitlement);
            return (
              <button
                className={`agent-nav-item ${entitlement.entitlement_id === selectedEntitlementId ? "active" : ""}`}
                key={entitlement.entitlement_id}
                type="button"
                onClick={() => selectCreatorAgent(entitlement)}
              >
                <span className="creator-avatar">{agent.creatorInitials}</span>
                <span><strong>{agent.name}</strong><small>by {agent.creator}</small></span>
              </button>
            );
          })}
          {creatorAgentEntitlements.length === 0 ? <p className="empty-library">No purchased agents yet.</p> : null}
        </section>
        <button className="secondary new-conversation" type="button" onClick={startNewConversation}>+ New conversation</button>
      </aside>

      <section className="chat-shell">
        <header className="chat-header">
          <div className="chat-context-row">
            <div className="header-agent">
              <span className="label">Agent</span>
              <strong>{creatorAgent.name} · {creatorAgent.creator}</strong>
            </div>
            <button
              aria-label="Choose workspace folder"
              className="workspace-selector secondary"
              type="button"
              onClick={() => void chooseWorkspace()}
            >
              <span className="workspace-selector-icon" aria-hidden="true">⌂</span>
              <span className="workspace-selector-copy">
                <span className="label">Workspace</span>
                <strong>{workspaceGranted ? workspaceGrantLabel(workspace) : "Choose a folder"}</strong>
              </span>
              <span className="workspace-selector-action">Change</span>
            </button>
          </div>
          <div className="chat-settings-row">
            <label className="permission-control">
              <span className="label">Permissions</span>
              <select
                aria-label="Workspace permissions"
                value={permissionMode}
                onChange={(event) => updatePermissionMode(event.target.value)}
              >
                {PERMISSION_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
              </select>
              <small>{permissionModeDetail(permissionMode)}</small>
            </label>
            <label className="shell-toggle">
              <span className="label">Shell access</span>
              <span className="shell-toggle-row">
                <input
                  type="checkbox"
                  checked={shellAccess}
                  disabled={permissionMode === PERMISSION_POLICIES.READ_ONLY}
                  onChange={(event) => updateShellAccess(event.target.checked)}
                />
                <strong>{shellAccess ? "On" : "Off"}</strong>
              </span>
              <small>Commands always ask for approval</small>
            </label>
          </div>
        </header>

        {!workspaceGranted ? (
          <WorkspaceGrant
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
                  <EmptyThread connected={connected} creatorAgent={creatorAgent} />
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
                    placeholder={connected ? `Message ${creatorAgent.name}` : "Connection is restoring…"}
                    submitMode="enter"
                    rows={1}
                  />
                  {running ? (
                    <button
                      aria-label="Stop streaming"
                      className="send-button stop-button"
                      type="button"
                      onClick={() => void cancelRun()}
                    >
                      Stop
                    </button>
                  ) : (
                    <ComposerPrimitive.Send className="send-button">Send</ComposerPrimitive.Send>
                  )}
                </ComposerPrimitive.Root>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Root>
          </AssistantRuntimeProvider>
        </ApprovalContext.Provider>
        )}
        {interruptedRun ? (
          <div className="recovery-banner" role="alert">
            <div><strong>Your task is safe.</strong><span>It paused before completion. Hatch will restore the session automatically, or you can close it explicitly.</span></div>
            <button className="secondary compact" type="button" onClick={clearInterruptedRun}>Close task</button>
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
    return makeUserMessage(id, message.content ?? "", createdAt);
  }
  const activityParts = historyActivityParts(message);
  const text = message.content ?? "";
  const lastTool = [...activityParts].reverse().find((part) => part.type === "tool-call");
  const lastSkill = [...activityParts].reverse().find(isSkillActivityPart);
  return makeAssistantMessage(id, message.content ?? "", {
    status: "completed",
    createdAt,
    content: [
      ...activityParts,
      ...(text ? [{ type: "text", text }] : [])
    ],
    custom: {
      runId: message.run_id,
      hydrated: true,
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
      ? { code: "approval_denied", message: message.reason ?? "Tool call denied" }
      : undefined
  };
}

function EmptyThread({ connected, creatorAgent }) {
  return (
    <div className="empty-thread">
      <span className="creator-avatar large">{creatorAgent.creatorInitials}</span>
      <span className="empty-kicker">{creatorAgent.creator}</span>
      <h2>{connected ? `What would you like to work on?` : "Your conversation is offline."}</h2>
      <p>
        {connected
          ? creatorAgent.description
          : "Your conversation and unfinished task stay here while the connection is restored."}
      </p>
      {creatorAgent.boundary ? <small className="boundary-copy">{creatorAgent.boundary}</small> : null}
    </div>
  );
}

function permissionModeLabel(value) {
  return PERMISSION_MODES.find((mode) => mode.value === value)?.label || "Ask before changes";
}

function permissionModeDetail(value) {
  return PERMISSION_MODES.find((mode) => mode.value === value)?.detail || "Ask before file changes";
}

function SignInScreen({ profile, onSignIn, status, error }) {
  const [manual, setManual] = useState(!profile);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loading = status === "loading";

  function submit(event) {
    event.preventDefault();
    onSignIn(manual ? { email, password } : undefined);
  }

  return (
    <main className="welcome-screen">
      <div className="welcome-brand"><img className="hatch-mark" src={hatchMarkUrl} alt="" /><strong className="hatch-wordmark">Hatch.</strong></div>
      <section className="sign-in-card">
        <span className="eyebrow">Welcome</span>
        <h1>Your trusted creator agents, in one place.</h1>
        <p>Sign in to use the Creator Agents available to your account.</p>
        <form className="sign-in-form" onSubmit={submit}>
          {manual ? (
            <>
              <label className="field">
                <span>Email</span>
                <input autoCapitalize="none" autoComplete="email" spellCheck="false" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" disabled={loading} />
              </label>
              <label className="field">
                <span>Password</span>
                <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" disabled={loading} />
              </label>
            </>
          ) : (
            <div className="returning-profile">
              <span className="avatar">{profile.initials}</span>
              <span><strong>{profile.name}</strong><small>Your agents are ready on this computer.</small></span>
            </div>
          )}
          <button type="submit" disabled={loading || (manual && (!email.trim() || !password.trim()))}>
            {loading ? "Signing in…" : manual ? "Sign in" : `Continue as ${profile.name}`}
          </button>
        </form>
        {error ? <small className="sign-in-error" role="alert">{error}</small> : null}
        {profile ? (
          <button className="sign-in-switch" type="button" onClick={() => { setManual((value) => !value); setEmail(""); setPassword(""); }} disabled={loading}>
            {manual ? `Continue as ${profile.name}` : "Use a different account"}
          </button>
        ) : null}
        <small>Your access stays on this computer until you sign out.</small>
      </section>
    </main>
  );
}

function WorkspaceGrant({ draft, onChoose, onGrant, status }) {
  return (
    <div className="workspace-gate">
      <section className="workspace-card">
        <span className="permission-icon">⌂</span>
        <span className="eyebrow">One-time setup</span>
        <h2>{PRODUCT_COPY.workspaceRequired}</h2>
        <p>{PRODUCT_COPY.readPolicy}</p>
        <div className="field">
          <span>Folder</span>
          <button className={`workspace-picker ${draft ? "selected" : ""}`} type="button" onClick={onChoose}>
            <span className="workspace-picker-path">{draft || "Choose a folder on this computer"}</span>
            <span className="workspace-picker-action">Choose folder</span>
          </button>
        </div>
        <button type="button" onClick={onGrant} disabled={!draft.trim()}>Grant access to this folder</button>
        <div className="permission-policy">
          <strong>You're in control</strong>
          <span>{PRODUCT_COPY.changePolicy}</span>
        </div>
        {status && status !== "Offline" ? <small className="gate-status">{status}</small> : null}
      </section>
    </div>
  );
}

function HatchMessage() {
  const role = useMessage((message) => message.role);
  return (
    <MessagePrimitive.Root className={`chat-message ${role}`}>
      {role === "assistant" ? <AssistantRunHeader /> : null}
      <div className={`message-surface ${role}`}>
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
  const elapsed = formatDuration(Math.max(0, completedAt - startedAt));
  const toolParts = Array.isArray(parts) ? parts.filter((part) => part.type === "tool-call") : [];
  const activeTool = [...toolParts].reverse().find((part) => !part.result && !part.isError);
  const latestTool = [...toolParts].reverse()[0];
  const failed = status?.type === "incomplete" || custom.status === "failed";
  const summary = failed
    ? `Couldn't finish · ${elapsed}`
    : isRunning && activeTool
      ? `${toolDisplay(activeTool.toolName).running} ${elapsed}`
      : isRunning
        ? `Working · ${elapsed}`
        : latestTool
          ? `Finished · ${elapsed}`
          : `Answered · ${elapsed}`;

  return (
    <div className="run-summary">
      <span className={`activity-dot ${failed ? "failed" : isRunning ? "running" : "done"}`} />
      <span>{summary}</span>
    </div>
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

function AssistantEmptyText() {
  return <span className="assistant-pending">Thinking</span>;
}

function ToolGroup({ children }) {
  return (
    <div className="tool-group">
      {children}
    </div>
  );
}

function HatchToolCall(props) {
  const approvals = useContext(ApprovalContext);
  const approvalRequest = approvals?.requests?.[props.toolCallId];
  const display = toolDisplay(props.toolName);
  const state = toolState(props, approvalRequest);
  const target = toolTarget(props.args);
  const label = toolActionLabel(display.action, state, target);
  const summary = toolResultSummary(props);
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
              <strong>Allow this action?</strong>
              <p>{approvalRequest.message.reason || approvalReasonText(approvalRequest.message)}</p>
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
    <details className={`skill-activity ${status}`}>
      <summary>
        <span className="skill-icon">{display.icon}</span>
        <span className="skill-label">{display.label}</span>
        <span className="skill-meta">{display.meta}</span>
      </summary>
      <div className="skill-detail">
        <SkillDetailRow label="Method" value={methodDisplayName(data.name)} />
        <p className="skill-explanation">This method is provided and maintained by the Creator.</p>
      </div>
    </details>
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
    <details className={`skill-activity skill-run-${status}`} open={status === "failed"}>
      <summary>
        <span className="skill-icon">{icon}</span>
        <span className="skill-label">{label}</span>
        <span className="skill-meta">Creator method</span>
      </summary>
      <div className="skill-detail">
        <SkillDetailRow label="Method" value={methodName} />
        {data.error?.message ? <SkillDetailRow label="Error" value={data.error.message} /> : null}
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

function approvalReasonText(message) {
  if (message.name === "fs.write") {
    return `Write ${toolTarget(message.arguments) || "a file"} in the selected workspace.`;
  }
  if (message.name === "fs.patch") {
    return `Update ${toolTarget(message.arguments) || "a file"} in the selected workspace.`;
  }
  if (message.name === "shell.exec") {
    return `Run command: ${toolTarget(message.arguments) || "shell command"}`;
  }
  return `Run ${message.name} locally in the selected workspace.`;
}

function parseStoredJson(value) {
  if (!value) return null;
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

function toolDisplay(name) {
  const normalized = String(name).replaceAll("_", ".");
  if (normalized.includes("web.search")) return { action: "Search the web", running: "Searching the web", icon: "◎" };
  if (normalized.includes("file.search") || normalized.includes("fs.search")) return { action: "Search files", running: "Searching files", icon: "⌕" };
  if (normalized.includes("file.read") || normalized.includes("fs.read")) return { action: "Read file", running: "Reading file", icon: "▣" };
  if (normalized.includes("file.list") || normalized.includes("fs.list")) return { action: "List files", running: "Listing files", icon: "☷" };
  if (normalized.includes("file.write") || normalized.includes("fs.write")) return { action: "Write file", running: "Writing file", icon: "✎" };
  if (normalized.includes("file.patch") || normalized.includes("fs.patch")) return { action: "Edit file", running: "Editing file", icon: "✎" };
  if (normalized.includes("shell.exec")) return { action: "Run command", running: "Running command", icon: ">_" };
  if (normalized.includes("git.diff")) return { action: "Review changes", running: "Reviewing changes", icon: "Δ" };
  if (normalized.includes("api.request")) return { action: "Contact service", running: "Contacting service", icon: "↗" };
  if (normalized.includes("mcp.call")) return { action: "Use connected service", running: "Using connected service", icon: "◇" };
  return { action: "Run a step", running: "Running a step", icon: "·" };
}

function toolActionLabel(action, state, target) {
  const suffix = target ? ` ${target}` : "";
  if (state === "completed") return `${action} complete${suffix}`;
  if (state === "failed") return `${action} failed${suffix}`;
  if (state === "approval") return `${action} needs approval${suffix}`;
  return `${action}${suffix}`;
}

function toolTarget(args) {
  const value = args?.path ?? args?.query ?? args?.command ?? args?.endpoint ?? args?.tool;
  if (typeof value !== "string" || value.length === 0) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 55)}...` : compact;
}

function toolResultSummary(part) {
  if (part.isError) {
    const message = part.result?.message ?? part.result?.error ?? "failed";
    return String(message).slice(0, 80);
  }
  const result = part.result;
  if (!result) return "";
  if (typeof result.output === "string") return summarizeText(result.output);
  if (typeof result.content === "string") return summarizeText(result.content);
  if (typeof result.diff === "string") return "diff ready";
  if (Array.isArray(result.entries)) return `${result.entries.length} entries`;
  if (Array.isArray(result.matches)) return `${result.matches.length} matches`;
  return "completed";
}

function summarizeText(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "empty";
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
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
      return localStorage.getItem("hatch.workspaceRoot") || "";
    }
    if (command === "ensure_workspace") {
      return args?.workspaceRoot ?? "";
    }
    throw error;
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error(message);
      error.code = "local_tool_timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

createRoot(document.getElementById("root")).render(<App />);
