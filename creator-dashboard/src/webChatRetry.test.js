import assert from "node:assert/strict";
import test from "node:test";
import { WebConversationTransport } from "./webChatClient.js";

test("a Product answers a failed Run again through the web-chat proxy, scoped like every other call", async () => {
  const calls = [];
  const transport = new WebConversationTransport(async (url, init) => { calls.push({ url, init }); return { run_id: "run_3", outcome: "started" }; }, { entitlement_id: "e1" });
  assert.equal(transport.retriesRun, true);
  assert.deepEqual(await transport.retryRun("conv 1", "retry_7"), { run_id: "run_3", outcome: "started" });
  assert.equal(calls[0].url, "/v1/web-chat/conversations/conv%201/retry?entitlement_id=e1");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { retry_id: "retry_7", client: "web" });
});
