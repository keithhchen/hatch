import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_COMMAND,
  NATIVE_COMMAND_EVENT,
  conversationIdFromLocation,
  isEditableContextTarget,
  requestNativeContextMenu,
  routeNativeCommand,
  subscribeNativeCommands
} from "./native-commands.js";

describe("native renderer commands", () => {
  it("routes semantic menu commands without exposing menu implementation details", async () => {
    const onNewConversation = vi.fn();
    const onOpenConversationWindow = vi.fn();
    const onToggleSidebar = vi.fn();
    const onZoomIn = vi.fn();
    const onQuickLookArtifact = vi.fn();

    await expect(routeNativeCommand({ id: NATIVE_COMMAND.CONVERSATION_NEW }, {
      onNewConversation,
      onOpenConversationWindow,
      onToggleSidebar
    })).resolves.toBe(true);
    await expect(routeNativeCommand({
      id: NATIVE_COMMAND.CONVERSATION_OPEN_WINDOW,
      source: "context-menu",
      context: "conversation",
      target: "conversation_123"
    }, { onOpenConversationWindow })).resolves.toBe(true);
    await expect(routeNativeCommand({ id: NATIVE_COMMAND.SIDEBAR_TOGGLE }, { onToggleSidebar })).resolves.toBe(true);
    await expect(routeNativeCommand({ id: NATIVE_COMMAND.VIEW_ZOOM_IN }, { onZoomIn })).resolves.toBe(true);
    await expect(routeNativeCommand({
      id: NATIVE_COMMAND.ARTIFACT_QUICK_LOOK,
      source: "context-menu",
      context: "artifact",
      target: "artifact_123"
    }, { onQuickLookArtifact })).resolves.toBe(true);

    expect(onNewConversation).toHaveBeenCalledWith(undefined, expect.objectContaining({ id: NATIVE_COMMAND.CONVERSATION_NEW }));
    expect(onOpenConversationWindow).toHaveBeenCalledWith("conversation_123", expect.objectContaining({ context: "conversation" }));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(onQuickLookArtifact).toHaveBeenCalledWith("artifact_123", expect.objectContaining({ context: "artifact" }));
  });

  it("ignores malformed and unsupported native events", async () => {
    const onNewConversation = vi.fn();
    await expect(routeNativeCommand({ id: "window.closeEverything" }, { onNewConversation })).resolves.toBe(false);
    await expect(routeNativeCommand(null, { onNewConversation })).resolves.toBe(false);
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it("cleans up an asynchronously registered native listener", async () => {
    let receive;
    const unlisten = vi.fn();
    let completeRegistration;
    const registration = new Promise((resolve) => { completeRegistration = resolve; });
    const listenImpl = vi.fn((_eventName, callback) => {
      receive = callback;
      return registration;
    });
    const onCommand = vi.fn();

    const dispose = subscribeNativeCommands({ listenImpl, onCommand });
    expect(listenImpl).toHaveBeenCalledWith(NATIVE_COMMAND_EVENT, expect.any(Function));
    receive({ payload: { id: NATIVE_COMMAND.RUN_STOP } });
    expect(onCommand).toHaveBeenCalledWith({ id: NATIVE_COMMAND.RUN_STOP });

    dispose();
    completeRegistration(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("uses native context menus only for non-editable packaged content", async () => {
    const preventDefault = vi.fn();
    const invokeImpl = vi.fn().mockResolvedValue(true);
    const staticTarget = { closest: () => null };
    const event = { clientX: 32, clientY: 48, target: staticTarget, preventDefault };

    expect(requestNativeContextMenu({
      event,
      request: { kind: "conversation", target: "conversation_123", position: { x: 32, y: 48 } },
      invokeImpl,
      packaged: true
    })).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(invokeImpl).toHaveBeenCalledWith("show_native_context_menu", {
      request: {
        kind: "conversation",
        target: "conversation_123",
        position: { x: 32, y: 48 },
        editable: false
      }
    });

    const editableEvent = { clientX: 1, clientY: 2, target: { closest: () => ({ tagName: "INPUT" }) }, preventDefault: vi.fn() };
    expect(requestNativeContextMenu({
      event: editableEvent,
      request: { kind: "tool-result", position: { x: 1, y: 2 } },
      invokeImpl,
      packaged: true
    })).toBe(false);
    expect(editableEvent.preventDefault).not.toHaveBeenCalled();

    const browserEvent = { clientX: 1, clientY: 2, target: staticTarget, preventDefault: vi.fn() };
    expect(requestNativeContextMenu({
      event: browserEvent,
      request: { kind: "tool-result", position: { x: 1, y: 2 } },
      invokeImpl,
      packaged: false
    })).toBe(false);
    expect(browserEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("recognizes editable descendants and safely reads a routed conversation URL", () => {
    expect(isEditableContextTarget({ closest: () => ({}) })).toBe(true);
    expect(isEditableContextTarget({ closest: () => null })).toBe(false);
    expect(conversationIdFromLocation({ search: "?conversation_id=conversation_123" })).toBe("conversation_123");
    expect(conversationIdFromLocation({ search: "?conversation_id=bad%0Avalue" })).toBe("");
  });
});
