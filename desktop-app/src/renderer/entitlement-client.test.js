import { describe, expect, it, vi } from "vitest";
import { fetchPurchasedCreatorAgents, runtimeHttpUrl } from "./entitlement-client.js";

describe("buyer Creator Agent library", () => {
  it("discovers purchased agents with a buyer credential and never sends a Release binding", async () => {
    const fetchImpl = vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({
        creator_agents: [{
          entitlement_id: "ent_jordan_signal",
          creator: { id: "maya", name: "Maya Chen" },
          product: { id: "signal", name: "Signal Review", description: "Review work", promise: "Deliver review", boundaries: [] },
          presentation: {}
        }]
      })
    }));
    const result = await fetchPurchasedCreatorAgents("ws://127.0.0.1:8400/runtime", "lic_jordan", fetchImpl);
    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:8400/v1/me/creator-agents", {
      headers: { authorization: "Bearer lic_jordan" }
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/release_id|release_digest/);
  });

  it("maps secure websocket runtimes to secure HTTP discovery", () => {
    expect(runtimeHttpUrl("wss://runtime.hatch.example/runtime", "/v1/me/creator-agents"))
      .toBe("https://runtime.hatch.example/v1/me/creator-agents");
  });
});
