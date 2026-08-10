import React, { useEffect, useId, useRef, useState } from "react";
import {
  DESKTOP_LAYOUT,
  LAYOUT_TIERS,
  clampPaneWidth,
  layoutTierForWidth,
  nextPaneWidth,
  panePresentation,
  resetPaneWidth
} from "./desktop-layout.js";

export function DesktopWindowShell({
  sidebar,
  toolbar,
  children,
  inspector,
  sidebarPreference,
  inspectorPreference,
  sidebarWidth,
  inspectorWidth,
  onSidebarPreferenceChange,
  onInspectorPreferenceChange,
  onSidebarWidthChange,
  onInspectorWidthChange,
  onShowOverflow
}) {
  const shellRef = useRef(null);
  const sidebarToggleRef = useRef(null);
  const inspectorToggleRef = useRef(null);
  const [tier, setTier] = useState(() => initialTier());
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [inspectorOverlayOpen, setInspectorOverlayOpen] = useState(false);
  const sidebarId = useId();
  const inspectorId = useId();
  const sidebarMode = panePresentation({
    tier,
    pane: "sidebar",
    preference: sidebarPreference,
    overlayOpen: sidebarOverlayOpen
  });
  const inspectorMode = panePresentation({
    tier,
    pane: "inspector",
    preference: inspectorPreference,
    overlayOpen: inspectorOverlayOpen
  });
  const overlayActive = sidebarMode === "overlay" || inspectorMode === "overlay";

  useShellResize(shellRef, setTier);

  useEffect(() => {
    if (tier !== LAYOUT_TIERS.MINIMAL) setSidebarOverlayOpen(false);
    if (tier === LAYOUT_TIERS.REGULAR) setInspectorOverlayOpen(false);
  }, [tier]);

  const closeSidebarOverlay = () => {
    setSidebarOverlayOpen(false);
    queueMicrotask(() => sidebarToggleRef.current?.focus());
  };
  const closeInspectorOverlay = () => {
    setInspectorOverlayOpen(false);
    queueMicrotask(() => inspectorToggleRef.current?.focus());
  };

  const toggleSidebar = () => {
    if (sidebarMode === "overlay") {
      closeSidebarOverlay();
      return;
    }
    if (tier === LAYOUT_TIERS.MINIMAL) {
      if (sidebarPreference !== "open") onSidebarPreferenceChange("open");
      setSidebarOverlayOpen(true);
      return;
    }
    onSidebarPreferenceChange(sidebarPreference === "open" ? "closed" : "open");
  };
  const toggleInspector = () => {
    if (inspectorMode === "overlay") {
      closeInspectorOverlay();
      return;
    }
    if (tier !== LAYOUT_TIERS.REGULAR) {
      if (inspectorPreference !== "open") onInspectorPreferenceChange("open");
      setInspectorOverlayOpen(true);
      return;
    }
    onInspectorPreferenceChange(inspectorPreference === "open" ? "closed" : "open");
  };

  return (
    <main
      ref={shellRef}
      className="desktop-window-shell"
      data-layout={tier}
      data-sidebar={sidebarMode}
      data-inspector={inspectorMode}
      data-platform={platformName()}
      style={{
        "--desktop-sidebar-width": `${clampPaneWidth("sidebar", sidebarWidth)}px`,
        "--desktop-inspector-width": `${clampPaneWidth("inspector", inspectorWidth)}px`
      }}
    >
      <DesktopToolbar
        inert={overlayActive ? "" : undefined}
        aria-hidden={overlayActive || undefined}
        sidebarExpanded={sidebarMode !== "hidden"}
        sidebarControls={sidebarId}
        sidebarToggleRef={sidebarToggleRef}
        inspectorExpanded={inspectorMode !== "hidden"}
        inspectorControls={inspectorId}
        inspectorToggleRef={inspectorToggleRef}
        onToggleSidebar={toggleSidebar}
        onToggleInspector={toggleInspector}
        onShowOverflow={onShowOverflow}
      >
        {toolbar}
      </DesktopToolbar>

      {sidebarMode === "inline" ? (
        <aside className="desktop-sidebar" id={sidebarId} aria-label="Conversations" inert={overlayActive ? "" : undefined} aria-hidden={overlayActive || undefined}>
          {sidebar}
        </aside>
      ) : null}
      {sidebarMode === "inline" ? (
        <SplitDivider
          pane="sidebar"
          shellRef={shellRef}
          controls={sidebarId}
          value={sidebarWidth}
          onValueChange={onSidebarWidthChange}
          onToggle={() => onSidebarPreferenceChange("closed")}
        />
      ) : null}

      <section className="desktop-main" aria-label="Conversation" inert={overlayActive ? "" : undefined} aria-hidden={overlayActive || undefined}>
        {children}
      </section>

      {inspectorMode === "inline" ? (
        <SplitDivider
          pane="inspector"
          shellRef={shellRef}
          controls={inspectorId}
          value={inspectorWidth}
          onValueChange={onInspectorWidthChange}
          onToggle={() => onInspectorPreferenceChange("closed")}
        />
      ) : null}
      {inspectorMode === "inline" ? (
        <aside className="desktop-inspector" id={inspectorId} aria-label="Inspector" inert={overlayActive ? "" : undefined} aria-hidden={overlayActive || undefined}>
          {inspector}
        </aside>
      ) : null}

      {sidebarMode === "overlay" ? (
        <PaneOverlay
          id={sidebarId}
          kind="sidebar"
          label="Conversations"
          onClose={closeSidebarOverlay}
          returnFocusRef={sidebarToggleRef}
        >
          {sidebar}
        </PaneOverlay>
      ) : null}
      {inspectorMode === "overlay" ? (
        <PaneOverlay
          id={inspectorId}
          kind="inspector"
          label="Inspector"
          onClose={closeInspectorOverlay}
          returnFocusRef={inspectorToggleRef}
        >
          {inspector}
        </PaneOverlay>
      ) : null}
    </main>
  );
}

export function DesktopToolbar({
  inert,
  sidebarExpanded,
  sidebarControls,
  sidebarToggleRef,
  inspectorExpanded,
  inspectorControls,
  inspectorToggleRef,
  onToggleSidebar,
  onToggleInspector,
  onShowOverflow,
  children
}) {
  return (
    <header className="desktop-toolbar" inert={inert} aria-hidden={inert ? true : undefined}>
      <div className="desktop-titlebar-safe-area" data-tauri-drag-region />
      <button
        ref={sidebarToggleRef}
        className="chrome-icon-button sidebar-toggle"
        type="button"
        aria-controls={sidebarControls}
        aria-expanded={sidebarExpanded}
        aria-label={sidebarExpanded ? "Hide sidebar" : "Show sidebar"}
        title={sidebarExpanded ? "Hide Sidebar" : "Show Sidebar"}
        onClick={onToggleSidebar}
      >
        <SidebarIcon />
      </button>
      <div className="desktop-toolbar-content">{children}</div>
      <div className="desktop-toolbar-drag-region" data-tauri-drag-region />
      <button
        className="chrome-icon-button toolbar-overflow-toggle"
        type="button"
        aria-haspopup="menu"
        aria-label="More commands"
        title="More commands"
        onClick={onShowOverflow}
      >
        <span aria-hidden="true">•••</span>
      </button>
      <button
        ref={inspectorToggleRef}
        className="chrome-icon-button inspector-toggle"
        type="button"
        aria-controls={inspectorControls}
        aria-expanded={inspectorExpanded}
        aria-label={inspectorExpanded ? "Hide inspector" : "Show inspector"}
        title={inspectorExpanded ? "Hide Inspector" : "Show Inspector"}
        onClick={onToggleInspector}
      >
        <InspectorIcon />
      </button>
    </header>
  );
}

function SplitDivider({ pane, shellRef, controls, value, onValueChange, onToggle }) {
  const pointerStartRef = useRef(null);
  const paneConfig = DESKTOP_LAYOUT[pane];
  const label = pane === "sidebar" ? "Sidebar width" : "Inspector width";

  const commitPointer = (event) => {
    const start = pointerStartRef.current;
    if (!start) return;
    const delta = event.clientX - start.x;
    const next = pane === "sidebar" ? start.width + delta : start.width - delta;
    onValueChange(clampPaneWidth(pane, next));
  };

  const startPointer = (event) => {
    pointerStartRef.current = { x: event.clientX, width: clampPaneWidth(pane, value) };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  return (
    <div
      className={`desktop-split-divider ${pane}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls || shellRef.current?.id || undefined}
      aria-valuemin={paneConfig.min}
      aria-valuemax={paneConfig.max}
      aria-valuenow={clampPaneWidth(pane, value)}
      aria-valuetext={`${clampPaneWidth(pane, value)} pixels`}
      tabIndex={0}
      onPointerDown={startPointer}
      onPointerMove={commitPointer}
      onPointerUp={(event) => {
        commitPointer(event);
        pointerStartRef.current = null;
      }}
      onPointerCancel={() => { pointerStartRef.current = null; }}
      onDoubleClick={() => onValueChange(resetPaneWidth(pane))}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const decreases = pane === "sidebar" ? event.key === "ArrowLeft" : event.key === "ArrowRight";
          onValueChange(nextPaneWidth(pane, value, decreases ? "decrease" : "increase"));
        }
        if (event.key === "Home") {
          event.preventDefault();
          onValueChange(paneConfig.min);
        }
        if (event.key === "End") {
          event.preventDefault();
          onValueChange(paneConfig.max);
        }
        if (event.key === "Enter") {
          event.preventDefault();
          onToggle();
        }
      }}
    />
  );
}

function PaneOverlay({ id, kind, label, onClose, returnFocusRef, children }) {
  const paneRef = useRef(null);

  useEffect(() => {
    const root = paneRef.current;
    const firstFocusable = root?.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    firstFocusable?.focus();
  }, []);

  return (
    <div className={`desktop-pane-overlay ${kind}`} role="presentation">
      <button className="desktop-overlay-scrim" aria-label={`Close ${label}`} type="button" onClick={onClose} />
      <aside
        ref={paneRef}
        className="desktop-overlay-pane"
        id={id}
        aria-label={label}
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...(paneRef.current?.querySelectorAll(
            "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
          ) ?? [])].filter((element) => element.getAttribute("aria-hidden") !== "true");
          if (focusable.length === 0) {
            event.preventDefault();
            paneRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="desktop-overlay-heading">
          <strong>{label}</strong>
          <button className="chrome-icon-button" type="button" onClick={onClose} aria-label={`Close ${label}`}>
            <CloseIcon />
          </button>
        </div>
        {children}
      </aside>
    </div>
  );
}

function useShellResize(shellRef, setTier) {
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const update = (width) => {
      setTier((previous) => {
        const next = layoutTierForWidth(width, previous);
        return next === previous ? previous : next;
      });
    };
    update(shell.clientWidth || window.innerWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect?.width;
      if (Number.isFinite(width)) update(width);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellRef, setTier]);
}

function initialTier() {
  return typeof window === "undefined"
    ? LAYOUT_TIERS.REGULAR
    : layoutTierForWidth(window.innerWidth);
}

function platformName() {
  const platform = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  return "other";
}

function SidebarIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect x="1.25" y="1.25" width="13.5" height="13.5" rx="1.5" />
      <path d="M5.5 1.75v12.5" />
    </svg>
  );
}

function InspectorIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <rect x="1.25" y="1.25" width="13.5" height="13.5" rx="1.5" />
      <path d="M10.5 1.75v12.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}
