import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { availableMonitors, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { RegistryAccountClient, NativeTokenStore } from "../auth/account.js";
import { DesktopSession } from "../auth/desktop-session.js";
import { EXPLORE_URL } from "../config.js";
import { currentWindowLabel, emitNativeEvent, isNative, nativeInvoke, onNativeEvent, openInBrowser } from "../native/bridge.js";
import { COMMAND } from "../native/commands.js";
import { restoreAndTrackFrame } from "../native/window-frame.js";
import { Observable } from "../observable.js";
import { DESKTOP_ZOOM, nextZoom, normalizeZoom } from "./layout.js";
import { AppPreferences } from "./preferences.js";

export const AUTH_SESSION_EVENT = "hatch://auth-session";
/** A Chat window painted its first frame: `{ key }` is its Agent's access key. */
export const AGENT_WINDOW_READY_EVENT = "hatch://agent-window-ready";
const AGENT_WINDOW_READY_TIMEOUT_MS = 10_000;

/** The native window that shows an Agent's conversations (one per Agent). */
export function openAgentWindow(agent, invoke = nativeInvoke) {
  return invoke("open_agent_window", agent.binding);
}

/**
 * What every Hatch window shares: the account session, app preferences,
 * zoom, saved frame, the settings sheet and the app-level native commands.
 * The Library and Chat windows extend it with their own state and commands.
 */
export class WindowController extends Observable {
  constructor(initial = {}, { frameConstraints } = {}) {
    super({ zoom: DESKTOP_ZOOM.default, overlay: null, version: "", ...initial });
    this.label = currentWindowLabel();
    this.frameConstraints = frameConstraints;
    this.invoke = nativeInvoke;
    this.preferences = new AppPreferences({ invoke: nativeInvoke, emit: emitNativeEvent, onEvent: onNativeEvent });
    this.session = new DesktopSession({ tokens: new NativeTokenStore(nativeInvoke), accounts: new RegistryAccountClient() });
    this.savedWindow = {};
    this.disposers = [];
  }

  get agents() {
    return this.session.getState().agents;
  }

  async start() {
    this.disposers.push(
      this.session.subscribe(() => void this.onSessionChange()),
      onNativeEvent(AUTH_SESSION_EVENT, payload => this.onAuthEvent(payload))
    );
    const refresh = () => { if (document.visibilityState === "visible") void this.session.refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    this.disposers.push(() => { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); });
    const version = isNative() ? await getVersion().catch(() => "") : "";
    this.setState({ version });
    await Promise.all([this.preferences.load(), this.restoreWindowLayout()]);
    await this.session.launch();
  }

  dispose() {
    for (const dispose of this.disposers) dispose();
  }

  /** This window's saved frame and zoom; the frame is per window label. */
  async restoreWindowLayout() {
    if (!isNative()) return;
    try {
      const saved = await nativeInvoke("read_window_settings");
      this.savedWindow = saved ?? {};
      const stopFrame = await restoreAndTrackFrame({ invoke: nativeInvoke, savedFrame: saved?.frame, constraints: this.frameConstraints, appWindow: getCurrentWindow(), availableMonitors, PhysicalPosition, PhysicalSize });
      this.disposers.push(stopFrame);
      const zoom = normalizeZoom(saved?.layout?.zoom);
      this.setState({ zoom });
      this.applyZoom(zoom);
      this.restoredLayout(saved?.layout ?? {});
    } catch {
      this.savedWindow = {};
    }
  }

  /** Subclass hook for the rest of the saved layout. */
  restoredLayout() {}

  async onSessionChange() {}

  onAuthEvent(payload) {
    if (payload?.kind === "signed-in") void this.session.launch();
    if (payload?.kind === "cleared" && payload.sourceWindow !== this.label && this.session.getState().token) this.session.toSignedOut();
  }

  setZoom(zoom) {
    const next = normalizeZoom(zoom);
    this.setState({ zoom: next });
    this.applyZoom(next);
    if (isNative()) void nativeInvoke("patch_window_settings", { patch: { layout: { zoom: next } } }).catch(() => {});
  }

  applyZoom(zoom) {
    if (isNative()) void getCurrentWebview().setZoom(zoom).catch(() => {});
    else document.documentElement.style.zoom = String(zoom);
  }

  openOverlay(overlay) {
    this.setState({ overlay });
  }

  closeOverlay() {
    this.setState({ overlay: null });
  }

  /** Open an allowlisted Hatch web page; a refusal or failure shows a dismissible notice. */
  openWeb(url) {
    this.setState({ browseError: false });
    return Promise.resolve().then(() => openInBrowser(url)).catch(error => {
      console.error("[hatch:open-web]", url, error);
      this.setState({ browseError: true });
    });
  }

  dismissBrowseError() {
    this.setState({ browseError: false });
  }

  browseAgents() {
    void this.openWeb(EXPLORE_URL);
  }

  /** Open (or focus) an Agent's Chat window. */
  openAgent(agent) {
    if (agent) void openAgentWindow(agent).catch(() => {});
  }

  /**
   * Open an Agent's Chat window and resolve once it is on screen: at once for
   * a window that was already open, otherwise when the new window paints.
   */
  async openAgentUntilShown(agent) {
    let stop = () => {};
    const painted = new Promise(resolve => {
      const timer = setTimeout(resolve, AGENT_WINDOW_READY_TIMEOUT_MS);
      const unlisten = onNativeEvent(AGENT_WINDOW_READY_EVENT, payload => { if (payload?.key === agent.key) resolve(); });
      stop = () => { clearTimeout(timer); unlisten(); };
    });
    try {
      const opened = await openAgentWindow(agent);
      if (!opened?.reused) await painted;
    } finally {
      stop();
    }
  }

  /** Sign out here and tell every other Hatch window. */
  async signOut() {
    this.setState({ overlay: null });
    await this.session.signOut();
    void emitNativeEvent(AUTH_SESSION_EVENT, { kind: "cleared", sourceWindow: this.label });
  }

  /** Commands every window answers: settings and zoom. */
  commandHandlers() {
    return {
      [COMMAND.SETTINGS]: () => this.openOverlay("settings"),
      [COMMAND.ZOOM_IN]: () => this.setZoom(nextZoom(this.state.zoom, "increase")),
      [COMMAND.ZOOM_OUT]: () => this.setZoom(nextZoom(this.state.zoom, "decrease")),
      [COMMAND.ZOOM_RESET]: () => this.setZoom(DESKTOP_ZOOM.default)
    };
  }
}
