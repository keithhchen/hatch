import { describe, expect, it, vi } from "vitest";
import { ConversationTransport, RuntimeConnection } from "@hatch/chat";
import { AgentAccess } from "../agents/agent-directory.js";
import { ApprovalCenter } from "./approvals.js";
import { ConversationSessions } from "./conversation-sessions.js";
import { LOCAL_TOOLS } from "./local-tools.js";

const productId = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";
const creatorId = "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002";
const agent = new AgentAccess({ creator_id: creatorId, product_id: productId, creator: { id: creatorId, name: "Ada" }, product: { id: productId, name: "Essay Coach" } });
const grant = { grant_id: "grant_1", display_path: "/Users/ada/essay" };

/** Recording Runtime double for this unit test only: every frame the client sends. */
class RecordingTransport extends ConversationTransport {
  constructor() { super(); this.frames = []; }
  snapshot() { return Promise.resolve({ conversation: { id: "conv_1" }, messages: [], runs: [], events: [], cursor: 0, has_more: false }); }
  events(_id, { afterCursor }) { return Promise.resolve({ events: [], runs: [], cursor: afterCursor, through_cursor: afterCursor, has_more: false }); }
  connect(conversationId, handlers) {
    const frames = this.frames;
    const connection = new class extends RuntimeConnection {
      hello(localTools) { frames.push({ type: "client.hello", local_tools: localTools }); }
      send(message) { frames.push({ type: "client.message", ...message }); }
      close() {}
      get ready() { return true; }
    }();
    queueMicrotask(() => { handlers.onOpen(); handlers.onEvent({ type: "session.ready", conversation_id: conversationId }); });
    return connection;
  }
}

/** Native bridge double: task settings (with or without a folder) and tool contexts. */
function native({ folder }) {
  return vi.fn(async command => {
    if (command === "read_task_settings") return folder ? { workspaceGrant: grant, permissionMode: "ask-before-changes" } : null;
    if (command === "ensure_workspace" || command === "pick_workspace_folder") return grant;
    if (command === "set_window_tool_context") return { context_id: "ctx_1" };
    return undefined;
  });
}

async function openSession({ folder, startTask = false }) {
  const transport = new RecordingTransport();
  const sessions = new ConversationSessions({
    invoke: native({ folder }), owner: { claim: async () => async () => {} }, approvals: new ApprovalCenter(),
    clientVersion: "1.0.0", describeError: error => String(error), isVisible: () => true
  });
  await sessions.bind({ id: "acct" }, "tok");
  sessions.transportFor = () => transport;
  const session = await sessions.open(agent, "conv_1", { startTask });
  await vi.waitFor(() => expect(session.controller.getState().session).not.toBeNull());
  return { session, transport, sessions };
}

describe("Desktop conversation sessions", () => {
  it("declares the full local tool list in hello and in every message", async () => {
    const { session, transport, sessions } = await openSession({ folder: true });
    session.controller.setDraft("Outline my essay");
    await session.controller.send();
    const hello = transport.frames.find(frame => frame.type === "client.hello");
    const message = transport.frames.find(frame => frame.type === "client.message");
    expect(hello.local_tools).toEqual([...LOCAL_TOOLS]);
    expect(message).toMatchObject({ content: "Outline my essay", localTools: [...LOCAL_TOOLS] });
    await sessions.closeAll();
  });

  it("blocks sending without a folder and keeps the composer text in memory", async () => {
    const { session, transport, sessions } = await openSession({ folder: false });
    expect(session.workspace.grant).toBeNull();
    session.controller.setDraft("Hello");
    await session.controller.send();
    expect(transport.frames.some(frame => frame.type === "client.message")).toBe(false);
    expect(session.controller.getState().draft).toBe("Hello");
    await session.workspace.choose();
    await session.controller.send();
    expect(transport.frames.find(frame => frame.type === "client.message")).toMatchObject({ content: "Hello" });
    await sessions.closeAll();
  });

  it("starts a brief's task only once the conversation has a folder", async () => {
    const { session, transport, sessions } = await openSession({ folder: false, startTask: true });
    expect(transport.frames.some(frame => frame.taskStart)).toBe(false);
    await session.workspace.choose();
    await vi.waitFor(() => expect(transport.frames.some(frame => frame.type === "client.message" && frame.taskStart)).toBe(true));
    await sessions.closeAll();
  });
});
