// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTransport, RuntimeConnection } from "@hatch/chat";
import { AgentAccess } from "../agents/agent-directory.js";
import { ConversationLibrary } from "../agents/conversation-library.js";
import { artifactRelativePath, attachmentAt, toolArtifact, toolEntriesAt } from "../chat/thread-targets.js";
import { createTranslator } from "../i18n.js";
import { Shell } from "./App.jsx";
import { ChatWindow } from "./chat-window.js";
import { DesktopContext } from "./context.js";
import { Library } from "./Library.jsx";
import { LibraryWindow } from "./library-window.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const creator = { id: "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002", name: "Ada" };
const productId = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";
const otherId = "0dd7b10c-4db0-4d8a-8c2f-2e2c8cba1004";
const agent = new AgentAccess({ creator_id: creator.id, product_id: productId, creator, product: { id: productId, name: "Essay Coach" } });
const other = new AgentAccess({ creator_id: creator.id, product_id: otherId, creator, product: { id: otherId, name: "Tax Helper" } });
const grant = { grant_id: "grant_1", display_path: "/Users/ada/essay" };

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

function mount(app, View) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<DesktopContext.Provider value={{ app, t: createTranslator("en") }}><View /></DesktopContext.Provider>));
  return { container, root };
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

/** A Chat window for `agent` with conv_1 open; `folder` decides whether it has a granted folder. */
async function chatWindow({ folder }) {
  const app = new ChatWindow({ binding: agent.binding });
  const transport = new ScriptedTransport();
  app.session.setState({ phase: "signed-in", token: "tok", account: { id: "a", name: "Ada Reader" }, agents: [agent, other], agentsStatus: "ready" });
  await app.sessions.bind({ id: "a" }, "tok");
  app.sessions.transportFor = () => transport;
  app.sessions.invoke = vi.fn(async command => {
    if (command === "read_task_settings") return folder ? { workspaceGrant: grant, permissionMode: "ask-before-changes" } : null;
    if (command === "ensure_workspace") return grant;
    return undefined;
  });
  app.library = new ConversationLibrary(agent, transport);
  await app.select("conv_1");
  return app;
}

describe("Desktop Chat window", () => {
  let mounted;
  beforeEach(() => { document.body.innerHTML = ""; });
  afterEach(() => act(() => mounted?.root.unmount()));

  it("shows only its Agent's conversations, the toolbar and a live conversation with folder and permission controls", async () => {
    const app = await chatWindow({ folder: true });
    mounted = mount(app, Shell);
    await settle();
    const text = mounted.container.textContent;
    expect(text).toContain("Essay Coach");
    expect(text).not.toContain("Tax Helper");
    expect(text).toContain("Essay Coach · Ada");
    expect(text).toContain("Hello there");
    expect(text).toContain("essay");
    expect(text).toContain("Ask before changes");
    expect(text).not.toContain("Search");
    expect(mounted.container.querySelector(".desk-row--conversation[aria-current='page']")?.textContent).toContain("Thesis draft");
    expect(mounted.container.querySelector(".desk-thread[data-folder='granted']")).not.toBeNull();
    expect(mounted.container.querySelector("button[aria-label='Attach files']")).not.toBeNull();
  });

  it("explains that sending needs a folder until one is chosen", async () => {
    const app = await chatWindow({ folder: false });
    mounted = mount(app, Shell);
    await settle();
    expect(mounted.container.querySelector(".desk-thread[data-folder='missing']")).not.toBeNull();
    expect(mounted.container.textContent).toContain("Choose a folder for this conversation before sending.");
  });

  it("starts a new conversation with the folder step when no folder is known", async () => {
    const app = new ChatWindow({ binding: agent.binding });
    app.session.setState({ phase: "signed-in", token: "tok", account: { id: "a", name: "Ada" }, agents: [agent], agentsStatus: "ready" });
    app.library = new ConversationLibrary(agent, new ScriptedTransport());
    mounted = mount(app, Shell);
    act(() => app.newConversation());
    expect(app.getState().composing).toMatchObject({ grant: null });
    expect(mounted.container.textContent).toContain("Choose a folder to start");
  });

  it("answers the native gate from the tool row's inline Allow", async () => {
    const app = await chatWindow({ folder: true });
    mounted = mount(app, Shell);
    await settle();
    const { controller } = app.currentSession;
    const decision = app.approvals.ask({ conversationId: "conv_1", agentKey: agent.key, request: { tool_call_id: "t1", name: "shell_exec", arguments: { command: "ls" } } });
    act(() => {
      controller.updateMessages(current => [...current, { id: "a1", run_id: "r2", role: "assistant", transient: true, timeline: [
        { kind: "tool", id: "tool-t1", title: "shell exec", status: "requested", content: { toolCallId: "t1", name: "shell_exec", arguments: { command: "ls" } } }
      ] }]);
      controller.markApproval("t1", "pending");
    });
    const allow = [...mounted.container.querySelectorAll(".web-chat__approval button")].find(button => button.textContent === "Allow");
    expect(allow).toBeTruthy();
    act(() => allow.click());
    await expect(decision).resolves.toBe(true);
    expect(mounted.container.textContent).toContain("Allowed");
  });

  it("resolves a right-click to the tool row's files and to a message attachment", async () => {
    const app = await chatWindow({ folder: true });
    mounted = mount(app, Shell);
    await settle();
    const { controller } = app.currentSession;
    act(() => controller.updateMessages(current => [...current,
      { id: "u2", run_id: "r3", role: "user", content: "See notes", attachments: [{ kind: "local_file", attachment_id: "drop_abc", host_id: "host_1", sha256: "f".repeat(64), display_name: "notes.pdf", media_type: "application/pdf" }] },
      { id: "a3", run_id: "r3", role: "assistant", transient: true, timeline: [
        { kind: "text", id: "text-1", content: "Writing it." },
        { kind: "tool", id: "tool-w", title: "file write", status: "completed", content: { toolCallId: "w", name: "file_write", arguments: { path: "out/essay.md" }, result: { path: "/Users/ada/essay/out/essay.md" } } },
        { kind: "tool", id: "tool-r", title: "file read", status: "completed", content: { toolCallId: "r", name: "file_read", arguments: { path: "notes.md" }, result: { content: "# Notes" } } }
      ] }
    ]));
    const state = controller.getState();
    const trigger = mounted.container.querySelector("article:last-of-type .web-chat__activity-trigger");
    expect(toolEntriesAt(trigger, state).map(entry => entry.content.toolCallId)).toEqual(["w", "r"]);
    expect(toolEntriesAt(mounted.container.querySelector("article:last-of-type .web-chat__bubble"), state)).toEqual([]);
    const chip = mounted.container.querySelector(".web-chat__attachments > span");
    expect(attachmentAt(chip, state, type => type.startsWith("image/")).local).toEqual({ contextId: "drop_abc", hostId: "host_1", sha256: "f".repeat(64) });
    const written = toolArtifact(toolEntriesAt(trigger, state)[0].content);
    expect(artifactRelativePath(written.path, grant.display_path)).toBe("out/essay.md");
    expect(artifactRelativePath("/etc/passwd", grant.display_path)).toBe("");
    expect(toolArtifact(toolEntriesAt(trigger, state)[1].content).output).toBe("# Notes");
  });
});

describe("Desktop Library window", () => {
  let mounted;
  afterEach(() => act(() => mounted?.root.unmount()));

  it("groups my Agents as acquired and published cards and offers more on the web", () => {
    const acquired = new AgentAccess({ creator_id: creator.id, product_id: otherId, entitlement_id: "1aa7b10c-4db0-4d8a-8c2f-2e2c8cba1009", creator, product: { id: otherId, name: "Tax Helper", description: "Files your taxes." } });
    const app = new LibraryWindow();
    app.session.setState({ phase: "signed-in", token: "tok", account: { id: "a", name: "Ada" }, agents: [agent, acquired], agentsStatus: "ready" });
    mounted = mount(app, Library);
    const groups = [...mounted.container.querySelectorAll(".desk-library__group")];
    expect(groups.map(group => group.querySelector("h2").textContent)).toEqual(["Acquired", "Published by Me"]);
    expect(groups[0].textContent).toContain("Tax Helper");
    expect(groups[0].querySelector(".desk-library__description").textContent).toBe("Files your taxes.");
    expect(groups[1].textContent).toContain("Essay Coach");
    expect(groups[1].textContent).toContain(creator.name);
    expect(mounted.container.textContent).toContain("Browse More Agents…");
    act(() => app.session.setState({ agents: [acquired] }));
    expect(mounted.container.textContent).toContain("Publish your first Agent in Studio");
    act(() => app.session.setState({ agents: [] }));
    expect(mounted.container.textContent).toContain("No Agents yet");
  });
});
