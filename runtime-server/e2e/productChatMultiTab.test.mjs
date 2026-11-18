import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { openPage, startStack, until } from "./productChatHarness.mjs";

// A second tab or device on the same conversation sees it live; a steered message follows its Run; a silent socket is replaced.

let stack;
before(async () => { stack = await startStack({ heartbeatMs: 150 }); });
after(async () => { await stack.close(); });

test("an idle second tab shows the other tab's message, the stream, the spinner and the end", async () => {
  const conversationId = await stack.newConversation();
  const idle = openPage(stack, conversationId);
  const busy = openPage(stack, conversationId);
  await until(() => idle.state().connection === "open" && busy.state().connection === "open", "both sessions");
  await busy.say("from the other tab");
  await until(() => idle.row("from the other tab"), "the other tab's message", 4000);
  await until(() => idle.state().activeRun, "the spinner", 4000);
  stack.model.open("from the other tab", "first");
  await until(() => idle.liveText().includes("[from the other tab:2]"), `the stream (${idle.rows().join(" | ")})`, 4000);
  stack.model.open("from the other tab", "claim", "end");
  await until(() => !idle.state().activeRun && idle.rows().some(row => row === "assistant:[from the other tab:1][from the other tab:2]"), `the end (${idle.rows().join(" | ")})`, 6000);
  idle.close(); busy.close();
});

test("a steered message stays queued until its Run takes it up, and then is part of the Run", async () => {
  const conversationId = await stack.newConversation();
  const page = openPage(stack, conversationId);
  await until(() => page.state().connection === "open", "the session");
  await page.say("first");
  await until(() => page.state().activeRun && page.liveText().includes("[first:1]"), "the Run");
  await page.say("second");
  await until(() => page.row("second")?.state === "queued", "the steer to be queued");
  stack.model.open("first", "first", "claim");
  await until(() => page.row("second") && page.row("second").state !== "queued", `the steer to be taken up (${page.rows().join(" | ")})`, 4000);
  assert.ok(page.state().activeRun, "the Run is still going");
  stack.model.open("first", "end");
  await until(() => !page.state().activeRun, "the end");
  assert.equal(page.rows().filter(row => row.startsWith("user:second")).length, 1);
  page.close();
});

test("a half-open socket is detected and replaced within the bound, and the Run's end is read", async () => {
  const conversationId = await stack.newConversation();
  const page = openPage(stack, conversationId, { overrides: { stallMs: 800 } });
  await until(() => page.state().connection === "open", "the session");
  await page.say("through the silence");
  await until(() => page.state().activeRun && page.liveText().includes("[through the silence:1]"), "the Run");
  const accepted = stack.proxy.accepted;
  stack.proxy.silence();
  const silentAt = Date.now();
  // The Run goes on and ends while the old socket carries nothing.
  stack.model.open("through the silence", "first", "claim", "end");
  await until(() => !page.state().activeRun && page.rows().some(row => row.includes("[through the silence:2]")), `the end (${page.rows().join(" | ")})`, 6000);
  assert.ok(stack.proxy.accepted > accepted, "a new connection was opened");
  assert.ok(Date.now() - silentAt < 5000);
  page.close();
});

test("the bridge ends a browser that stops answering its pings, and tells a live one it is alive", async () => {
  const url = `ws://127.0.0.1:${stack.proxy.port}/v1/web-chat/runtime`;
  const live = new WebSocket(url);
  const dead = new WebSocket(url, { autoPong: false });
  const beats = [];
  live.on("message", data => beats.push(JSON.parse(String(data)).type));
  const closed = new Promise(resolve => dead.on("close", resolve));
  await until(() => beats.length >= 2, "heartbeat frames");
  assert.equal(beats[0], "session.heartbeat");
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("the silent browser was never ended")), 2000))]);
  assert.equal(live.readyState, WebSocket.OPEN);
  live.close();
});
