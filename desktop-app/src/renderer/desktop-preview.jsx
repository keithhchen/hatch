import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { DesktopWindowShell } from "./desktop-shell.jsx";
import { DESKTOP_LAYOUT } from "./desktop-layout.js";
import {
  isEditableContextTarget,
  nativeContextRequest,
  requestNativeContextMenu
} from "./native-commands.js";

const AGENTS = [
  { id: "seth", initials: "S", name: "Seth Database Alpha Lite", creator: "Seth" },
  { id: "maya", initials: "M", name: "Signal Resume Review", creator: "Maya Chen" }
];

/**
 * A development-only visual/UAT fixture. It deliberately uses the production
 * DesktopWindowShell rather than a screenshot mock, so native resize and
 * title-bar behavior can be checked without a real account or model run.
 */
export function DesktopPreview() {
  useEffect(() => {
    const title = "Hatch · Desktop Preview";
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
  }, []);
  const [sidebarPreference, setSidebarPreference] = useState("open");
  const [inspectorPreference, setInspectorPreference] = useState("open");
  const [sidebarWidth, setSidebarWidth] = useState(DESKTOP_LAYOUT.sidebar.default);
  const [inspectorWidth, setInspectorWidth] = useState(DESKTOP_LAYOUT.inspector.default);
  const [selectedAgent, setSelectedAgent] = useState(AGENTS[0]);
  const showPreviewContextMenu = useCallback((event, request) => {
    const intercepted = requestNativeContextMenu({
      event,
      request: nativeContextRequest(event, request?.kind, request?.target),
      invokeImpl: invoke,
      packaged: Boolean(window.__TAURI_INTERNALS__)
    });
    return intercepted;
  }, []);

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
      sidebar={<PreviewSidebar selectedAgent={selectedAgent} onSelectAgent={setSelectedAgent} onContextMenu={showPreviewContextMenu} />}
      toolbar={<PreviewToolbar selectedAgent={selectedAgent} />}
      inspector={<PreviewInspector selectedAgent={selectedAgent} />}
    >
      <section className="chat-shell desktop-chat-shell preview-chat-shell">
        <div className="thread-root">
          <div className="thread-viewport preview-thread-viewport">
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
                    <pre><code>{"SELECT symbol, name\nFROM companies\nWHERE name ILIKE '%hatch%';"}</code></pre>
                  </div>
                </div>
              </div>
            </article>
          </div>
          <footer className="composer-footer">
            <div className="composer">
              <textarea className="composer-input" aria-label="Message preview agent" placeholder="Message Seth Database Alpha Lite" rows={1} />
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

function PreviewSidebar({ selectedAgent, onSelectAgent, onContextMenu }) {
  return (
    <div className="desktop-sidebar-content">
      <div className="desktop-sidebar-heading"><span className="hatch-wordmark">Hatch</span><button className="sidebar-new-conversation" type="button"><span>+</span><span>New conversation</span></button></div>
      <nav className="desktop-source-list" aria-label="Creator Agents">
        <div className="desktop-source-list-label">Your agents</div>
        {AGENTS.map((agent) => (
          <button key={agent.id} type="button" className={`desktop-source-row agent ${agent.id === selectedAgent.id ? "selected" : ""}`} onClick={() => onSelectAgent(agent)}>
            <span className="creator-avatar">{agent.initials}</span><span className="desktop-source-row-copy"><strong>{agent.name}</strong><small>by {agent.creator}</small></span>
          </button>
        ))}
        <div className="desktop-source-list-label conversations-label">Conversations</div>
        <button type="button" className="desktop-source-row conversation selected" onContextMenu={(event) => onContextMenu?.(event, { kind: "conversation", target: "conv_preview_database_tools" })}><span className="conversation-row-glyph">⌁</span><span className="desktop-source-row-copy"><strong>Database tooling review</strong><small>Current conversation</small></span></button>
      </nav>
      <div className="desktop-sidebar-footer"><span className="avatar">SU</span><span className="desktop-sidebar-account"><strong>Seth UAT</strong><small>Signed in</small></span><button type="button" className="profile-sign-out">Sign out</button></div>
    </div>
  );
}

function PreviewToolbar({ selectedAgent }) {
  return (
    <div className="desktop-toolbar-context">
      <div className="desktop-toolbar-title"><span className="label">Conversation</span><strong>Database tooling review</strong></div>
      <span className="desktop-toolbar-separator" />
      <div className="desktop-toolbar-agent"><span className="label">Agent</span><strong>{selectedAgent.name}</strong></div>
    </div>
  );
}

function PreviewInspector({ selectedAgent }) {
  return (
    <div className="desktop-inspector-content">
      <section className="inspector-section"><span className="inspector-kicker">Workspace</span><strong className="inspector-workspace-path">database-workspace</strong><button type="button" className="secondary compact inspector-action">Change folder</button></section>
      <section className="inspector-section"><span className="inspector-kicker">Permissions</span><span className="inspector-select-control">◈ Ask before changes</span><p>Hatch asks before every file change and shell command.</p></section>
      <section className="inspector-section"><span className="inspector-kicker">Run</span><div className="inspector-run-state"><span className="activity-dot done" /><strong>Ready</strong></div></section>
      <section className="inspector-section"><span className="inspector-kicker">Creator Agent</span><strong>{selectedAgent.name}</strong><p>by {selectedAgent.creator}. The inspector remains an optional pane, never a squeezed card.</p></section>
    </div>
  );
}
