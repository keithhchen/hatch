// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_CHAT_STATE, ScrollPositions, resolveCreatorIdentity } from "@hatch/chat";
import { ChatView } from "@hatch/chat/react";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Observable controller double: only the state ChatView reads (component test only). */
class StateDouble {
  constructor(state) { this.state = { ...INITIAL_CHAT_STATE, ...state }; this.listeners = new Set(); this.transport = {}; }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getState = () => this.state;
  get snapshotPending() { return false; }
  open(conversationId) { this.state = { ...this.state, conversationId, messages: thread(conversationId) }; for (const listener of this.listeners) listener(); }
}

const thread = id => [{ id: `${id}-u`, run_id: `${id}-r`, role: "user", content: `Hello from ${id}` }];

describe("ChatView scroll memory", () => {
  let mounted;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  });
  afterEach(() => { act(() => mounted?.root.unmount()); mounted?.container.remove(); vi.restoreAllMocks(); });

  it("returns each conversation to where it was left, and to the bottom when it was left there", () => {
    const controller = new StateDouble({ conversationId: "a", messages: thread("a") });
    const positions = new ScrollPositions();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted = { container, root };
    act(() => root.render(<ChatView controller={controller} identity={resolveCreatorIdentity({})} agentName="Coach" t={key => key} errorText={() => ""}
      attachments={{}} onNewConversation={() => {}} scrollPositions={positions} />));
    const viewport = container.querySelector(".web-chat__messages");
    expect(viewport.scrollTop).toBe(2000);

    viewport.scrollTop = 300;
    act(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    act(() => controller.open("b"));
    expect(positions.get("a")).toEqual({ top: 300, atBottom: false });
    expect(viewport.scrollTop).toBe(2000);

    act(() => controller.open("a"));
    expect(viewport.scrollTop).toBe(300);

    viewport.scrollTop = 1500;
    act(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    act(() => controller.open("b"));
    expect(positions.get("a")).toEqual({ top: 1500, atBottom: true });
    act(() => controller.open("a"));
    expect(viewport.scrollTop).toBe(2000);
  });
});
