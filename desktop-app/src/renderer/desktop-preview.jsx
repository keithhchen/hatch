import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DesktopWindowShell } from "./desktop-shell.jsx";
import {
  DESKTOP_LAYOUT,
  DESKTOP_ZOOM,
  nextZoom,
  normalizeWindowLayoutPreferences
} from "./desktop-layout.js";
import {
  conversationIdFromLocation,
  isEditableContextTarget,
  nativeContextRequest,
  requestNativeContextMenu,
  routeNativeCommand,
  subscribeNativeCommands
} from "./native-commands.js";

const AGENTS = [
  { id: "seth", initials: "S", name: "Seth Database Alpha Lite", creator: "Seth" },
  { id: "maya", initials: "M", name: "Signal Resume Review", creator: "Maya Chen" }
];
const PERSISTENCE_FIXTURE = import.meta.env.VITE_HATCH_DESKTOP_PREVIEW_PERSISTENCE === "1";

/**
 * A development-only visual/UAT fixture. It deliberately uses the production
 * DesktopWindowShell rather than a screenshot mock, so native resize and
 * title-bar behavior can be checked without a real account or model run.
 */
export function DesktopPreview() {
  const [previewConversationId] = useState(
    () => conversationIdFromLocation() || "conv_preview_database_tools"
  );
  const openPreviewConversationWindow = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) return;
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await invoke("open_conversation_window", {
      conversationId: `conv_preview_${suffix}`
    });
  }, []);

  useEffect(() => {
    const title = `Hatch · Preview · ${previewConversationId}`;
    document.title = title;
    if (!window.__TAURI_INTERNALS__) return undefined;
    const previewTier = String(import.meta.env.VITE_HATCH_DESKTOP_PREVIEW_TIER || "")
      .trim()
      .toLowerCase();
    const previewSize = {
      regular: { width: 1180, height: 780 },
      compact: { width: 860, height: 600 },
      minimal: { width: 640, height: 600 }
    }[previewTier];
    const current = getCurrentWindow();
    void current.setTitle(title);
    if (previewSize) {
      // This is a development-only sizing harness that drives the real native
      // window. It deliberately lives outside the product shell, so captures
      // do not need fake in-page tier buttons or viewport CSS tricks.
      void current.setSize(new LogicalSize(previewSize.width, previewSize.height));
    }
    void current.setFocus();
    return undefined;
  }, [previewConversationId]);
  const [sidebarPreference, setSidebarPreference] = useState("open");
  const [inspectorPreference, setInspectorPreference] = useState("open");
  const [sidebarWidth, setSidebarWidth] = useState(DESKTOP_LAYOUT.sidebar.default);
  const [inspectorWidth, setInspectorWidth] = useState(DESKTOP_LAYOUT.inspector.default);
  const [applicationZoom, setApplicationZoom] = useState(DESKTOP_ZOOM.default);
  const [selectedAgent, setSelectedAgent] = useState(AGENTS[0]);
  const [workspaceGrant, setWorkspaceGrant] = useState(null);
  const [previewStatus, setPreviewStatus] = useState("");
  const [composerDraft, setComposerDraft] = useState("");
  const [previewSettingsReady, setPreviewSettingsReady] = useState(false);
  const previewContextRef = useRef({ conversationId: previewConversationId });
  const previewViewportRef = useRef(null);
  const previewScrollTopRef = useRef(0);
  const previewDraftTimerRef = useRef(null);
  const previewScrollTimerRef = useRef(null);

  const patchPreviewContext = useCallback((patch = {}) => {
    const next = {
      ...previewContextRef.current,
      ...patch,
      conversationId: previewConversationId
    };
    previewContextRef.current = next;
    if (window.__TAURI_INTERNALS__) {
      void invoke("patch_window_settings", { patch: { context: next } }).catch(() => {});
    }
  }, [previewConversationId]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) {
      setPreviewSettingsReady(true);
      return undefined;
    }
    let cancelled = false;
    void invoke("read_window_settings").then((saved) => {
      if (cancelled) return;
      const layout = normalizeWindowLayoutPreferences(saved?.layout);
      setSidebarPreference(layout.sidebarPreference);
      setSidebarWidth(layout.sidebarWidth);
      setInspectorPreference(layout.inspectorPreference);
      setInspectorWidth(layout.inspectorWidth);
      setApplicationZoom(layout.zoom);

      const context = normalizePreviewWindowContext(saved?.context);
      previewContextRef.current = { ...context, conversationId: previewConversationId };
      setComposerDraft(context.composerDraft);
      previewScrollTopRef.current = context.scrollTop;
      if (context.selectedAgentId) {
        const restoredAgent = AGENTS.find((agent) => agent.id === context.selectedAgentId);
        if (restoredAgent) setSelectedAgent(restoredAgent);
      }
      if (context.workspaceGrant) setWorkspaceGrant(context.workspaceGrant);
      setPreviewSettingsReady(true);
    }).catch(() => {
      if (!cancelled) setPreviewSettingsReady(true);
    });
    return () => { cancelled = true; };
  }, [previewConversationId]);

  useEffect(() => {
    if (!previewSettingsReady || !window.__TAURI_INTERNALS__) return undefined;
    void invoke("patch_window_settings", {
      patch: {
        layout: {
          sidebarPreference,
          sidebarWidth,
          inspectorPreference,
          inspectorWidth,
          zoom: applicationZoom
        }
      }
    }).catch(() => {});
    return undefined;
  }, [applicationZoom, inspectorPreference, inspectorWidth, previewSettingsReady, sidebarPreference, sidebarWidth]);

  useEffect(() => {
    if (!previewSettingsReady) return undefined;
    window.clearTimeout(previewDraftTimerRef.current);
    previewDraftTimerRef.current = window.setTimeout(() => {
      previewDraftTimerRef.current = null;
      patchPreviewContext({ composerDraft });
    }, 180);
    return () => window.clearTimeout(previewDraftTimerRef.current);
  }, [composerDraft, patchPreviewContext, previewSettingsReady]);

  useEffect(() => {
    if (!previewSettingsReady) return undefined;
    patchPreviewContext({ selectedAgentId: selectedAgent.id });
    return undefined;
  }, [patchPreviewContext, previewSettingsReady, selectedAgent.id]);

  useEffect(() => {
    if (!previewSettingsReady) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (previewViewportRef.current) {
        previewViewportRef.current.scrollTop = previewScrollTopRef.current;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previewConversationId, previewSettingsReady]);

  const handlePreviewScroll = useCallback((event) => {
    previewScrollTopRef.current = Math.max(0, Number(event.currentTarget?.scrollTop) || 0);
    if (!previewSettingsReady) return;
    window.clearTimeout(previewScrollTimerRef.current);
    previewScrollTimerRef.current = window.setTimeout(() => {
      previewScrollTimerRef.current = null;
      patchPreviewContext({ scrollTop: previewScrollTopRef.current });
    }, 180);
  }, [patchPreviewContext, previewSettingsReady]);

  const choosePreviewWorkspace = useCallback(async () => {
    if (!window.__TAURI_INTERNALS__) {
      setPreviewStatus("Native workspace picker is available in the packaged preview.");
      return;
    }
    try {
      const grant = await invoke("pick_workspace_folder");
      if (!grant) {
        setPreviewStatus("Workspace selection canceled.");
        return;
      }
      setWorkspaceGrant(grant);
      patchPreviewContext({ workspaceGrant: grant });
      setPreviewStatus(`Workspace granted: ${grant.display_path || grant.grant_id}`);
    } catch (error) {
      setPreviewStatus(`Workspace selection failed: ${String(error?.message || error)}`);
    }
  }, [patchPreviewContext]);

  const openPreviewArtifact = useCallback(async (target, command) => {
    setPreviewStatus(`Artifact action requested: ${String(target || "(missing target)")}`);
    const relativePath = previewArtifactRelativePath(target);
    if (!workspaceGrant?.grant_id || !relativePath) {
      setPreviewStatus("Choose a workspace before opening this artifact.");
      return;
    }
    try {
      await invoke(command, {
        request: {
          workspaceGrantId: workspaceGrant.grant_id,
          relativePath
        }
      });
      setPreviewStatus(command === "reveal_workspace_artifact"
        ? "Artifact revealed in the native file browser."
        : "Artifact opened in the native preview.");
    } catch (error) {
      setPreviewStatus(`Artifact action failed: ${String(error?.message || error)}`);
    }
  }, [workspaceGrant]);

  const handleNativePreviewCommand = useCallback((payload) => {
    void routeNativeCommand(payload, {
      onNewConversationWindow: openPreviewConversationWindow,
      onChooseWorkspace: choosePreviewWorkspace,
      onToggleSidebar: () => setSidebarPreference((current) => current === "open" ? "closed" : "open"),
      onToggleInspector: () => setInspectorPreference((current) => current === "open" ? "closed" : "open"),
      onZoomIn: () => setApplicationZoom((current) => nextZoom(current, "increase")),
      onZoomOut: () => setApplicationZoom((current) => nextZoom(current, "decrease")),
      onZoomReset: () => setApplicationZoom(DESKTOP_ZOOM.default),
      onRevealArtifact: (target) => openPreviewArtifact(target, "reveal_workspace_artifact"),
      onQuickLookArtifact: (target) => openPreviewArtifact(target, "open_workspace_artifact")
    });
  }, [choosePreviewWorkspace, openPreviewArtifact, openPreviewConversationWindow]);

  // The preview is a real native-window fixture, so application zoom must use
  // the same WebView zoom bridge as the product shell. This makes the 80–200%
  // overflow and collapse captures exercise production behavior instead of a
  // CSS-only mock. Zoom remains per native window and never changes the OS
  // frame size.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    void getCurrentWebview().setZoom(applicationZoom).catch(() => {});
    return undefined;
  }, [applicationZoom]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (!["=", "+", "-", "0"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "0") setApplicationZoom(DESKTOP_ZOOM.default);
      else setApplicationZoom((current) => nextZoom(current, event.key === "-" ? "decrease" : "increase"));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const showPreviewContextMenu = useCallback((event, request) => {
    const intercepted = requestNativeContextMenu({
      event,
      request: nativeContextRequest(event, request?.kind, request?.target),
      invokeImpl: invoke,
      packaged: Boolean(window.__TAURI_INTERNALS__)
    });
    return intercepted;
  }, []);

  const showPreviewCommandMenu = useCallback((event) => {
    if (!window.__TAURI_INTERNALS__) return;
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    const position = rect
      ? { x: Number(rect.right), y: Number(rect.bottom) }
      : null;
    void invoke("show_native_command_menu", {
      request: position ? { position } : { position: null }
    }).catch(() => setPreviewStatus("Native command menu could not be opened."));
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    return subscribeNativeCommands({
      listenImpl: listen,
      onCommand: handleNativePreviewCommand,
      onError: () => {}
    });
  }, [handleNativePreviewCommand]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    void invoke("set_native_command_state", {
      state: {
        newConversationEnabled: true,
        newWindowEnabled: true,
        workspaceEnabled: true,
        settingsEnabled: true,
        runStopEnabled: false,
        sidebarVisible: sidebarPreference === "open",
        inspectorVisible: inspectorPreference === "open"
      }
    }).catch(() => {});
  }, [inspectorPreference, sidebarPreference]);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    const suppressProductContextMenu = (event) => {
      if (!isEditableContextTarget(event.target)) event.preventDefault();
    };
    document.addEventListener("contextmenu", suppressProductContextMenu, true);
    return () => document.removeEventListener("contextmenu", suppressProductContextMenu, true);
  }, []);

  return (
    <DesktopWindowShell
      sidebarPreference={sidebarPreference}
      inspectorPreference={inspectorPreference}
      sidebarWidth={sidebarWidth}
      inspectorWidth={inspectorWidth}
      onSidebarPreferenceChange={setSidebarPreference}
      onInspectorPreferenceChange={setInspectorPreference}
      onSidebarWidthChange={setSidebarWidth}
      onInspectorWidthChange={setInspectorWidth}
      onShowOverflow={showPreviewCommandMenu}
      sidebar={<PreviewSidebar selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} onContextMenu={showPreviewContextMenu} conversationId={previewConversationId} onOpenConversationWindow={openPreviewConversationWindow} />}
      toolbar={<PreviewToolbar selectedAgent={selectedAgent} conversationId={previewConversationId} onOpenConversationWindow={openPreviewConversationWindow} />}
      inspector={(
        <PreviewInspector
          selectedAgent={selectedAgent}
          workspaceGrant={workspaceGrant}
          previewStatus={previewStatus}
          onChooseWorkspace={choosePreviewWorkspace}
        />
      )}
    >
      <section className="chat-shell desktop-chat-shell preview-chat-shell">
        <div className="thread-root">
          <div ref={previewViewportRef} className="thread-viewport preview-thread-viewport" onScroll={handlePreviewScroll}>
            <article className="chat-message user">
              <div className="message-surface user"><p className="plain-text">请检查这些数据库工具，并说明哪一个适合关键词搜索。</p></div>
            </article>
            <article className="chat-message assistant">
              <div className="run-summary"><span className="activity-dot done" />Answered · 8s</div>
              <div className="message-surface assistant">
                <div className="markdown-container">
                  <div className="markdown-body">
                    <p>我比较了当前可用工具。保留表格结构；如果窗口变窄，只在此处横向滚动。</p>
                    <div className="markdown-table-scroll" tabIndex={0} aria-label="Scrollable database tool comparison">
                      <table>
                        <thead><tr><th>Tool</th><th>Status</th><th>Notes</th></tr></thead>
                        <tbody>
                          <tr><td><code>creator_seth_search_company</code></td><td>✅ Ready</td><td>支持按名称和关键词搜索，返回公司列表及 ticker。</td></tr>
                          <tr><td><code>creator_seth_company_detail</code></td><td>✅ Ready</td><td>返回公司身份、上市信息、交易所等资料。</td></tr>
                        </tbody>
                      </table>
                    </div>
                    <p>推荐先用 <code>creator_seth_search_company</code>。长 identifier 不应被逐字符拆开。</p>
                    <pre onContextMenu={(event) => showPreviewContextMenu(event, { kind: "artifact", target: "docs/spec-desktop-ui-construction-v1.md" })}><code>{"SELECT symbol, name\nFROM companies\nWHERE name ILIKE '%hatch%';"}</code></pre>
                    {PERSISTENCE_FIXTURE ? (
                      <div className="preview-persistence-notes" aria-label="Long conversation content for persistence UAT">
                        {Array.from({ length: 10 }, (_, index) => (
                          <p key={index}>Persistence fixture note {index + 1}: this content intentionally extends the conversation viewport so its scroll position can be restored per native window.</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          </div>
          <footer className="composer-footer">
            <div className="composer">
              <textarea
                className="composer-input"
                aria-label="Message preview agent"
                placeholder="Message Seth Database Alpha Lite"
                rows={1}
                value={composerDraft}
                onChange={(event) => setComposerDraft(event.target.value)}
              />
              <div className="composer-actions">
                <div className="composer-controls">
                  <div className="composer-settings">
                    <button type="button" className="composer-control workspace-composer-control"><span aria-hidden="true">⌘</span><span className="composer-control-label">database-workspace</span><span className="composer-control-caret">⌄</span></button>
                    <button type="button" className="composer-control"><span aria-hidden="true">◈</span><span className="composer-control-label">Ask before changes</span><span className="composer-control-caret">⌄</span></button>
                  </div>
                  <details className="composer-overflow"><summary className="composer-control composer-overflow-trigger" aria-label="More composer options">•••</summary><div className="composer-overflow-menu">Workspace and permission controls</div></details>
                </div>
                <button type="button" className="send-button">Send</button>
              </div>
            </div>
          </footer>
        </div>
      </section>
    </DesktopWindowShell>
  );
}

export function previewArtifactRelativePath(target) {
  const value = String(target || "").trim().replaceAll("\\", "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return "";
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) return "";
  return parts.join("/");
}

export function normalizePreviewWindowContext(value) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const workspace = candidate.workspaceGrant;
  const workspaceGrant = workspace && typeof workspace === "object" && !Array.isArray(workspace)
    ? (() => {
      const grantId = String(workspace.grant_id ?? workspace.grantId ?? "").trim();
      if (!grantId) return null;
      return {
        grant_id: grantId,
        display_path: String(workspace.display_path ?? workspace.displayPath ?? "").trim()
      };
    })()
    : null;
  const scrollTop = Number(candidate.scrollTop);
  return {
    composerDraft: typeof candidate.composerDraft === "string" ? candidate.composerDraft : "",
    scrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
    selectedAgentId: typeof candidate.selectedAgentId === "string" ? candidate.selectedAgentId.trim() : "",
    workspaceGrant
  };
}

function PreviewSidebar({ selectedAgent, onSelectAgent, onContextMenu, conversationId, onOpenConversationWindow }) {
  return (
    <div className="desktop-sidebar-content">
      <div className="desktop-sidebar-heading"><span className="hatch-wordmark">Hatch</span><button className="sidebar-new-conversation" type="button" onClick={onOpenConversationWindow} aria-label="Open preview conversation in a new window"><span>+</span><span>New window</span></button></div>
      <nav className="desktop-source-list" aria-label="Creator Agents">
        <div className="desktop-source-list-label">Your agents</div>
        {AGENTS.map((agent) => (
          <button key={agent.id} type="button" className={`desktop-source-row agent ${agent.id === selectedAgent.id ? "selected" : ""}`} onClick={() => onSelectAgent(agent)}>
            <span className="creator-avatar">{agent.initials}</span><span className="desktop-source-row-copy"><strong>{agent.name}</strong><small>by {agent.creator}</small></span>
          </button>
        ))}
        <div className="desktop-source-list-label conversations-label">Conversations</div>
        <button type="button" className="desktop-source-row conversation selected" onContextMenu={(event) => onContextMenu?.(event, { kind: "conversation", target: conversationId })}><span className="conversation-row-glyph">⌁</span><span className="desktop-source-row-copy"><strong>Database tooling review</strong><small>{conversationId}</small></span></button>
      </nav>
      <div className="desktop-sidebar-footer"><span className="avatar">SU</span><span className="desktop-sidebar-account"><strong>Seth UAT</strong><small>Signed in</small></span><button type="button" className="profile-sign-out">Sign out</button></div>
    </div>
  );
}

function PreviewToolbar({ selectedAgent, conversationId, onOpenConversationWindow }) {
  return (
    <div className="desktop-toolbar-context">
      <div className="desktop-toolbar-title"><span className="label">Conversation</span><strong>Database tooling review</strong><small>{conversationId}</small></div>
      <span className="desktop-toolbar-separator" />
      <div className="desktop-toolbar-agent"><span className="label">Agent</span><strong>{selectedAgent.name}</strong></div>
      <button type="button" className="secondary compact preview-open-window" onClick={onOpenConversationWindow}>New window</button>
    </div>
  );
}

function PreviewInspector({ selectedAgent, workspaceGrant, previewStatus, onChooseWorkspace }) {
  return (
    <div className="desktop-inspector-content">
      <section className="inspector-section"><span className="inspector-kicker">Workspace</span><strong className="inspector-workspace-path" title={workspaceGrant?.display_path || "No workspace selected"}>{workspaceGrant?.display_path || "No workspace selected"}</strong><button type="button" className="secondary compact inspector-action" onClick={onChooseWorkspace}>{workspaceGrant ? "Change folder" : "Choose folder"}</button>{previewStatus ? <p role="status">{previewStatus}</p> : null}</section>
      <section className="inspector-section"><span className="inspector-kicker">Permissions</span><span className="inspector-select-control">◈ Ask before changes</span><p>Hatch asks before every file change and shell command.</p></section>
      <section className="inspector-section"><span className="inspector-kicker">Run</span><div className="inspector-run-state"><span className="activity-dot done" /><strong>Ready</strong></div></section>
      <section className="inspector-section"><span className="inspector-kicker">Creator Agent</span><strong>{selectedAgent.name}</strong><p>by {selectedAgent.creator}. The inspector remains an optional pane, never a squeezed card.</p></section>
    </div>
  );
}
