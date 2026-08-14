import assert from "node:assert/strict";
import test from "node:test";
import { defaultCredential } from "./creatorLearning/objectStore.js";

test("Alibaba credentials resolve the ESM-wrapped CommonJS default provider", () => {
  const credential = defaultCredential();
  assert.equal(typeof credential.getCredential, "function");
});
