import { describe, expect, it, vi } from "vitest";
import {
  canConnectConversation,
  conversationScope,
  createConversation,
  interruptedRunFromSnapshot,
  isServerConversationId,
  restorableConversationId,
  isTerminalRunStatus,
  listConversations,
  reconcileConversationSnapshot,
  shouldOpenNewConversationInWindow,
  updateConversation
} from "./conversation-client.js";

const binding = { entitlementId: "ent_a", creatorId: "creator_a", agentId: "agent_a" };

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe("conversation client", () => {
  it("requires a verified Library before connecting a server Conversation", () => {
    expect(canConnectConversation({ libraryStatus: "idle", conversationId: "conv_a" })).toBe(false);
    expect(canConnectConversation({ libraryStatus: "loading", conversationId: "conv_a" })).toBe(false);
    expect(canConnectConversation({ libraryStatus: "unavailable", conversationId: "conv_a" })).toBe(false);
    expect(canConnectConversation({ libraryStatus: "ready", conversationId: "desktop-chat" })).toBe(false);
    expect(canConnectConversation({ libraryStatus: "ready", conversationId: "conv_a" })).toBe(true);
  });

  it("keeps only the bounded legacy migration ID alive when Library is unavailable", () => {
    expect(canConnectConversation({ libraryStatus: "unavailable", conversationId: "desktop-chat" })).toBe(true);
    expect(canConnectConversation({ libraryStatus: "unavailable", conversationId: "conversation_account_1_123" })).toBe(false);
    expect(canConnectConversation({ libraryStatus: "unavailable", conversationId: "" })).toBe(false);
  });

  it("accepts only server-issued conversation IDs for new turns", () => {
    expect(isServerConversationId("conv_0123abc"), "server id").toBe(true);
    expect(isServerConversationId("desktop-chat"), "legacy id").toBe(false);
    expect(isServerConversationId("conversation_account_1"), "renderer id").toBe(false);
  });

  it("does not restore arbitrary legacy IDs across Creator Agents", () => {
    expect(restorableConversationId("conv_0123abc")).toBe("conv_0123abc");
    expect(restorableConversationId("desktop-chat")).toBe("desktop-chat");
    expect(restorableConversationId("conversation_account_1_123")).toBe("desktop-chat");
    expect(restorableConversationId("conversation_account_1_123", "")).toBe("");
  });

  it("recognizes terminal durable run states", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
    expect(isTerminalRunStatus("interrupted")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("routes a non-terminal task to a separate Conversation window", () => {
    expect(shouldOpenNewConversationInWindow({ runId: "run_live", status: "running" })).toBe(true);
    expect(shouldOpenNewConversationInWindow({ id: "run_interrupted", status: "interrupted" })).toBe(true);
    expect(shouldOpenNewConversationInWindow({ runId: "run_done", status: "completed" })).toBe(false);
    expect(shouldOpenNewConversationInWindow(null)).toBe(false);
  });

  it("uses the verified entitlement scope and lists durable records", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ conversations: [{ id: "conv_1" }] }));
    const result = await listConversations("wss://runtime.test/v1/runtime", "token", binding, {}, fetchImpl);
    expect(result.conversations[0].id).toBe("conv_1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/v1/conversations?");
    expect(url).toContain("entitlement_id=ent_a");
    expect(url).toContain("creator_id=creator_a");
    expect(url).toContain("agent_id=agent_a");
    expect(init.headers.authorization).toBe("Bearer token");
  });

  it("creates with an idempotency key and patches metadata with its version", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ conversation: { id: "conv_1" }, created: true }, true, 201))
      .mockResolvedValueOnce(response({ conversation: { id: "conv_1", title: "Renamed" } }));
    await createConversation("https://runtime.test", "token", binding, {
      title: "Research",
      clientRequestId: "create_once"
    }, fetchImpl);
    await updateConversation("https://runtime.test", "token", binding, "conv_1", {
      title: "Renamed",
      version: 1
    }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      title: "Research",
      client_request_id: "create_once"
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ title: "Renamed", version: 1 });
  });

  it("surfaces server error codes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: { code: "conversation_busy", message: "Busy" } }, false, 409));
    await expect(listConversations("https://runtime.test", "token", binding, {}, fetchImpl))
      .rejects.toMatchObject({ code: "conversation_busy", status: 409, message: "Busy" });
  });

  it("does not invent authority when a scope field is absent", () => {
    expect([...conversationScope({ entitlementId: "ent_a" })]).toEqual([["entitlement_id", "ent_a"]]);
  });

  it("projects a durable interrupted run without creating an executor claim", () => {
    const projected = interruptedRunFromSnapshot({
      runs: [{
        id: "run_crashed",
        client_message_id: "message_crashed",
        status: "interrupted",
        interrupted_reason: "Runtime restarted",
        created_at: "2026-08-11T00:00:00.000Z"
      }]
    });
    expect(projected).toMatchObject({
      runId: "run_crashed",
      clientMessageId: "message_crashed",
      status: "interrupted",
      interruptedReason: "Runtime restarted"
    });
    expect(projected).not.toHaveProperty("executorId");
  });

  it("keeps the renderer's richer run projection and respects dismissal", () => {
    const current = {
      runId: "run_same",
      assistantId: "run_same_assistant",
      accessSnapshot: { workspaceGrantId: "grant_1" },
      text: "partial"
    };
    const snapshot = { runs: [{ id: "run_same", status: "interrupted", interrupted_reason: "Client disconnected" }] };
    expect(interruptedRunFromSnapshot(snapshot, current)).toMatchObject({
      ...current,
      status: "interrupted",
      interruptedReason: "Client disconnected"
    });
    expect(interruptedRunFromSnapshot(snapshot, current, "run_same")).toBeNull();
  });

  it("does not replace a terminal current Run with another historical interruption", () => {
    const snapshot = {
      runs: [
        { id: "run_current", status: "completed" },
        { id: "run_other_window", status: "interrupted", interrupted_reason: "Other window closed" }
      ]
    };
    expect(interruptedRunFromSnapshot(snapshot, {
      runId: "run_current",
      status: "interrupted"
    })).toBeNull();
    expect(interruptedRunFromSnapshot(snapshot, null)).toMatchObject({
      runId: "run_other_window",
      status: "interrupted"
    });
  });

  it("reconciles sparse journal cursors idempotently before accepting the snapshot cursor", () => {
    const result = reconcileConversationSnapshot({
      messages: [{ run_id: "run_1", role: "user", content: "hello" }],
      runs: [{ id: "run_1", status: "completed" }],
      events: [
        { cursor: 2, type: "run.created", run_id: "run_1", payload: {} },
        { cursor: 4, type: "run.state", run_id: "run_1", payload: { status: "completed" } },
        { cursor: 4, type: "run.state", run_id: "run_1", payload: { status: "completed" } }
      ],
      cursor: 4
    }, { afterCursor: 1 });
    expect(result.events.map((event) => event.cursor)).toEqual([2, 4]);
    expect(result.cursor).toBe(4);
    expect(result.messages).toHaveLength(1);
  });

  it("rejects an unsafe journal rather than advancing the persisted cursor", () => {
    expect(() => reconcileConversationSnapshot({
      messages: [],
      runs: [{ id: "run_1", status: "running" }],
      events: [
        { cursor: 3, type: "run.state", run_id: "run_1", payload: {} },
        { cursor: 2, type: "run.created", run_id: "run_1", payload: {} }
      ],
      cursor: 3
    })).toThrowError(expect.objectContaining({ code: "snapshot_invalid" }));
    expect(() => reconcileConversationSnapshot({
      messages: [],
      runs: [{ id: "run_1", status: "running" }],
      events: [{ cursor: 1, type: "run.state", run_id: "run_unknown", payload: {} }],
      cursor: 1
    })).toThrowError(expect.objectContaining({ code: "snapshot_invalid" }));
  });

  it("rejects a repeated cursor whose journal payload changed", () => {
    expect(() => reconcileConversationSnapshot({
      messages: [],
      runs: [{ id: "run_1", status: "completed" }],
      events: [
        { cursor: 2, type: "run.state", run_id: "run_1", payload: { status: "running" } },
        { cursor: 2, type: "run.state", run_id: "run_1", payload: { status: "completed" } }
      ],
      cursor: 2
    })).toThrowError(expect.objectContaining({ code: "snapshot_invalid" }));
  });

  it("rejects an incomplete projection instead of advancing its cursor", () => {
    expect(() => reconcileConversationSnapshot({
      runs: [],
      events: [],
      cursor: 1
    })).toThrowError(expect.objectContaining({ code: "snapshot_invalid" }));
  });

  it("skips a dismissed interrupted run and projects the next durable one", () => {
    const snapshot = {
      runs: [
        { id: "run_old", status: "interrupted", interrupted_reason: "old" },
        { id: "run_dismissed", status: "interrupted", interrupted_reason: "closed" },
        { id: "run_new", status: "interrupted", interrupted_reason: "new" }
      ]
    };
    expect(interruptedRunFromSnapshot(snapshot, null, "run_dismissed")).toMatchObject({
      runId: "run_new",
      interruptedReason: "new"
    });
    expect(interruptedRunFromSnapshot({ runs: snapshot.runs.slice(0, 2) }, null, "run_dismissed")).toMatchObject({
      runId: "run_old",
      interruptedReason: "old"
    });
    expect(interruptedRunFromSnapshot(snapshot, {
      runId: "run_old",
      assistantId: "run_old_assistant",
      text: "partial"
    })).toMatchObject({
      runId: "run_old",
      interruptedReason: "old",
      text: "partial"
    });
  });
});
