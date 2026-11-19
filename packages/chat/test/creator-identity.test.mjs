import assert from "node:assert/strict";
import test from "node:test";
import { creatorInitials, refineCreatorIdentity, resolveCreatorIdentity } from "../src/domain/creator-identity.js";

test("creator identity unions the Web and Desktop fallback chains", () => {
  assert.deepEqual(
    (({ productName, creatorName, creatorAvatarUrl }) => ({ productName, creatorName, creatorAvatarUrl }))(resolveCreatorIdentity({})),
    { productName: "Expert Agent", creatorName: "Hatch Expert", creatorAvatarUrl: null });
  const access = { product: { name: "Tutor", brief_spec: { fields: [] } }, creator: { display_name: "Maya", image_url: "m.png" } };
  const identity = resolveCreatorIdentity({ access });
  assert.equal(identity.productName, "Tutor");
  assert.equal(identity.creatorName, "Maya");
  assert.equal(identity.creatorAvatarUrl, "m.png");
  assert.deepEqual(identity.briefSpec, { fields: [] });
  assert.equal(resolveCreatorIdentity({ product: { product_name: "P", creator_name: "Ana", creator_avatar_url: "a.png" } }).creatorAvatarUrl, "a.png");
  assert.equal(creatorInitials("ada lovelace byron"), "AL");
});

test("a Runtime identity refines the current one only when the host binding accepts it", () => {
  const current = resolveCreatorIdentity({ access: { product: { name: "Tutor" }, creator: { name: "Maya", avatar_url: "m.png" } } });
  const message = { creator_agent: { creator: { name: "Maya R" }, product: { name: "Tutor Pro" } } };
  assert.equal(refineCreatorIdentity(current, message, () => false), current);
  assert.equal(refineCreatorIdentity(current, { creator_agent: {} }, () => true), current);
  const refined = refineCreatorIdentity(current, message, () => true);
  assert.equal(refined.productName, "Tutor Pro");
  assert.equal(refined.creatorAvatarUrl, "m.png");
});
