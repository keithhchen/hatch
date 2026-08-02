import { describe, expect, it, vi } from "vitest";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";

describe("buyer Creator Agent library", () => {
  it("discovers purchased Agents from the canonical Registry access and catalog endpoints", async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      json: async () => url.endsWith("/v1/user/agent-access")
        ? [{
          entitlement_id: "ent_jordan_signal",
          user_id: "jordan",
          creator_id: "maya",
          agent_id: "signal",
          product_id: "signal",
          status: "active",
          granted_at: "2026-08-03T00:00:00.000Z"
        }]
        : [{
          creator_id: "maya",
          agent_id: "signal",
          creator_name: "Maya Chen",
          product_id: "signal",
          product_name: "Signal Review",
          product_description: "Review work",
          status: "published"
        }]
    }));
    const result = await fetchPurchasedCreatorAgents("https://hatch.example", "signed-jordan-token", fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      entitlement_id: "ent_jordan_signal",
      creator: { id: "maya", name: "Maya Chen" },
      product: { id: "signal", name: "Signal Review" }
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://hatch.example/v1/user/agent-access", {
      headers: { authorization: "Bearer signed-jordan-token" }
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://hatch.example/v1/catalog/agents", {
      headers: { accept: "application/json" }
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/release_id|release_digest/);
  });

  it("maps secure websocket runtimes to secure HTTP discovery", () => {
    expect(runtimeHttpUrl("wss://runtime.hatch.example/runtime", "/conversations/conversation-1/messages"))
      .toBe("https://runtime.hatch.example/conversations/conversation-1/messages");
  });
});
