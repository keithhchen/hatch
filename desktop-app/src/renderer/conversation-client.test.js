import { describe, expect, it, vi } from "vitest";
import {
  conversationScope,
  createConversation,
  interruptedRunFromSnapshot,
  listConversations,
  updateConversation
} from "./conversation-client.js";

const binding = { entitlementId: "ent_a", creatorId: "creator_a", agentId: "agent_a" };

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe("conversation client", () => {
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
});
