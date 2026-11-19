import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRuntimeConnection, WebConversationTransport } from "./webChatClient.js";

test("the conversation log is read through the Dashboard proxy: events after a position, or the latest turns before one", async () => {
  const urls = [];
  const transport = new WebConversationTransport(async url => { urls.push(url); return { events: [], head: 0, has_more: false }; }, { product_id: "p 1" });
  await transport.log("conv/1", { after: 12, limit: 200 });
  await transport.log("conv/1", { turns: 20 });
  await transport.log("conv/1", { turns: 20, before: 7 });
  assert.deepEqual(urls, [
    "/v1/web-chat/conversations/conv%2F1/log?product_id=p+1&after=12&limit=200",
    "/v1/web-chat/conversations/conv%2F1/log?product_id=p+1&turns=20",
    "/v1/web-chat/conversations/conv%2F1/log?product_id=p+1&turns=20&before=7"
  ]);
});

test("hello declares the position the page resumes from; the first hello of a page that holds nothing has none", () => {
  const sockets = [];
  globalThis.WebSocket = class { static OPEN = 1; constructor() { this.sent = []; sockets.push(this); } send(frame) { this.sent.push(JSON.parse(frame)); } close() {} };
  globalThis.location = { protocol: "https:", host: "example.test" };
  const connection = new BrowserRuntimeConnection("conv", { product_id: "p" }, { onOpen() {}, onEvent() {}, onClose() {} });
  connection.hello(["tool"], 42);
  connection.hello([], undefined);
  const [resumed, fresh] = sockets[0].sent;
  assert.deepEqual([resumed.type, resumed.after, resumed.conversation_id, resumed.product_id, resumed.local_tools], ["client.hello", 42, "conv", "p", ["tool"]]);
  assert.equal("after" in fresh, false);
  delete globalThis.WebSocket;
  delete globalThis.location;
});
