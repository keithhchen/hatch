import { describe, expect, it } from "vitest";
import {
  conversationCreationScope,
  createConversationCreationTracker
} from "./conversation-create-retry.js";

describe("Conversation creation retry scope", () => {
  it("reuses a pending key only for a retryable failure", () => {
    const tracker = createConversationCreationTracker();
    const scope = conversationCreationScope({
      accountId: "account_a",
      binding: { entitlementId: "ent_a", creatorId: "creator_a", agentId: "agent_a" },
      purpose: "create"
    });
    let sequence = 0;
    const first = tracker.requestId(scope, () => `request_${++sequence}`);
    tracker.settle(scope, { retryable: true });
    expect(tracker.requestId(scope, () => `request_${++sequence}`)).toBe(first);
    tracker.settle(scope);
    expect(tracker.requestId(scope, () => `request_${++sequence}`)).toBe("request_2");
  });

  it("keeps Agent, account, and creation purpose scopes independent", () => {
    const binding = { entitlementId: "ent_a", creatorId: "creator_a", agentId: "agent_a" };
    expect(conversationCreationScope({ accountId: "account_a", binding, purpose: "create" }))
      .not.toBe(conversationCreationScope({ accountId: "account_b", binding, purpose: "create" }));
    expect(conversationCreationScope({ accountId: "account_a", binding, purpose: "create" }))
      .not.toBe(conversationCreationScope({ accountId: "account_a", binding: { ...binding, agentId: "agent_b" }, purpose: "create" }));
    expect(conversationCreationScope({ accountId: "account_a", binding, purpose: "create" }))
      .not.toBe(conversationCreationScope({ accountId: "account_a", binding, purpose: "bootstrap" }));
  });
});
