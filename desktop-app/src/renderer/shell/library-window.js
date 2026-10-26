import { isNative, nativeInvoke, nativeWindow, onNativeEvent } from "../native/bridge.js";
import { publishCommandState } from "../native/commands.js";
import { normalizeProductOpenPayload, PRODUCT_OPEN_EVENT } from "../native/product-open.js";
import { LIBRARY_WINDOW_FRAME } from "../native/window-frame.js";
import { WindowController } from "./window-controller.js";

/** The Agent a `hatch://products/open` link names, if this account has it. */
export function agentForLink(agents, link) {
  return agents.find(agent => agent.productId === link.productId && (!link.entitlementId || agent.entitlementId === link.entitlementId)) ?? null;
}

/**
 * The Library window (`main`): opens at launch when signed in, lists my
 * Agents (owned + acquired) and opens each one's Chat window. Signed out it
 * stays hidden behind the welcome window. Closing it only hides it, so the
 * app, its Chat windows and the Dock reopen path keep working.
 */
export class LibraryWindow extends WindowController {
  constructor() {
    super({}, { frameConstraints: LIBRARY_WINDOW_FRAME });
  }

  async start() {
    this.disposers.push(
      onNativeEvent(PRODUCT_OPEN_EVENT, payload => void this.openProductLink(payload)),
      onNativeEvent("hatch://reopen", () => this.reopen()),
      nativeWindow.onCloseRequested(event => { event.preventDefault(); void nativeWindow.hide(); })
    );
    await super.start();
    if (isNative()) void nativeInvoke("read_product_open_links").then(links => this.openProductLink(links)).catch(() => {});
  }

  async onSessionChange() {
    const { phase } = this.session.getState();
    if (phase === "signed-out") {
      this.setState({ overlay: null });
      await nativeWindow.hide().catch(() => {});
      void nativeInvoke("open_welcome_window").catch(() => {});
      return;
    }
    nativeWindow.setTitle("Hatch");
    this.publishCommands();
  }

  /** Dock click with nothing visible, or Window › Library. */
  reopen() {
    if (this.session.getState().phase === "signed-in") void nativeInvoke("app_ready").catch(() => {});
    else void nativeInvoke("open_welcome_window").catch(() => {});
  }

  /** Deep link: open (or focus) that Agent's Chat window; refresh once if it is new. */
  async openProductLink(payload) {
    const link = normalizeProductOpenPayload(payload)[0];
    if (!link) return;
    let agent = agentForLink(this.agents, link);
    if (!agent) {
      await this.session.refresh();
      agent = agentForLink(this.agents, link);
    }
    this.openAgent(agent);
  }

  publishCommands() {
    publishCommandState({
      newConversationEnabled: false,
      workspaceEnabled: false,
      runStopEnabled: false,
      sidebarVisible: false,
      conversationEnabled: false,
      agents: this.menuAgents()
    });
  }
}
