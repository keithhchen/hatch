import { describe, expect, it } from "vitest";
import {
  conversationLibraryRetryScope,
  createConversationLibraryRetryController,
  isRetryableConversationLibraryError
} from "./conversation-library-retry.js";

describe("Conversation Library retry controller", () => {
  it("uses bounded exponential-style delays and then stops automatic retries", () => {
    const controller = createConversationLibraryRetryController({ delays: [10, 20] });
    expect(controller.nextAutomaticRetry()).toEqual({ attempt: 1, delay: 10 });
    expect(controller.nextAutomaticRetry()).toEqual({ attempt: 2, delay: 20 });
    expect(controller.nextAutomaticRetry()).toBeNull();
  });

  it("throttles focus/online triggers and starts a fresh bounded burst", () => {
    const controller = createConversationLibraryRetryController({ delays: [10], manualCooldownMs: 100 });
    expect(controller.allowManualTrigger(1_000)).toBe(true);
    expect(controller.allowManualTrigger(1_050)).toBe(false);
    expect(controller.nextAutomaticRetry()).toEqual({ attempt: 1, delay: 10 });
    expect(controller.allowManualTrigger(1_100)).toBe(true);
    expect(controller.nextAutomaticRetry()).toEqual({ attempt: 1, delay: 10 });
  });

  it("resets independently when the account or Agent binding changes", () => {
    const controller = createConversationLibraryRetryController({ delays: [10, 20] });
    const first = conversationLibraryRetryScope({
      accountId: "account_a",
      binding: { entitlementId: "ent_a", creatorId: "creator_a", agentId: "agent_a" }
    });
    const second = conversationLibraryRetryScope({
      accountId: "account_a",
      binding: { entitlementId: "ent_b", creatorId: "creator_b", agentId: "agent_b" }
    });
    controller.setScope(first);
    expect(controller.nextAutomaticRetry()).toEqual({ attempt: 1, delay: 10 });
    controller.setScope(second);
    expect(controller.nextAutomaticRetry()).toEqual({ attempt: 1, delay: 10 });
    expect(first).not.toBe(second);
  });

  it("retries generic rollout/transport failures but not semantic errors", () => {
    expect(isRetryableConversationLibraryError({ code: "network_error" })).toBe(true);
    expect(isRetryableConversationLibraryError({ code: "conversation_request_failed", status: 404 })).toBe(true);
    expect(isRetryableConversationLibraryError({ code: "conversation_request_failed", status: 503 })).toBe(true);
    expect(isRetryableConversationLibraryError({ code: "conversation_not_found", status: 404 })).toBe(false);
    expect(isRetryableConversationLibraryError({ code: "auth_invalid", status: 401 })).toBe(false);
    expect(isRetryableConversationLibraryError({ code: "conversation_request_failed", status: 403 })).toBe(false);
  });
});
