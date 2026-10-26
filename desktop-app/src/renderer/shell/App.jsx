import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { nativeWindow, revealWhenPainted } from "../native/bridge.js";
import { subscribeNativeCommands } from "../native/commands.js";
import { useObservable } from "../observable.js";
import { DesktopContext } from "./context.js";
import { ConversationPane } from "./ConversationPane.jsx";
import { DesktopWindow } from "./desktop-window.js";
import { FindBar } from "./FindBar.jsx";
import { SearchPalette } from "./SearchPalette.jsx";
import { SettingsPanel } from "./SettingsPanel.jsx";
import { Sidebar } from "./Sidebar.jsx";
import { Toolbar } from "./Toolbar.jsx";

/**
 * Sidebar toggles animate with transforms only: the content box changes its
 * inset once, then slides from where it was (FLIP). No per-frame layout.
 */
function useSidebarSlide(contentRef, sidebarOpen, narrow) {
  const previous = useRef(sidebarOpen);
  useLayoutEffect(() => {
    const element = contentRef.current;
    const changed = previous.current !== sidebarOpen;
    previous.current = sidebarOpen;
    if (!element || !changed || narrow || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const width = Number.parseFloat(getComputedStyle(element.parentElement).getPropertyValue("--desk-sidebar-width")) || 0;
    element.style.transition = "none";
    element.style.transform = `translateX(${sidebarOpen ? -width : width}px)`;
    void element.offsetWidth;
    element.style.transition = "";
    element.style.transform = "";
  }, [contentRef, sidebarOpen, narrow]);
}

export function Shell() {
  const { app } = React.useContext(DesktopContext);
  const ui = useObservable(app);
  const contentRef = useRef(null);
  useSidebarSlide(contentRef, ui.sidebarOpen, ui.narrow);
  return <div className="desk" data-sidebar={ui.sidebarOpen ? "open" : "closed"} data-narrow={ui.narrow || undefined}>
    <Sidebar />
    {ui.narrow && ui.sidebarOpen ? <button type="button" className="desk-scrim" aria-hidden="true" tabIndex={-1} onClick={() => app.toggleSidebar()} /> : null}
    <div className="desk-content" ref={contentRef}>
      <Toolbar />
      <FindBar />
      <ConversationPane />
    </div>
    <SettingsPanel />
    <SearchPalette />
  </div>;
}

/** Main and conversation windows. Hidden until signed in and first painted. */
export function App() {
  const app = useMemo(() => new DesktopWindow(), []);
  const preferences = useObservable(app.preferences);
  const session = useObservable(app.session);
  const t = useMemo(() => app.preferences.t, [app, preferences.language]);
  useEffect(() => {
    void app.start();
    const stopCommands = subscribeNativeCommands(() => app.commandHandlers());
    return () => { stopCommands(); app.dispose(); };
  }, [app]);
  useEffect(() => { if (session.phase === "signed-in") revealWhenPainted(); }, [session.phase]);
  useEffect(() => { if (preferences.ready) void nativeWindow.setTheme(preferences.theme); }, [preferences.ready, preferences.theme]);
  const context = useMemo(() => ({ app, t }), [app, t]);
  if (session.phase !== "signed-in") return null;
  return <DesktopContext.Provider value={context}><Shell /></DesktopContext.Provider>;
}
