import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { nativeWindow, revealWhenPainted } from "../native/bridge.js";
import { subscribeNativeCommands } from "../native/commands.js";
import { useObservable } from "../observable.js";
import { DesktopContext } from "./context.js";
import { ConversationPane } from "./ConversationPane.jsx";
import { ChatWindow } from "./chat-window.js";
import { FindBar } from "./FindBar.jsx";
import { Library } from "./Library.jsx";
import { LibraryWindow } from "./library-window.js";
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

/** A Chat window: one Agent's conversations. */
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
  </div>;
}

/**
 * One native window: its controller (Library or Chat), hidden until signed
 * in and first painted. Native menu commands go to the focused window.
 */
function WindowApp({ create, View }) {
  const app = useMemo(create, []);
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
  return <DesktopContext.Provider value={context}><View /></DesktopContext.Provider>;
}

export const LibraryApp = () => <WindowApp create={() => new LibraryWindow()} View={Library} />;
export const ChatApp = () => <WindowApp create={() => new ChatWindow()} View={Shell} />;
