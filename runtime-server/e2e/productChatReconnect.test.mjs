import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openPage, sleep, startStack, tabStorage, until } from "./productChatHarness.mjs";

// Product Chat across a dropped network and a reload: never lost, never duplicated, never stuck "sending".

let stack;
before(async () => { stack = await startStack({ heartbeatMs: 150 }); });
after(async () => { await stack.close(); });
const userCopies = async (conversationId, text) => (await stack.messages(conversationId)).filter(message => message.role === "user" && message.content === text).length;

test("a 10 s outage with a send queued: it is delivered once, the Run answers, nothing stays sending", async () => {
  const conversationId = await stack.newConversation();
  const page = openPage(stack, conversationId);
  await until(() => page.state().connection === "open", "the session to open");
  stack.proxy.drop();
  await until(() => page.state().connection !== "open", "the drop to be noticed");
  await page.say("sent in the outage");
  assert.equal(page.row("sent in the outage")?.state, "sending");
  await sleep(10_000);
  stack.model.open("sent in the outage", "first", "claim", "end");
  stack.proxy.restore();
  await until(() => page.rows().some(row => row.startsWith("assistant:") && row.includes("[sent in the outage:2]")), "the reply after the outage", 25_000);
  assert.equal(await userCopies(conversationId, "sent in the outage"), 1, "stored once");
  assert.equal(page.state().messages.filter(message => message.state === "sending").length, 0, page.rows().join(" | "));
  assert.equal(page.state().draft, "");
  page.close();
});

test("a reload with an unacknowledged send: the message goes out once, under its key", async () => {
  const conversationId = await stack.newConversation();
  const storage = tabStorage();
  const before = openPage(stack, conversationId, { storage });
  await until(() => before.state().connection === "open", "the session to open");
  stack.proxy.drop();
  await until(() => before.state().connection !== "open", "the drop to be noticed");
  await before.say("sent, then reloaded");
  before.close();
  stack.model.open("sent, then reloaded", "first", "claim", "end");
  stack.proxy.restore();
  const after = openPage(stack, conversationId, { storage });
  await until(() => after.rows().some(row => row.startsWith("assistant:") && row.includes("[sent, then reloaded:2]")), "the reply after the reload", 20_000);
  assert.equal(await userCopies(conversationId, "sent, then reloaded"), 1);
  assert.equal(after.rows().filter(row => row === "user:sent, then reloaded").length, 1, after.rows().join(" | "));
  // And a second reload sends nothing more.
  after.close();
  const again = openPage(stack, conversationId, { storage });
  await until(() => again.state().connection === "open", "the session to open again");
  await sleep(300);
  assert.equal(await userCopies(conversationId, "sent, then reloaded"), 1);
  again.close();
});

const quietCopies = async (from, conversationId, text) => (await from.messages(conversationId)).filter(message => message.role === "user" && message.content === text).length;

test("a send nobody answers goes back to the composer with an error, and the same message is not sent twice", async () => {
  // A bridge that beats rarely, so it is the page's own clock that notices.
  const quiet = await startStack({ heartbeatMs: 600_000 });
  const stack = quiet;
  const conversationId = await stack.newConversation();
  const page = openPage(stack, conversationId, { overrides: { ackTimeoutMs: 600, stallMs: 0 } });
  await until(() => page.state().connection === "open", "the session to open");
  stack.proxy.silence();
  await page.say("into the void");
  await until(() => page.state().draft === "into the void", "the message back in the composer");
  assert.ok(page.state().error);
  assert.equal(page.row("into the void"), undefined);
  stack.model.open("into the void", "first", "claim", "end");
  stack.proxy.restore();
  await until(() => page.state().connection === "open", "a new session");
  await page.say("into the void");
  await until(() => page.rows().some(row => row.includes("[into the void:2]")), "the reply");
  assert.equal(await quietCopies(stack, conversationId, "into the void"), 1);
  page.close();
  await quiet.close();
});
