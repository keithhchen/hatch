import { isNative, nativeInvoke, onNativeEvent } from "./bridge.js";

/**
 * Renderer half of the native menu bar. Rust owns menus and accelerators and
 * sends only semantic command ids to the focused window; this module maps
 * them onto the window's handlers and projects the window's command state
 * (enablement, sidebar check, Agent names) back into the menu.
 */
export const NATIVE_COMMAND_EVENT = "hatch://command";

export const COMMAND = Object.freeze({
  NEW_CONVERSATION: "conversation.new",
  NEW_WINDOW: "conversation.newWindow",
  SEARCH: "conversation.search",
  FIND: "edit.find",
  RENAME: "conversation.rename",
  ARCHIVE: "conversation.archive",
  OPEN_WINDOW: "conversation.openWindow",
  PREVIOUS: "conversation.previous",
  NEXT: "conversation.next",
  TOGGLE_SIDEBAR: "sidebar.toggle",
  STOP: "run.stop",
  CHOOSE_WORKSPACE: "workspace.choose",
  SETTINGS: "settings.open",
  ZOOM_IN: "view.zoomIn",
  ZOOM_OUT: "view.zoomOut",
  ZOOM_RESET: "view.zoomReset"
});

const KNOWN = new Set(Object.values(COMMAND));
const AGENT_COMMAND = /^agent\.select\.([1-9])$/;

/** @returns {{ id: string, agentIndex?: number } | null} */
export function parseNativeCommand(payload) {
  const id = typeof payload?.id === "string" ? payload.id : "";
  const agent = id.match(AGENT_COMMAND);
  if (agent) return { id: "agent.select", agentIndex: Number(agent[1]) - 1 };
  return KNOWN.has(id) ? { id } : null;
}

/** Route one command to `handlers[id]`; returns whether a handler ran. */
export function routeNativeCommand(payload, handlers) {
  const command = parseNativeCommand(payload);
  const handler = command && handlers[command.id];
  if (typeof handler !== "function") return false;
  handler(command.agentIndex);
  return true;
}

/** Subscribe to menu commands; `getHandlers` is read at dispatch time. */
export function subscribeNativeCommands(getHandlers) {
  return onNativeEvent(NATIVE_COMMAND_EVENT, payload => routeNativeCommand(payload, getHandlers()));
}

/** Project this window's command state into the native menu bar. */
export function publishCommandState(state) {
  if (!isNative()) return;
  void nativeInvoke("set_native_command_state", { state }).catch(() => {});
}
