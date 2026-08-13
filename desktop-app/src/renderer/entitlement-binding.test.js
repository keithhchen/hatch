import { describe, expect, it } from "vitest";

import {
  entitlementRefreshNeedsReconnect,
  runtimeBindingForEntitlement,
  runtimeBindingMatches
} from "./entitlement-binding.js";

describe("Desktop runtime entitlement binding", () => {
  it("forces A → B reconnect when refresh revokes the connected entitlement", () => {
    const connectedToA = { entitlementId: "ent_A", productId: "product_A", creatorId: "creator_A" };
    const selectedB = { entitlement_id: "ent_B", product_id: "product_B", creator_id: "creator_B" };

    expect(entitlementRefreshNeedsReconnect(connectedToA, selectedB)).toBe(true);
    expect(runtimeBindingMatches(connectedToA, runtimeBindingForEntitlement(selectedB))).toBe(false);
  });

  it("keeps an exact entitlement, agent, and creator binding connected", () => {
    const selected = { entitlement_id: "ent_A", product_id: "product_A", creator_id: "creator_A" };
    expect(entitlementRefreshNeedsReconnect({
      entitlementId: "ent_A",
      productId: "product_A",
      creatorId: "creator_A"
    }, selected)).toBe(false);
  });

  it("detects product rebinding even when entitlement id is unchanged", () => {
    expect(entitlementRefreshNeedsReconnect({
      entitlementId: "ent_A",
      productId: "old_product",
      creatorId: "creator_A"
    }, { entitlement_id: "ent_A", product_id: "new_product", creator_id: "creator_A" })).toBe(true);
  });
});
