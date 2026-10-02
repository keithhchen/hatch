import assert from "node:assert/strict";
import test from "node:test";
import { WebChatCapabilityPolicy } from "../webChatRuntimeBridge.mjs";

test("Web Chat declares no local tools on hello and message", () => {
  const policy = new WebChatCapabilityPolicy();
  const hello = policy.prepare({ type: "client.hello", protocol_version: "0.8", conversation_id: "conversation", entitlement_id: "entitlement", local_tools: [] }, false, "registry-token");
  assert.deepEqual(hello.local_tools, []);
  assert.equal(hello.auth_token, "registry-token");
  const message = policy.prepare({ type: "client.message", run_id: "run", conversation_id: "conversation", local_tools: [], message: { role: "user", content: "Hello" } }, true, "registry-token");
  assert.deepEqual(message.local_tools, []);
  assert.equal(message.auth_token, undefined);
});

test("Web Chat rejects client local tools and non-image attachments", () => {
  const policy = new WebChatCapabilityPolicy();
  assert.throws(() => policy.prepare({ type: "client.hello", local_tools: ["file_read"] }, false, "token"), /Invalid session start/);
  assert.throws(() => policy.prepare({ type: "client.message", local_tools: ["file_read"], message: { role: "user", content: "" } }, true, "token"), /Local tools unavailable/);
  assert.throws(() => policy.prepare({ type: "client.message", local_tools: [], message: { role: "user", content: "", attachments: [{ kind: "asset", media_type: "application/pdf" }] } }, true, "token"), /Only image attachments/);
});
