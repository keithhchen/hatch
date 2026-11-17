import assert from "node:assert/strict";
import test from "node:test";
import { WebChatCapabilityPolicy } from "../webChatRuntimeBridge.mjs";

test("Web Chat hello opens by product_id alone and refuses entitlement_id", () => {
  const policy = new WebChatCapabilityPolicy();
  const hello = (access) => policy.prepare({ type: "client.hello", protocol_version: "0.8", local_tools: [], ...access }, false, "token");
  assert.equal(hello({ product_id: "product" }).auth_token, "token");
  assert.throws(() => hello({ entitlement_id: "entitlement" }), /Invalid session start/);
  assert.throws(() => hello({ product_id: "product", entitlement_id: "entitlement" }), /Invalid session start/);
  assert.throws(() => hello({}), /Invalid session start/);
});
