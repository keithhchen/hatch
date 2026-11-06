import assert from "node:assert/strict";
import test from "node:test";
import { WebChatCapabilityPolicy } from "../webChatRuntimeBridge.mjs";

test("Web Chat hello opens by exactly one access key: product_id (owner) or entitlement_id", () => {
  const policy = new WebChatCapabilityPolicy();
  const hello = (access) => policy.prepare({ type: "client.hello", protocol_version: "0.8", local_tools: [], ...access }, false, "token");
  assert.equal(hello({ product_id: "product" }).auth_token, "token");
  assert.equal(hello({ entitlement_id: "entitlement" }).auth_token, "token");
  assert.throws(() => hello({ product_id: "product", entitlement_id: "entitlement" }), /Invalid session start/);
  assert.throws(() => hello({}), /Invalid session start/);
});
