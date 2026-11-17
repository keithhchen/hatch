import { describe, expect, it } from "vitest";
import { normalizeProductOpenLink, normalizeProductOpenPayload } from "./product-open.js";

const productId = "9cc7b10c-4db0-4d8a-8c2f-2e2c8cba1003";

describe("Desktop product deep link", () => {
  it("accepts a product link", () => {
    expect(normalizeProductOpenLink(`hatch://products/open?product_id=${productId}`)).toEqual({ productId });
    expect(normalizeProductOpenLink(`hatch://products/open?product_id=${productId}&entitlement_id=ignored`)).toEqual({ productId });
  });

  it("rejects other hosts and malformed identifiers", () => {
    expect(normalizeProductOpenLink(`hatch://agents/open?product_id=${productId}`)).toBeNull();
    expect(normalizeProductOpenLink("hatch://products/open?entitlement_id=7aa7b10c-4db0-4d8a-8c2f-2e2c8cba1001")).toBeNull();
    expect(normalizeProductOpenLink(`hatch://products/open?product_id=${productId.toUpperCase()}`)).toBeNull();
  });

  it("normalizes the native payload list", () => {
    expect(normalizeProductOpenPayload([`hatch://products/open?product_id=${productId}`, "nope"])).toEqual([{ productId }]);
  });
});
