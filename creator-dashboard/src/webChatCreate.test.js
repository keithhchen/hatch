import assert from "node:assert/strict";
import test from "node:test";
import { WebConversationTransport } from "./webChatClient.js";

test("a double-click on New chat is one conversation request key; the next intent gets its own", async () => {
  const keys = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const transport = new WebConversationTransport(async (_url, options) => { keys.push(JSON.parse(options.body).client_request_id); await gate; return { conversation: { id: "c" } }; }, { product_id: "p" });
  const both = Promise.all([transport.create(), transport.create()]);
  release();
  await both;
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  await transport.create();
  assert.notEqual(keys[2], keys[0]);
});

test("a failed create is retried under the same key", async () => {
  const keys = [];
  let fail = true;
  const transport = new WebConversationTransport(async (_url, options) => { keys.push(JSON.parse(options.body).client_request_id); if (fail) throw new Error("offline"); return { conversation: { id: "c" } }; }, { product_id: "p" });
  await assert.rejects(transport.create());
  fail = false;
  await transport.create();
  assert.equal(keys[0], keys[1]);
});
