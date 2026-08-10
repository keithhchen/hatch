import { describe, expect, it } from "vitest";

import { canUseAnotherAccountFromNetworkError } from "./network-error-recovery.js";

describe("Network Error account recovery", () => {
  it("offers local sign-out when an explicit sign-in was saved before downstream failure", () => {
    expect(canUseAnotherAccountFromNetworkError({ accessToken: "saved-token" })).toBe(true);
  });

  it("keeps a pre-session startup failure retry-only", () => {
    expect(canUseAnotherAccountFromNetworkError(null)).toBe(false);
  });
});
