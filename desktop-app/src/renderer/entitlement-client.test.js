import { describe, expect, it, vi } from "vitest";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";

describe("buyer Creator Agent library", () => {
  it("uses one canonical Registry response for the signed-in library", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{
      entitlement_id: "ent_jordan_signal",
      user_id: "jordan",
      creator_id: "maya",
      agent_id: "signal",
      product_id: "signal",
      status: "active",
      granted_at: "2026-08-03T00:00:00.000Z",
      creator: { id: "maya", name: "Maya Chen" },
      product: { id: "signal", name: "Signal Review", description: "Review work" },
      presentation: { accent: "orange" }
    }]), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await fetchPurchasedCreatorAgents("https://hatch.example", "opaque-jordan-token", fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      entitlement_id: "ent_jordan_signal",
      creator: { id: "maya", name: "Maya Chen" },
      product: { id: "signal", name: "Signal Review" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("https://hatch.example/v1/user/agent-access", {
      headers: { authorization: "Bearer opaque-jordan-token", accept: "application/json" }
    });
  });

  it("treats an empty access list as a valid signed-in result", async () => {
    const result = await fetchPurchasedCreatorAgents(
      "https://hatch.example",
      "opaque-jordan-token",
      async () => new Response("[]", { status: 200 })
    );
    expect(result).toEqual([]);
  });

  it("maps an invalid session to auth_invalid", async () => {
    await expect(fetchPurchasedCreatorAgents(
      "https://hatch.example",
      "expired-token",
      async () => new Response(JSON.stringify({ detail: "expired" }), { status: 401 })
    )).rejects.toMatchObject({ code: "auth_invalid", status: 401 });
  });

  it("maps secure websocket runtimes to secure HTTP discovery", () => {
    expect(runtimeHttpUrl("wss://runtime.hatch.example/runtime", "/conversations/conversation-1/messages"))
      .toBe("https://runtime.hatch.example/conversations/conversation-1/messages");
  });
});
