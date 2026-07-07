import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
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
const WELCOME_MESSAGE = {
  id: "welcome",
  role: "assistant",
  text: "Connect to the TypeScript runtime server, then send a message."
};

function App() {
  const socketRef = useRef(null);
  const activeRunRef = useRef(null);
  const eventSeqRef = useRef(1);
  const [serverUrl, setServerUrl] = useState("ws://127.0.0.1:8400/runtime");
  const [workspace, setWorkspace] = useState("");
  const [conversationId, setConversationId] = useState("desktop-chat");
  const [status, setStatus] = useState("Disconnected");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const defaultWorkspace = await invoke("default_workspace");
      if (cancelled) return;
      setServerUrl(localStorage.getItem("hatch.serverUrl") || "ws://127.0.0.1:8400/runtime");
      setWorkspace(localStorage.getItem("hatch.workspaceRoot") || defaultWorkspace);
      setConversationId(localStorage.getItem("hatch.conversationId") || "desktop-chat");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    socketRef.current?.close();
  }, []);

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  async function connectRuntime() {
    if (connected || socketRef.current) return;
    if (!serverUrl.trim() || !workspace.trim()) {
      setStatus("Server URL and workspace are required.");
      return;
    }

    localStorage.setItem("hatch.serverUrl", serverUrl.trim());
    localStorage.setItem("hatch.workspaceRoot", workspace.trim());
    localStorage.setItem("hatch.conversationId", conversationId.trim() || "desktop-chat");

    let normalizedWorkspace;
    try {
      normalizedWorkspace = await invoke("ensure_workspace", {
        workspaceRoot: workspace.trim()
      });
      setWorkspace(normalizedWorkspace);
      setStatus("Loading history...");
      const activeConversationId = conversationId.trim() || "desktop-chat";
      const history = await loadConversationHistory(serverUrl.trim(), activeConversationId);
      setMessages(history.length > 0 ? history : [WELCOME_MESSAGE]);
      setEvents([]);
      setStatus("Connecting...");
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }

    const socket = new WebSocket(serverUrl.trim());
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
      socketRef.current = null;
      activeRunRef.current = null;
      setConnected(false);
      setRunning(false);
      setStatus("Disconnected");
    });
  }

  function disconnectRuntime() {
    socketRef.current?.close();
    socketRef.current = null;
    activeRunRef.current = null;
    setConnected(false);
    setRunning(false);
    setStatus("Disconnected");
  }

  async function sendPrompt() {
    const socket = socketRef.current;
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Connect to the runtime first.");
      return;
    }
    if (activeRunRef.current) {
      setStatus("A turn is already running.");
      return;
    }

    const content = prompt.trim();
    if (!content) return;

    const runId = `run_${Date.now()}`;
    const assistantId = `${runId}_assistant`;
    const startedAt = Date.now();
    activeRunRef.current = { runId, assistantId, text: "", startedAt };
    setMessages((current) => [
      ...current,
      { id: `${runId}_user`, role: "user", text: content },
      {
        id: assistantId,
        role: "assistant",
        text: "",
        runId,
        startedAt,
        activityOpen: false,
        status: "running"
      }
    ]);
    setPrompt("");
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
        updateAssistant(activeRun.assistantId, activeRun.text);
      } else {
        setStatus(message.delta.content);
      }
      return;
    }

    if (message.type === "turn.state") {
      setStatus(message.status);
      return;
    }

    if (message.type === "approval.request") {
      setStatus(`Approval requested: ${message.name}`);
      return;
    }

    if (message.type === "tool_call.request") {
      await handleToolRequest(message);
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
          { id: `error_${Date.now()}`, role: "assistant", text }
        ]);
      }
      activeRunRef.current = null;
      setRunning(false);
      setStatus("Failed");
    }
  }

  async function handleToolRequest(message) {
    if (message.approval === "ask") {
      const approved = window.confirm(`${message.name}\n\n${message.reason || JSON.stringify(message.arguments, null, 2)}`);
      if (!approved) {
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
    }

    try {
      const result = await invoke("execute_tool_call", {
        workspaceRoot: workspace,
        request: message
      });
      send(result);
    } catch (error) {
      send({
        type: "tool_call.result",
        run_id: message.run_id,
        tool_call_id: message.tool_call_id,
        status: "error",
        error: {
          code: "local_runner_error",
          message: errorMessage(error)
        }
      });
    }
  }

  function updateAssistant(id, text) {
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, text } : message
    )));
  }

  function finishAssistant(id, text, status) {
    setMessages((current) => current.map((message) => (
      message.id === id
        ? { ...message, text, status, completedAt: Date.now() }
        : message
    )));
  }

  function toggleActivity(id) {
    setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, activityOpen: !message.activityOpen } : message
    )));
  }

  function send(message) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    recordEvent("out", message);
    socket.send(JSON.stringify(message));
  }

  function recordEvent(direction, event) {
    const id = `${Date.now()}_${eventSeqRef.current++}`;
    setEvents((current) => [...current, {
      id,
      direction,
      event,
      at: new Date().toLocaleTimeString()
    }]);
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div>
          <h1>Hatch</h1>
          <p>Local runtime chat</p>
        </div>

        <label className="field">
          <span>Server</span>
          <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} autoComplete="off" />
        </label>

        <label className="field">
          <span>Workspace</span>
          <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} autoComplete="off" />
        </label>

        <label className="field">
          <span>Conversation</span>
          <input value={conversationId} onChange={(event) => setConversationId(event.target.value)} autoComplete="off" />
        </label>

        <div className="actions">
          <button onClick={connectRuntime} disabled={connected}>Connect</button>
          <button onClick={disconnectRuntime} disabled={!connected} className="secondary">Disconnect</button>
        </div>

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

      <section className="workspace">
        <header className="status">
          <div>
            <span className="label">Session</span>
            <strong>Server-owned chat history</strong>
          </div>
          <div>
            <span className="label">State</span>
            <strong>{status}</strong>
          </div>
        </header>

        <section className="chat">
          <div className="messages">
            {messages.map((message) => (
              <div key={message.id} className={`message ${message.role}`}>
                {message.role === "assistant" ? (
                  <AssistantMessage
                    message={message}
                    events={events}
                    now={now}
                    onToggleActivity={() => toggleActivity(message.id)}
                  />
                ) : message.text}
              </div>
            ))}
          </div>
        </section>

        <section className="runner">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void sendPrompt();
              }
            }}
            placeholder="Ask Hatch to inspect or edit files in the selected workspace."
          />
          <button onClick={sendPrompt} disabled={!connected || running}>Send</button>
        </section>
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
  return messages.map((message, index) => ({
    id: `history_${message.run_id}_${index}`,
    role: message.role,
    text: message.content
  })).filter((message) => message.role === "user" || message.role === "assistant");
}

function historyUrlForRuntime(serverUrl, conversationId) {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/conversations/${encodeURIComponent(conversationId)}/messages`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function AssistantMessage({ message, events, now, onToggleActivity }) {
  const runEvents = message.runId
    ? events.filter((entry) => entry.event.run_id === message.runId)
    : [];

  if (!message.runId) {
    return <div className="assistant-text">{message.text}</div>;
  }

  return (
    <div className="assistant-stack">
      <RunActivity
        message={message}
        events={runEvents}
        now={now}
        onToggle={onToggleActivity}
      />
      {message.text ? <div className="assistant-text">{message.text}</div> : null}
    </div>
  );
}

function RunActivity({ message, events, now, onToggle }) {
  const toolSteps = buildToolSteps(events);
  const terminalAt = message.completedAt ?? now;
  const elapsed = formatDuration(Math.max(0, terminalAt - message.startedAt));
  const failed = message.status === "failed";
  const activeStep = [...toolSteps].reverse().find((step) => step.status === "running" || step.status === "requested");
  const summary = failed
    ? `运行失败 ${elapsed}`
    : message.status === "completed"
      ? `已思考 ${elapsed}`
      : activeStep
        ? `${activeStep.runningLabel} ${elapsed}`
        : `思考中 ${elapsed}`;

  return (
    <div className="run-activity">
      <button className="run-activity-toggle" type="button" onClick={onToggle}>
        <span className={`activity-dot ${message.status === "completed" ? "done" : failed ? "failed" : "running"}`} />
        <span>{summary}</span>
        <span className={`activity-chevron ${message.activityOpen ? "open" : ""}`}>›</span>
      </button>

      {message.activityOpen ? (
        <div className="activity-panel">
          {toolSteps.map((step) => (
            <div key={step.id} className={`activity-step ${step.status}`}>
              <span className="activity-step-icon">{step.icon}</span>
              <div className="activity-step-copy">
                <strong>{step.label}</strong>
                <span>{step.meta}</span>
              </div>
            </div>
          ))}
          {toolSteps.length === 0 ? (
            <div className="activity-note neutral">
              <span>等待模型响应</span>
            </div>
          ) : null}
        </div>
      ) : null}
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

function shortId(id) {
  const value = String(id);
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function buildToolSteps(events) {
  const grouped = new Map();
  for (const entry of events) {
    const event = entry.event;
    if (!event.tool_call_id) continue;
    if (!isToolEvent(event)) continue;
    const current = grouped.get(event.tool_call_id) ?? {
      id: event.tool_call_id,
      events: []
    };
    current.events.push(event);
    grouped.set(event.tool_call_id, current);
  }

  return [...grouped.values()].map((group) => {
    const lastNamed = [...group.events].reverse().find((event) => event.name);
    const name = lastNamed?.name ?? "tool";
    const status = toolGroupStatus(group.events);
    const args = mergedToolArguments(group.events);
    const display = toolDisplay(name);
    return {
      id: group.id,
      status,
      icon: display.icon,
      label: toolActionLabel(display.action, status, args),
      runningLabel: `正在${display.action}`,
      meta: toolMeta(name, args, group.events)
    };
  });
}

function isToolEvent(event) {
  return event.type === "tool_call.delta"
    || event.type === "tool_call.request"
    || event.type === "tool_call.result";
}

function toolGroupStatus(events) {
  if (events.some((event) => event.type === "tool_call.delta" && event.status === "failed")) return "failed";
  if (events.some((event) => event.type === "tool_call.result" && event.status === "error")) return "failed";
  if (events.some((event) => event.type === "tool_call.delta" && event.status === "cancelled")) return "failed";
  if (events.some((event) => event.type === "tool_call.delta" && event.status === "completed")) return "completed";
  if (events.some((event) => event.type === "tool_call.result" && event.status === "ok")) return "completed";
  if (events.some((event) => event.type === "tool_call.request")) return "running";
  return "requested";
}

function mergedToolArguments(events) {
  for (const event of [...events].reverse()) {
    if (event.arguments) return event.arguments;
  }
  return {};
}

function toolDisplay(name) {
  const normalized = String(name).replaceAll("_", ".");
  if (normalized.includes("web.search")) return { action: "搜索网页", icon: "◎" };
  if (normalized.includes("file.search") || normalized.includes("fs.search")) return { action: "搜索代码", icon: "⌕" };
  if (normalized.includes("file.read") || normalized.includes("fs.read")) return { action: "读取文件", icon: "▣" };
  if (normalized.includes("file.list") || normalized.includes("fs.list")) return { action: "列出文件", icon: "☷" };
  if (normalized.includes("file.write") || normalized.includes("fs.write")) return { action: "写入文件", icon: "✎" };
  if (normalized.includes("file.patch") || normalized.includes("fs.patch")) return { action: "修改文件", icon: "✎" };
  if (normalized.includes("shell.exec")) return { action: "运行命令", icon: ">_" };
  if (normalized.includes("git.diff")) return { action: "查看 diff", icon: "Δ" };
  if (normalized.includes("api.request")) return { action: "调用 API", icon: "↗" };
  if (normalized.includes("mcp.call")) return { action: "调用 MCP", icon: "◇" };
  return { action: `调用 ${name}`, icon: "·" };
}

function toolActionLabel(action, status, args) {
  const target = toolTarget(args);
  const suffix = target ? ` ${target}` : "";
  if (status === "completed") return `已${action}${suffix}`;
  if (status === "failed") return `${action}失败${suffix}`;
  if (status === "running") return `正在${action}${suffix}`;
  return `准备${action}${suffix}`;
}

function toolTarget(args) {
  const value = args.path ?? args.query ?? args.command ?? args.endpoint ?? args.tool;
  if (typeof value !== "string" || value.length === 0) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 52 ? `${compact.slice(0, 49)}...` : compact;
}

function toolMeta(name, args, events) {
  const locality = [...events].reverse().find((event) => event.locality)?.locality;
  const approval = [...events].reverse().find((event) => event.approval)?.approval;
  const parts = [];
  if (locality === "server") {
    parts.push("Server tool");
  } else if (locality === "client" || events.some((event) => event.type === "tool_call.request")) {
    parts.push("Local tool");
  } else {
    parts.push(readableToolName(name));
  }
  if (approval === "ask") parts.push("需要批准");
  if (approval === "auto") parts.push("自动执行");
  const resultSummary = toolResultSummary(events);
  if (resultSummary) parts.push(resultSummary);
  return parts.join(" · ");
}

function readableToolName(name) {
  return String(name).replaceAll("_", ".");
}

function toolResultSummary(events) {
  const failed = [...events].reverse().find((event) => event.error?.message || event.status === "error");
  if (failed?.error?.message) return failed.error.message.slice(0, 96);
  const completed = events.some((event) => (
    event.type === "tool_call.delta" && event.status === "completed"
  )) || events.some((event) => event.type === "tool_call.result" && event.status === "ok");
  return completed ? "完成" : "";
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function debugEventTitle(event) {
  if (event.type === "assistant.delta") return `${event.type}.${event.delta.kind}`;
  if ("name" in event && event.name) return `${event.type}: ${event.name}`;
  if (event.type === "workspace.diff") return `${event.type}: ${event.path}`;
  return event.type;
}

function debugEventStatus(event) {
  if (event.type === "client.hello" || event.type === "client.message") return "sent";
  if (event.type === "session.ready") return "ready";
  if (event.type === "assistant.delta") return event.delta.kind;
  if (event.type === "tool_call.result") return event.status;
  if (event.type === "tool_call.request") return "requested";
  if (event.type === "tool_call.delta") return event.status;
  if (event.type === "approval.request") return "requested";
  if (event.type === "approval.result") return event.status;
  if (event.type === "turn.state") return event.status;
  if (event.type === "turn.completed") return "completed";
  if (event.type === "turn.failed") return "failed";
  return "event";
}

function eventTone(event) {
  const status = debugEventStatus(event);
  if (["failed", "error", "denied", "cancelled"].includes(status)) return "bad";
  if (["completed", "ok", "approved", "ready"].includes(status)) return "good";
  if (["requested", "waiting_for_tool", "compacting", "sent"].includes(status)) return "wait";
  return "neutral";
}

function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // Fall through.
  }
  return "Unknown error";
}

createRoot(document.querySelector("#root")).render(<App />);
