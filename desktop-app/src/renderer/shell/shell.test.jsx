// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationController, ConversationTransport, MemoryDraftStore, RuntimeConnection } from "@hatch/chat";
import { AgentAccess } from "../agents/agent-directory.js";
import { ConversationLibrary } from "../agents/conversation-library.js";
import { ConversationSession } from "../chat/conversation-sessions.js";
import { NativeToolExecutor } from "../chat/native-tools.js";
import { WorkspaceAccess } from "../chat/workspace.js";
import { createTranslator } from "../i18n.js";
import { Shell } from "./App.jsx";
import { DesktopContext } from "./context.js";
import { DesktopWindow } from "./desktop-window.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const creator = { id: "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002", name: "Ada" };
const productId = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";
const agent = new AgentAccess({ creator_id: creator.id, product_id: productId, creator, product: { id: productId, name: "Essay Coach" } });

/** In-memory Runtime double for this component test only. */
class ScriptedTransport extends ConversationTransport {
  list() { return Promise.resolve({ conversations: [{ id: "conv_1", title: "Thesis draft" }] }); }
  snapshot() { return Promise.resolve({ conversation: { id: "conv_1", title: "Thesis draft" }, messages: [{ id: "m1", run_id: "r1", role: "user", content: "Hello there" }], runs: [], events: [], cursor: 1, has_more: false }); }
  events(_id, { afterCursor }) { return Promise.resolve({ events: [], runs: [], cursor: afterCursor, through_cursor: afterCursor, has_more: false }); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  connect(_id, handlers) {
    const connection = new class extends RuntimeConnection { hello() {} send() {} close() {} get ready() { return true; } }();
    queueMicrotask(() => handlers.onEvent({ type: "session.ready", conversation_id: "conv_1" }));
    return connection;
  }
}

function mount(app) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<DesktopContext.Provider value={{ app, t: createTranslator("en") }}><Shell /></DesktopContext.Provider>));
  return { container, root };
}

describe("Desktop shell", () => {
  let mounted;
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => act(() => mounted?.root.unmount()));

  it("renders the Agent-grouped sidebar, toolbar and a live conversation with desktop composer controls", async () => {
    const app = new DesktopWindow();
    const transport = new ScriptedTransport();
    app.libraries.set(agent.key, new ConversationLibrary(agent, transport));
    app.session.setState({ phase: "signed-in", token: "tok", account: { id: "a", name: "Ada Reader" }, agents: [agent], agentsStatus: "ready" });
    const invoke = async command => command === "read_task_settings" ? null : undefined;
    const workspace = new WorkspaceAccess(invoke, "conv_1");
    await workspace.restore();
    const tools = new NativeToolExecutor({ invoke, conversationId: "conv_1", workspace, approvals: app.approvals, agentKey: agent.key });
    const controller = new ConversationController({ transport, attachments: app.attachments, tools, drafts: new MemoryDraftStore(), pollMs: 60_000 });
    const session = new ConversationSession({ agent, conversationId: "conv_1", controller, tools, workspace, drafts: { close: async () => {} }, release: async () => {} });
    app.sessions.sessions.set(session.key, session);
    controller.open("conv_1");
    app.setState({ selection: { agentKey: agent.key, conversationId: "conv_1" } });

    mounted = mount(app);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const text = mounted.container.textContent;
    expect(text).toContain("Essay Coach");
    expect(text).toContain("Thesis draft");
    expect(text).toContain("Essay Coach · Ada");
    expect(text).toContain("Hello there");
    expect(text).toContain("Choose Folder");
    expect(mounted.container.querySelector(".desk-row--conversation[aria-current='page']")?.textContent).toContain("Thesis draft");
    expect(mounted.container.querySelector("textarea[aria-label='Message Essay Coach']")).not.toBeNull();
    expect(mounted.container.querySelector("button[aria-label='Attach files']")).not.toBeNull();
    controller.dispose();
  });

  it("shows the Agent's welcome when it has no conversation, and the empty state without Agents", async () => {
    const app = new DesktopWindow();
    app.libraries.set(agent.key, new ConversationLibrary(agent, new ScriptedTransport()));
    app.session.setState({ phase: "signed-in", token: "tok", account: { id: "a", name: "Ada" }, agents: [agent], agentsStatus: "ready" });
    app.setState({ selection: { agentKey: agent.key, conversationId: "" } });
    mounted = mount(app);
    expect(mounted.container.textContent).toContain("New Conversation");
    act(() => app.session.setState({ agents: [] }));
    expect(mounted.container.textContent).toContain("No Agents yet");
  });
});
