/**
 * Renderer half of Hatch's native command bridge.
 *
 * Rust owns menus, keyboard accelerators, window lifecycle, and native context
 * menus. This module intentionally carries only semantic command IDs into the
 * renderer, where the active window can perform the corresponding product
 * action without exposing DOM state to the native layer.
 */

export const NATIVE_COMMAND_EVENT = "hatch://command";

export const NATIVE_COMMAND = Object.freeze({
  CONVERSATION_NEW: "conversation.new",
  CONVERSATION_NEW_WINDOW: "conversation.newWindow",
  CONVERSATION_OPEN_WINDOW: "conversation.openWindow",
  CONVERSATION_RENAME: "conversation.rename",
  CONVERSATION_ARCHIVE: "conversation.archive",
  SIDEBAR_TOGGLE: "sidebar.toggle",
  INSPECTOR_TOGGLE: "inspector.toggle",
  RUN_STOP: "run.stop",
  VIEW_ZOOM_IN: "view.zoomIn",
  VIEW_ZOOM_OUT: "view.zoomOut",
  VIEW_ZOOM_RESET: "view.zoomReset",
  WORKSPACE_CHOOSE: "workspace.choose",
  SETTINGS_OPEN: "settings.open",
  ABOUT_OPEN: "about.open",
  ARTIFACT_REVEAL: "artifact.reveal",
  ARTIFACT_QUICK_LOOK: "artifact.quickLook",
  ARTIFACT_COPY_PATH: "artifact.copyPath",
  TOOL_COPY_OUTPUT: "tool.copyOutput"
});

const MAX_CONVERSATION_ID_BYTES = 256;
const CONTEXT_KINDS = new Set(["conversation", "artifact", "tool-result"]);

/**
 * Reject arbitrary event payloads before they reach application handlers.
 * Native command events are not authorization, but keeping this boundary
 * narrow makes accidental third-party event use harmless.
 */
export function parseNativeCommand(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!Object.values(NATIVE_COMMAND).includes(id)) return null;
  const target = typeof payload.target === "string" && payload.target.trim()
    ? payload.target.trim()
    : undefined;
  const context = typeof payload.context === "string" && CONTEXT_KINDS.has(payload.context)
    ? payload.context
    : undefined;
  const source = typeof payload.source === "string" ? payload.source : "native";
  return Object.freeze({ id, source, context, target });
}

/**
 * Route one native semantic command. Handlers may be sync or async; unknown
 * commands are a safe no-op, which lets a newer native shell coexist with an
 * older renderer during an app update.
 */
export async function routeNativeCommand(payload, handlers = {}) {
  const command = parseNativeCommand(payload);
  if (!command) return false;

  const handler = commandHandlerFor(command.id, handlers);
  if (typeof handler !== "function") return false;
  await handler(command.target, command);
  return true;
}

function commandHandlerFor(commandId, handlers) {
  switch (commandId) {
    case NATIVE_COMMAND.CONVERSATION_NEW:
      return handlers.onNewConversation;
    case NATIVE_COMMAND.CONVERSATION_NEW_WINDOW:
      return handlers.onNewConversationWindow;
    case NATIVE_COMMAND.CONVERSATION_OPEN_WINDOW:
      return handlers.onOpenConversationWindow;
    case NATIVE_COMMAND.CONVERSATION_RENAME:
      return handlers.onRenameConversation;
    case NATIVE_COMMAND.CONVERSATION_ARCHIVE:
      return handlers.onArchiveConversation;
    case NATIVE_COMMAND.SIDEBAR_TOGGLE:
      return handlers.onToggleSidebar;
    case NATIVE_COMMAND.INSPECTOR_TOGGLE:
      return handlers.onToggleInspector;
    case NATIVE_COMMAND.RUN_STOP:
      return handlers.onStopRun;
    case NATIVE_COMMAND.VIEW_ZOOM_IN:
      return handlers.onZoomIn;
    case NATIVE_COMMAND.VIEW_ZOOM_OUT:
      return handlers.onZoomOut;
    case NATIVE_COMMAND.VIEW_ZOOM_RESET:
      return handlers.onZoomReset;
    case NATIVE_COMMAND.WORKSPACE_CHOOSE:
      return handlers.onChooseWorkspace;
    case NATIVE_COMMAND.SETTINGS_OPEN:
      return handlers.onOpenSettings;
    case NATIVE_COMMAND.ABOUT_OPEN:
      return handlers.onOpenAbout;
    case NATIVE_COMMAND.ARTIFACT_REVEAL:
      return handlers.onRevealArtifact;
    case NATIVE_COMMAND.ARTIFACT_QUICK_LOOK:
      return handlers.onQuickLookArtifact;
    case NATIVE_COMMAND.ARTIFACT_COPY_PATH:
      return handlers.onCopyArtifactPath;
    case NATIVE_COMMAND.TOOL_COPY_OUTPUT:
      return handlers.onCopyToolOutput;
    default:
      return undefined;
  }
}

/**
 * Register exactly one Tauri event listener. `listen` resolves asynchronously,
 * so the cleanup also handles a React unmount which happens before native
 * registration completes.
 */
export function subscribeNativeCommands({
  listenImpl,
  onCommand,
  onError = () => {},
  eventName = NATIVE_COMMAND_EVENT
} = {}) {
  if (typeof listenImpl !== "function" || typeof onCommand !== "function") {
    return () => {};
  }

  let disposed = false;
  let unlisten = null;
  Promise.resolve(listenImpl(eventName, (event) => {
    if (!disposed) onCommand(event?.payload);
  })).then((nextUnlisten) => {
    if (typeof nextUnlisten !== "function") return;
    if (disposed) {
      void nextUnlisten();
      return;
    }
    unlisten = nextUnlisten;
  }).catch(onError);

  return () => {
    disposed = true;
    if (typeof unlisten === "function") void unlisten();
  };
}

/**
 * Build a bounded URL-provided conversation id for a second native window.
 * This mirrors the native validation before it becomes React state.
 */
export function conversationIdFromLocation(locationLike = globalThis.location) {
  const search = typeof locationLike?.search === "string" ? locationLike.search : "";
  const value = new URLSearchParams(search).get("conversation_id");
  return normalizeConversationId(value);
}

/**
 * Normalize the non-secret account/Agent binding carried by a secondary
 * window URL or native window context. These values are routing hints only;
 * the renderer must still match them against the signed-in entitlement list
 * and the Runtime must re-authorize every request.
 */
export function normalizeConversationBinding(value = {}) {
  const entitlementId = normalizeConversationId(value?.entitlementId ?? value?.entitlement_id);
  const creatorId = normalizeConversationId(value?.creatorId ?? value?.creator_id);
  const agentId = normalizeConversationId(value?.agentId ?? value?.agent_id);
  if (!entitlementId && !creatorId && !agentId) return null;
  if (!entitlementId || !creatorId || !agentId) return null;
  return Object.freeze({ entitlementId, creatorId, agentId });
}

export function conversationBindingFromLocation(locationLike = globalThis.location) {
  const search = typeof locationLike?.search === "string" ? locationLike.search : "";
  const params = new URLSearchParams(search);
  return normalizeConversationBinding({
    entitlementId: params.get("entitlement_id"),
    creatorId: params.get("creator_id"),
    agentId: params.get("agent_id")
  });
}

export function normalizeConversationId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > MAX_CONVERSATION_ID_BYTES || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return "";
  }
  return normalized;
}

/**
 * The native popup is opt-in. Editable content retains WebView's ordinary
 * Cut/Copy/Paste menu, and a browser/Vite preview keeps its browser menu and
 * DevTools entry because we never call preventDefault there.
 */
export function requestNativeContextMenu({
  event,
  request,
  invokeImpl,
  packaged = Boolean(globalThis.window?.__TAURI_INTERNALS__),
  onError = () => {}
} = {}) {
  const normalizedRequest = normalizeContextMenuRequest(request);
  if (!packaged || !normalizedRequest || typeof invokeImpl !== "function" || !canUseNativeContextMenu(event)) {
    return false;
  }

  event.preventDefault?.();
  Promise.resolve(invokeImpl("show_native_context_menu", { request: normalizedRequest })).catch(onError);
  return true;
}

export function normalizeContextMenuRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const kind = typeof request.kind === "string" ? request.kind : "";
  if (!CONTEXT_KINDS.has(kind)) return null;
  const target = typeof request.target === "string" ? request.target.trim() : "";
  if ((kind === "conversation" || kind === "artifact") && !target) return null;
  if (target.length > 1024 || /[\u0000-\u001f\u007f]/.test(target)) return null;
  const x = Number(request.position?.x);
  const y = Number(request.position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Object.freeze({
    kind,
    ...(target ? { target } : {}),
    position: { x, y },
    editable: false
  });
}

export function nativeContextRequest(event, kind, target) {
  return {
    kind,
    target,
    position: { x: Number(event?.clientX), y: Number(event?.clientY) }
  };
}

export function canUseNativeContextMenu(event) {
  return Boolean(event) && !isEditableContextTarget(event.target);
}

export function isEditableContextTarget(target) {
  const element = target?.nodeType === 3 ? target.parentElement : target;
  if (!element) return false;
  const editableSelector = "input, textarea, select, option, [contenteditable=''], [contenteditable='true'], [role='textbox']";
  if (typeof element.closest === "function") return Boolean(element.closest(editableSelector));
  const tagName = String(element.tagName || "").toLowerCase();
  return ["input", "textarea", "select", "option"].includes(tagName)
    || element.contentEditable === "true"
    || element.getAttribute?.("role") === "textbox";
}
