import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
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
import { handleLocalToolRequest, toolCorrelationId } from "./toolBridge.js";
import { selectWorkspace } from "./workspaceState.js";
import "streamdown/styles.css";
import "./styles.css";

const PROTOCOL_VERSION = "0.3";
const LOCAL_TOOLS = [
  "fs.list",
  "fs.search",
  "fs.read",
  "fs.write",
  "fs.patch",
  "shell.exec",
  "git.diff"
];
const SKILL_ACTIVITY_PART = "hatch.skill_activity";
const SKILL_RUN_ACTIVITY_PART = "hatch.skill_run_activity";
const LOCAL_TOOL_TIMEOUT_MS = 45_000;
const DEFAULT_RUNTIME_URL = import.meta.env.VITE_HATCH_RUNTIME_URL || "ws://127.0.0.1:8400/runtime";
const ApprovalContext = createContext(null);

function App() {
  const socketRef = useRef(null);
  const workspaceRef = useRef("");
  const activeRunRef = useRef(null);
  const eventSeqRef = useRef(1);
  const imeRef = useRef({ composing: false, guardUntil: 0 });
  const approvalResolversRef = useRef(new Map());
  const [serverUrl] = useState(DEFAULT_RUNTIME_URL);
  const [workspace, setWorkspace] = useState("");
  const [conversationId, setConversationId] = useState("desktop-chat");
  const [status, setStatus] = useState("Disconnected");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [approvalRequests, setApprovalRequests] = useState({});

  const send = useCallback((message) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    recordEvent("out", message);
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
      setStatus("Runtime unavailable.");
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
  }, [connected, conversationId, send]);

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
    imeRef.current.guardUntil = Number.POSITIVE_INFINITY;
  }, []);

  const endImeComposition = useCallback(() => {
    imeRef.current.composing = false;
    imeRef.current.guardUntil = performance.now() + 180;
  }, []);

  const resetImeComposition = useCallback(() => {
    imeRef.current.composing = false;
    imeRef.current.guardUntil = 0;
  }, []);

  const stopImeEnterSubmit = useCallback((event) => {
    if (event.key !== "Enter") return;
    const nativeEvent = event.nativeEvent ?? event;
    const guardActive = performance.now() < imeRef.current.guardUntil;
    if (imeRef.current.composing || nativeEvent.isComposing || nativeEvent.keyCode === 229 || guardActive) {
      event.stopPropagation();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const defaultWorkspace = await invokeTauri("default_workspace");
      if (cancelled) return;
      const savedWorkspace = localStorage.getItem("hatch.workspaceRoot") || defaultWorkspace;
      const savedConversationId = localStorage.getItem("hatch.conversationId") || "desktop-chat";
      workspaceRef.current = savedWorkspace;
      setWorkspace(savedWorkspace);
      setConversationId(savedConversationId);
      void connectRuntime({
        serverUrl: DEFAULT_RUNTIME_URL,
        workspace: savedWorkspace,
        conversationId: savedConversationId
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    socketRef.current?.close();
  }, []);

  async function chooseWorkspace() {
    try {
      await selectWorkspace({
        invokeTauri,
        storage: localStorage,
        setWorkspaceRef: (normalized) => {
          workspaceRef.current = normalized;
        },
        setWorkspace,
        disconnectRuntime: socketRef.current ? disconnectRuntime : undefined
      });
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }

  async function connectRuntime(connection = {}) {
    if (connected || socketRef.current) return;
    const targetServerUrl = connection.serverUrl || serverUrl;
    const targetWorkspace = connection.workspace || workspace;
    const targetConversationId = connection.conversationId || conversationId;
    if (!targetServerUrl.trim() || !targetWorkspace.trim()) {
      setStatus("Runtime unavailable.");
      return;
    }

    localStorage.setItem("hatch.workspaceRoot", targetWorkspace.trim());
    localStorage.setItem("hatch.conversationId", targetConversationId.trim() || "desktop-chat");

    let normalizedWorkspace;
    try {
      normalizedWorkspace = await invokeTauri("ensure_workspace", {
        workspaceRoot: targetWorkspace.trim()
      });
      workspaceRef.current = normalizedWorkspace;
      setWorkspace(normalizedWorkspace);
      setStatus("Loading history...");
      const activeConversationId = targetConversationId.trim() || "desktop-chat";
      const history = await loadConversationHistory(targetServerUrl.trim(), activeConversationId);
      setMessages(history.map(historyMessageToThreadMessage));
      setEvents([]);
      setStatus("Connecting...");
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }

    const socket = new WebSocket(targetServerUrl.trim());
    socketRef.current = socket;
    socket.addEventListener("open", () => {
      send({
        type: "client.hello",
        protocol_version: PROTOCOL_VERSION,
        installation_id: "desktop-local-install",
        license_token: "desktop-local-license",
        client_version: "0.1.0",
        workspace_root: normalizedWorkspace,
        local_tools: LOCAL_TOOLS
      });
    });
    socket.addEventListener("message", (event) => {
      void handleRuntimeMessage(JSON.parse(event.data));
    });
    socket.addEventListener("error", () => {
      setStatus("Runtime socket error.");
    });
    socket.addEventListener("close", () => {
      rejectPendingApprovals();
      socketRef.current = null;
      activeRunRef.current = null;
      setConnected(false);
      setRunning(false);
      setStatus("Disconnected");
    });
  }

  function disconnectRuntime() {
    rejectPendingApprovals();
    socketRef.current?.close();
    socketRef.current = null;
    activeRunRef.current = null;
    setConnected(false);
    setRunning(false);
    setStatus("Disconnected");
  }

  async function handleRuntimeMessage(message) {
    recordEvent("in", message);

    if (message.type === "session.ready") {
      setConnected(true);
      setStatus(`Connected: protocol ${message.accepted_protocol_version}`);
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
      recordRendererTrace("tool_request.received", "requested", toolCorrelationId(message));
      upsertToolEvent({
        ...message,
        locality: "client",
        status: "requested"
      });
      await handleLocalToolRequest(message, {
        workspaceRoot: workspaceRef.current || workspace,
        invokeTauri,
        withTimeout,
        timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
        send,
        upsertToolEvent,
        recordTrace: recordRendererTrace,
        errorMessage
      });
      return;
    }

    if (message.type === "skill.activated" || message.type === "skill.invoked") {
      upsertSkillEvent(message);
      setStatus(`${message.status === "activated" ? "Loaded" : "Invoked"} skill: ${message.name}`);
      return;
    }

    if (message.type === "skill.run") {
      upsertSkillRun(message);
      setStatus(skillRunStatusLabel(message));
      return;
    }

    if (message.type === "session.compacted") {
      setStatus("Session compacted");
      return;
    }

    if (message.type === "turn.completed") {
      const activeRun = activeRunRef.current;
      const finalText = message.output.map((item) => item.content).join("\n");
      if (activeRun) {
        finishAssistant(activeRun.assistantId, finalText || activeRun.text || "Done.", "completed");
      }
      activeRunRef.current = null;
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
      setRunning(false);
      setStatus("Failed");
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

  function recordEvent(direction, event) {
    const id = `${Date.now()}_${eventSeqRef.current++}`;
    setEvents((current) => [...current.slice(-299), {
      id,
      direction,
      event,
      at: new Date().toLocaleTimeString()
    }]);
  }

  return (
    <main className="app-shell">
      <aside className="control-panel">
        <div className="brand">
          <span className="brand-mark">H</span>
          <div>
            <h1>Hatch</h1>
            <p>Server-owned agent chat</p>
          </div>
        </div>

        <section className="connection-card">
          <div className="connection-status">
            <span className={`status-light ${connected ? "online" : "offline"}`} />
            <div>
              <span>Runtime</span>
              <strong>{connected ? "Ready" : status}</strong>
            </div>
          </div>
        </section>

        <section className="side-section">
          <div className="workspace-picker">
            <span className="label">Workspace</span>
            <strong>{workspace || "No workspace selected"}</strong>
            <button type="button" className="secondary" onClick={() => void chooseWorkspace()}>
              {workspace ? "Change folder" : "Choose folder"}
            </button>
          </div>
        </section>

        <section className="side-section">
          <h2>Local Tools</h2>
          <div className="tool-list">
            {LOCAL_TOOLS.map((tool) => <span key={tool}>{tool}</span>)}
          </div>
        </section>

        <details className="debug-panel">
          <summary>Debug Event Stream</summary>
          <EventTimeline events={events} />
        </details>
      </aside>

      <section className="chat-shell">
        <header className="chat-header">
          <div>
            <span className="label">Session</span>
            <strong>{conversationId.trim() || "desktop-chat"}</strong>
          </div>
          <div>
            <span className="label">Workspace</span>
            <strong>{workspace || "No workspace selected"}</strong>
          </div>
          {running ? (
            <button className="secondary compact" onClick={() => void cancelRun()}>Stop</button>
          ) : null}
        </header>

        <ApprovalContext.Provider value={{ requests: approvalRequests, resolveToolApproval }}>
          <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root className="thread-root">
              <ThreadPrimitive.Viewport className="thread-viewport">
                <ThreadPrimitive.Empty>
                  <EmptyThread connected={connected} />
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
                    onKeyUpCapture={stopImeEnterSubmit}
                    placeholder={connected ? "Ask Hatch to inspect, edit, or explain this workspace" : "Preparing the runtime..."}
                    submitMode="enter"
                    rows={1}
                  />
                  <ComposerPrimitive.Send className="send-button">Send</ComposerPrimitive.Send>
                </ComposerPrimitive.Root>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Root>
          </AssistantRuntimeProvider>
        </ApprovalContext.Provider>
      </section>
    </main>
  );
}

async function loadConversationHistory(serverUrl, conversationId) {
  const response = await fetch(historyUrlForRuntime(serverUrl, conversationId));
  if (!response.ok) {
    throw new Error(`Could not load conversation history: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.filter((message) => message.role === "user" || message.role === "assistant");
}

function historyUrlForRuntime(serverUrl, conversationId) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/conversations/${encodeURIComponent(conversationId)}/messages`;
  url.search = "";
  url.hash = "";
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

function EmptyThread({ connected }) {
  return (
    <div className="empty-thread">
      <span className="empty-kicker">{connected ? "Ready" : "Starting"}</span>
      <h2>{connected ? "Ask Hatch about this workspace." : "Preparing your workspace."}</h2>
      <p>
        {connected
          ? "The server keeps session history. This client sends only your next message and executes approved local tools."
          : "Hatch is connecting to the runtime and loading your existing conversation history."}
      </p>
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
    ? `运行失败 ${elapsed}`
    : isRunning && activeTool
      ? `${toolDisplay(activeTool.toolName).running} ${elapsed}`
      : isRunning
        ? `思考中 ${elapsed}`
        : latestTool
          ? `已思考 ${elapsed}`
          : `已回答 ${elapsed}`;

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
  const locality = props.artifact?.locality === "server" ? "server" : "local";
  const summary = toolResultSummary(props);
  const pendingApproval = approvalRequest?.status === "pending";

  return (
    <details className={`tool-call ${state}`} open={pendingApproval ? true : undefined}>
      <summary>
        <span className="tool-icon">{display.icon}</span>
        <span className="tool-label">{label}</span>
        <span className="tool-meta">{locality}{summary ? ` · ${summary}` : ""}</span>
      </summary>
      <div className="tool-detail">
        {pendingApproval ? (
          <div className="approval-gate">
            <div>
              <strong>Approve local tool?</strong>
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
            {approvalRequest.status === "approved" ? "Approved by user" : "Denied by user"}
          </div>
        ) : null}
        <ToolDetailBlock title="Arguments" value={props.args} />
        {props.result !== undefined ? (
          <ToolDetailBlock title={props.isError ? "Error" : "Result"} value={props.result} />
        ) : null}
      </div>
    </details>
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
        <SkillDetailRow label="Skill" value={data.name} />
        <SkillDetailRow label="Reason" value={skillReasonLabel(data.reason)} />
        <SkillDetailRow label="Source" value={data.path} />
        {data.source_tool_call_id ? <SkillDetailRow label="Source Tool" value={data.source_tool_call_id} /> : null}
        {data.trigger ? <SkillDetailRow label="Trigger" value={skillTriggerLabel(data.trigger)} /> : null}
      </div>
    </details>
  );
}

function SkillRunActivityPart({ data }) {
  const status = data.status;
  const label = status === "completed"
    ? `已完成 skill ${data.name}`
    : status === "failed"
      ? `skill ${data.name} 失败`
      : status === "cancelled"
        ? `已取消 skill ${data.name}`
        : status === "requested"
          ? `准备运行 skill ${data.name}`
          : `正在运行 skill ${data.name}`;
  const icon = status === "completed" ? "◆" : status === "failed" || status === "cancelled" ? "!" : "◇";
  return (
    <details className={`skill-activity skill-run-${status}`} open={status === "failed"}>
      <summary>
        <span className="skill-icon">{icon}</span>
        <span className="skill-label">{label}</span>
        <span className="skill-meta">{data.skill_run_id}</span>
      </summary>
      <div className="skill-detail">
        <SkillDetailRow label="Skill" value={data.skill_id ?? data.name} />
        <SkillDetailRow label="Run" value={data.skill_run_id} />
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

function ToolDetailBlock({ title, value }) {
  return (
    <div className="tool-detail-block">
      <span>{title}</span>
      <pre>{formatToolValue(value)}</pre>
    </div>
  );
}

function EventTimeline({ events }) {
  if (events.length === 0) {
    return <div className="event-empty">No events yet.</div>;
  }

  return (
    <ol className="event-list">
      {events.map((entry) => (
        <li key={entry.id} className="event-row">
          <div className="event-summary">
            <span className={`event-direction ${entry.direction}`}>{entry.direction === "in" ? "recv" : "send"}</span>
            <span className={`event-status status-${eventTone(entry.event)}`}>{debugEventStatus(entry.event)}</span>
            <span className="event-title">{debugEventTitle(entry.event)}</span>
            <span className="event-time">{entry.at}</span>
          </div>
          <details>
            <summary>raw</summary>
            <pre>{JSON.stringify(entry.event, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ol>
  );
}

function approvalReasonText(message) {
  if (message.name === "fs.write") {
    return `Write ${toolTarget(message.arguments) || "a file"} in the selected workspace.`;
  }
  if (message.name === "shell.exec") {
    return `Run command: ${toolTarget(message.arguments) || "shell command"}`;
  }
  return `Run ${message.name} locally in the selected workspace.`;
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
  const label = status === "invoked"
    ? `已调用 skill ${data.name}`
    : `已加载 skill ${data.name}`;
  return {
    icon: status === "invoked" ? "◆" : "◇",
    label,
    meta: skillReasonLabel(data.reason)
  };
}

function skillRunStatusLabel(event) {
  if (event.status === "completed") return `Completed skill: ${event.name}`;
  if (event.status === "failed") return `Skill failed: ${event.name}`;
  if (event.status === "cancelled") return `Cancelled skill: ${event.name}`;
  if (event.status === "requested") return `Starting skill: ${event.name}`;
  return `Running skill: ${event.name}`;
}

function skillReasonLabel(reason) {
  if (reason === "explicit_mention") return "显式触发";
  if (reason === "skill_doc_read") return "读取 SKILL.md";
  if (reason === "script_run") return "运行 skill 脚本";
  if (reason === "skipped") return "已跳过";
  if (reason === "unavailable") return "不可用";
  return reason || "skill activity";
}

function skillTriggerLabel(trigger) {
  if (!trigger) return "";
  const target = trigger.path ?? trigger.command ?? "";
  return [trigger.tool, target].filter(Boolean).join(" · ");
}

function toolDisplay(name) {
  const normalized = String(name).replaceAll("_", ".");
  if (normalized.includes("web.search")) return { action: "搜索网页", running: "正在搜索网页", icon: "◎" };
  if (normalized.includes("file.search") || normalized.includes("fs.search")) return { action: "搜索代码", running: "正在搜索代码", icon: "⌕" };
  if (normalized.includes("file.read") || normalized.includes("fs.read")) return { action: "读取文件", running: "正在读取文件", icon: "▣" };
  if (normalized.includes("file.list") || normalized.includes("fs.list")) return { action: "列出文件", running: "正在列出文件", icon: "☷" };
  if (normalized.includes("file.write") || normalized.includes("fs.write")) return { action: "写入文件", running: "正在写入文件", icon: "✎" };
  if (normalized.includes("file.patch") || normalized.includes("fs.patch")) return { action: "修改文件", running: "正在修改文件", icon: "✎" };
  if (normalized.includes("shell.exec")) return { action: "运行命令", running: "正在运行命令", icon: ">_" };
  if (normalized.includes("git.diff")) return { action: "查看 diff", running: "正在查看 diff", icon: "Δ" };
  if (normalized.includes("api.request")) return { action: "调用 API", running: "正在调用 API", icon: "↗" };
  if (normalized.includes("mcp.call")) return { action: "调用 MCP", running: "正在调用 MCP", icon: "◇" };
  return { action: `调用 ${name}`, running: `正在调用 ${name}`, icon: "·" };
}

function toolActionLabel(action, state, target) {
  const suffix = target ? ` ${target}` : "";
  if (state === "completed") return `已${action}${suffix}`;
  if (state === "failed") return `${action}失败${suffix}`;
  if (state === "approval") return `${action}需要批准${suffix}`;
  return `正在${action}${suffix}`;
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

function formatToolValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function debugEventTitle(event) {
  if (event.type === "assistant.delta") return event.delta.kind === "text" ? "assistant text" : event.delta.content;
  if (event.type === "tool_call.request") return `${event.name} · ${shortId(event.tool_call_id)}`;
  if (event.type === "tool_call.result") return `${event.status} · ${shortId(event.tool_call_id)}`;
  if (event.type === "tool_call.delta") return `${event.name} · ${event.status}`;
  if (event.type === "turn.state") return event.status;
  if (event.type === "turn.completed") return "turn completed";
  if (event.type === "turn.failed") return event.error?.message || "turn failed";
  return event.type;
}

function debugEventStatus(event) {
  if (event.type === "tool_call.delta") return event.status;
  if (event.type === "tool_call.result") return event.status;
  if (event.type === "turn.state") return event.status;
  if (event.type === "turn.failed") return "failed";
  if (event.type === "turn.completed") return "completed";
  return "event";
}

function eventTone(event) {
  const status = debugEventStatus(event);
  if (status === "failed" || status === "error") return "failed";
  if (status === "completed" || status === "ok") return "completed";
  if (status === "running" || status === "requested" || status === "queued") return "running";
  return "neutral";
}

function shortId(id) {
  const value = String(id);
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
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

function recordRendererTrace(phase, status, correlationId) {
  const event = {
    phase,
    status,
    correlation_id: correlationId
  };
  if (typeof window !== "undefined") {
    const trace = Array.isArray(window.__HATCH_RENDERER_TRACE__)
      ? window.__HATCH_RENDERER_TRACE__
      : [];
    trace.push(event);
    window.__HATCH_RENDERER_TRACE__ = trace.slice(-200);
  }
  console.info("hatch.renderer", JSON.stringify(event));
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
