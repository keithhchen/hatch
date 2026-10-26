import React from "react";
import { createRoot } from "react-dom/client";
import "@hatch/ui/theme.css";
import { HatchUIProvider } from "@hatch/ui";
import { PLATFORM } from "./config.js";
import { isNative } from "./native/bridge.js";
import { installNativeContextMenus } from "./native/context-menu.js";
import { App } from "./shell/App.jsx";
import { WelcomeWindow } from "./shell/WelcomeWindow.jsx";
import "./styles.css";

class RendererErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[hatch:renderer-error]", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="desk-crash" role="alert">
      <h1>Hatch couldn’t open this window</h1>
      <p>Reopen the window. Your conversations are saved.</p>
      <pre className="selectable">{String(this.state.error?.message ?? this.state.error)}</pre>
    </main>;
  }
}

const root = document.documentElement;
root.dataset.platform = PLATFORM;
if (isNative()) root.dataset.native = "";
installNativeContextMenus();

const welcome = new URLSearchParams(location.search).get("window") === "welcome";
createRoot(document.getElementById("root")).render(
  <RendererErrorBoundary>
    <HatchUIProvider className="desk-root">
      {welcome ? <WelcomeWindow /> : <App />}
    </HatchUIProvider>
  </RendererErrorBoundary>
);
