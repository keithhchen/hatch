import { describe, expect, it } from "vitest";

import {
  entitlementRefreshNeedsReconnect,
  runtimeBindingForEntitlement,
  runtimeBindingMatches
} from "./entitlement-binding.js";

describe("Desktop runtime entitlement binding", () => {
  const entitlementA = "7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001";
  const entitlementB = "7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1004";
  const productA = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";
  const productB = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1005";
  const creatorA = "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002";
  const creatorB = "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1006";

  it("forces A → B reconnect when refresh revokes the connected entitlement", () => {
    const connectedToA = { entitlementId: entitlementA, productId: productA, creatorId: creatorA };
    const selectedB = { entitlement_id: entitlementB, product_id: productB, creator_id: creatorB };

    expect(entitlementRefreshNeedsReconnect(connectedToA, selectedB)).toBe(true);
    expect(runtimeBindingMatches(connectedToA, runtimeBindingForEntitlement(selectedB))).toBe(false);
  });

  it("keeps an exact entitlement, agent, and creator binding connected", () => {
    const selected = { entitlement_id: entitlementA, product_id: productA, creator_id: creatorA };
    expect(entitlementRefreshNeedsReconnect({
      entitlementId: entitlementA,
      productId: productA,
      creatorId: creatorA
    }, selected)).toBe(false);
  });

  it("detects product rebinding even when entitlement id is unchanged", () => {
    expect(entitlementRefreshNeedsReconnect({
      entitlementId: entitlementA,
      productId: productA,
      creatorId: creatorA
    }, { entitlement_id: entitlementA, product_id: productB, creator_id: creatorA })).toBe(true);
  });

  it("fails closed for a legacy binding", () => {
    expect(runtimeBindingForEntitlement({
      entitlement_id: "ent_A",
      product_id: productA,
      creator_id: creatorA
    })).toBeNull();
  });
});
