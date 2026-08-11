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
    const error = await fetchPurchasedCreatorAgents(
      "https://hatch.example",
      "expired-token",
      async () => new Response(JSON.stringify({ detail: "expired" }), { status: 401 })
    ).catch((caught) => caught);
    expect(error).toMatchObject({
      message: "expired",
      code: "auth_invalid",
      status: 401,
      i18nKey: "error.auth.invalidSession"
    });
  });

  it("preserves Registry error detail and adds a generic entitlement fallback key", async () => {
    const error = await fetchPurchasedCreatorAgents(
      "https://hatch.example",
      "opaque-token",
      async () => new Response(JSON.stringify({ detail: "Registry maintenance window" }), { status: 503 })
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      message: "Registry maintenance window",
      code: "entitlement_request_failed",
      status: 503,
      i18nKey: "error.entitlement.requestFailed"
    });
  });

  it("labels malformed libraries and runtime URLs with stable localization keys", async () => {
    const malformedLibrary = await fetchPurchasedCreatorAgents(
      "https://hatch.example",
      "opaque-token",
      async () => new Response("{}", { status: 200 })
    ).catch((caught) => caught);
    expect(malformedLibrary).toMatchObject({
      message: "We couldn't open your agent library. Try again.",
      i18nKey: "error.entitlement.invalidLibrary"
    });

    let invalidUrl;
    try {
      runtimeHttpUrl("not a URL", "/messages");
    } catch (error) {
      invalidUrl = error;
    }
    expect(invalidUrl).toMatchObject({ i18nKey: "error.entitlement.invalidRuntimeUrl" });
  });

  it("maps secure websocket runtimes to secure HTTP discovery", () => {
    expect(runtimeHttpUrl("wss://runtime.hatch.example/runtime", "/conversations/conversation-1/messages"))
      .toBe("https://runtime.hatch.example/conversations/conversation-1/messages");
  });
});
