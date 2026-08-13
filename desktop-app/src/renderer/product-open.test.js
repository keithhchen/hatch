import { describe, expect, it } from "vitest";
import { normalizeProductOpenLink, normalizeProductOpenPayload } from "./product-open.js";

const entitlementId = "7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001";
const creatorId = "8bb7b10c-4db0-4d8a-8c2f-2e2c8cba1002";
const productId = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";

describe("Desktop product deep link", () => {
  it("accepts the canonical product-open URL", () => {
    const link = "hatch://products/open?entitlement_id=" + entitlementId
      + "&product_id=" + productId + "&creator_id=" + creatorId;
    expect(normalizeProductOpenLink(link)).toEqual({ entitlementId, productId, creatorId });
  });

  it("rejects web, legacy, malformed, and non-v4 links", () => {
    expect(normalizeProductOpenLink("https://hatch.tokenquadrant.cn/products/" + productId)).toBeNull();
    expect(normalizeProductOpenLink("hatch://agents/open?entitlement_id=" + entitlementId + "&product_id=" + productId)).toBeNull();
    expect(normalizeProductOpenLink("hatch://products/open?entitlement_id=ent_old&product_id=" + productId)).toBeNull();
    expect(normalizeProductOpenLink("hatch://products/open?entitlement_id=" + entitlementId.toUpperCase() + "&product_id=" + productId)).toBeNull();
  });

  it("normalizes startup/event payloads and drops hostile entries", () => {
    const link = "hatch://products/open?entitlement_id=" + entitlementId + "&product_id=" + productId;
    expect(normalizeProductOpenPayload([link, "file:///tmp/evil"]))
      .toEqual([{ entitlementId, productId, creatorId: "" }]);
  });
});
