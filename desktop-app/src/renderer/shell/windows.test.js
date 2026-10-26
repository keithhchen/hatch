import { describe, expect, it, vi } from "vitest";
import { AgentAccess } from "../agents/agent-directory.js";
import { agentKeyFor, chatWindowBinding, resumeConversation } from "./chat-window.js";
import { agentForLink } from "./library-window.js";
import { openAgentWindow } from "./window-controller.js";

const creatorId = "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002";
const productId = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";
const entitlementId = "7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001";
const row = extra => ({ creator_id: creatorId, product_id: productId, creator: { id: creatorId, name: "Ada" }, product: { id: productId, name: "Essay Coach" }, ...extra });
const owned = new AgentAccess(row());
const acquired = new AgentAccess(row({ entitlement_id: entitlementId }));

describe("one Chat window per Agent", () => {
  it("opens or focuses an Agent's window by its single access binding", async () => {
    const invoke = vi.fn(async () => ({ windowLabel: "agent-product-9cc7b10c-0", reused: false }));
    await openAgentWindow(owned, invoke);
    await openAgentWindow(acquired, invoke);
    expect(invoke.mock.calls).toEqual([["open_agent_window", { productId }], ["open_agent_window", { entitlementId }]]);
  });

  it("binds a Chat window to exactly one Agent from its URL", () => {
    expect(chatWindowBinding(`?window=chat&product_id=${productId}`)).toEqual({ productId });
    expect(chatWindowBinding(`?window=chat&entitlement_id=${entitlementId}`)).toEqual({ entitlementId });
    expect(chatWindowBinding(`?window=chat&product_id=${productId}&entitlement_id=${entitlementId}`)).toBeNull();
    expect(chatWindowBinding("?window=chat&product_id=nope")).toBeNull();
    expect(agentKeyFor({ productId })).toBe(owned.key);
    expect(agentKeyFor({ entitlementId })).toBe(acquired.key);
  });

  it("returns to the Agent's last conversation, else its newest, else none", () => {
    const conversations = [{ id: "conv_new" }, { id: "conv_old" }];
    expect(resumeConversation({ saved: "conv_old", conversations, hasMore: false })).toBe("conv_old");
    expect(resumeConversation({ saved: "conv_gone", conversations, hasMore: false })).toBe("conv_new");
    expect(resumeConversation({ saved: "conv_page2", conversations, hasMore: true })).toBe("conv_page2");
    expect(resumeConversation({ saved: undefined, conversations: [], hasMore: false })).toBe("");
  });

  it("routes a hatch://products/open link to the account's matching Agent only", () => {
    expect(agentForLink([owned, acquired], { productId })).toBe(owned);
    expect(agentForLink([owned, acquired], { productId, entitlementId })).toBe(acquired);
    expect(agentForLink([owned], { productId: "0aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001" })).toBeNull();
  });
});
