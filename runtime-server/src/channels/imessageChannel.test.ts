import assert from "node:assert/strict";
import test from "node:test";
import { IMessageChannel, type SpectrumClient } from "./imessageChannel.js";
import { ChannelSendError, type InboundEvent } from "./types.js";

const ALICE = "+15550000001";
const ADDRESS = { threadId: ALICE, senderId: ALICE };
const LINE = "+15559999999";
const CONFIG = { projectId: "project", projectSecret: "secret", address: LINE };

const dm = (id: string, content: unknown, overrides: Record<string, unknown> = {}) => [{ type: "dm", phone: LINE }, { id, direction: "inbound", sender: { id: ALICE }, content, ...overrides }];
type Inbound = ReturnType<SpectrumClient["messages"]> extends AsyncIterable<infer Item> ? Item : never;

/** Automated test double for Spectrum: a stream we feed by hand, no network. */
function fakeClient(script: { failWith?: Error; endAfterScript?: boolean } = {}, inbound: unknown[] = []) {
  const sent: Array<{ address: string; text: string }> = [];
  const attachments: Array<{ guid: string; phone: string }> = [];
  let stops = 0;
  let wake = () => {};
  const stopped = new Promise<void>(resolve => { wake = resolve; });
  const client: SpectrumClient = {
    async *messages() {
      for (const item of inbound) yield item as Inbound;
      if (script.failWith) throw script.failWith;
      if (script.endAfterScript) return;
      await stopped;
    },
    sendText: async (address, text) => { sent.push({ address, text }); },
    attachment: async (guid, phone) => { attachments.push({ guid, phone }); return guid === "known" ? Buffer.from("bytes") : undefined; },
    stop: async () => { stops += 1; wake(); },
  };
  return { client, sent, attachments, stops: () => stops };
}

/** Listens until every expected event has arrived, then aborts. */
async function received(inbound: unknown[], expected: number): Promise<InboundEvent[]> {
  const fake = fakeClient({}, inbound);
  const channel = new IMessageChannel(CONFIG, async () => fake.client);
  const controller = new AbortController();
  const events: InboundEvent[] = [];
  if (expected === 0) setTimeout(() => controller.abort(), 20);
  await channel.listen(async batch => { events.push(...batch); if (events.length >= expected) controller.abort(); }, controller.signal);
  return events;
}

test("available needs the project and the line", () => {
  assert.equal(new IMessageChannel(CONFIG).available(), true);
  for (const missing of ["projectId", "projectSecret", "address"]) assert.equal(new IMessageChannel({ ...CONFIG, [missing]: undefined }).available(), false);
});

test("a server with no Photon configuration never connects", async () => {
  let connects = 0;
  const channel = new IMessageChannel({}, async () => { connects += 1; return fakeClient().client; });
  channel.available();
  channel.connectUrl("HATCH-ABCD2345");
  assert.equal(connects, 0);
});

test("connectUrl prefills the code for a phone line and has nothing for an email line", () => {
  assert.equal(new IMessageChannel(CONFIG).connectUrl("HATCH-ABCD2345"), `sms:${LINE}?body=HATCH-ABCD2345`);
  assert.equal(new IMessageChannel({ ...CONFIG, address: "line@example.com" }).connectUrl("HATCH-ABCD2345"), undefined);
  assert.equal(new IMessageChannel({}).connectUrl("HATCH-ABCD2345"), undefined);
});

test("text maps to an event keyed by the sender's address and the message id", async () => {
  assert.deepEqual(await received([dm("guid-1", { type: "text", text: "你好" })], 1), [{ eventId: "guid-1", address: ADDRESS, text: "你好" }]);
});

test("an attachment keeps its name and size, and its ref routes back to the line", async () => {
  const content = { type: "attachment", id: "att-1", name: "notes.pdf", mimeType: "application/pdf", size: 12 };
  assert.deepEqual(await received([dm("guid-1", content)], 1), [{ eventId: "guid-1", address: ADDRESS, file: { ref: `${LINE}|att-1`, name: "notes.pdf", size: 12 } }]);
});

test("an image always gets a name with an image extension", async () => {
  const names = async (name: string, mimeType: string) => (await received([dm("guid-1", { type: "attachment", id: "a", name, mimeType })], 1))[0]!.file!.name;
  assert.equal(await names("IMG_0001.JPG", "image/jpeg"), "IMG_0001.JPG");
  assert.equal(await names("IMG_0001", "image/jpeg"), "IMG_0001.jpg");
  assert.equal(await names("", "image/png"), "photo.png");
  assert.equal(await names("scan", "IMAGE/WEBP"), "scan.webp");
  assert.equal(await names("IMG_0002.HEIC", "image/heic"), "IMG_0002.HEIC");
  assert.equal(await names("", "application/pdf"), "file");
});

test("a message with text and attachments becomes one event per part, each with its own id", async () => {
  const items = [
    { id: "p:0/guid-1", content: { type: "attachment", id: "att-1", name: "a.png", mimeType: "image/png" } },
    { id: "p:1/guid-1", content: { type: "text", text: "看这个" } },
  ];
  assert.deepEqual(await received([dm("guid-1", { type: "group", items })], 2), [
    { eventId: "p:0/guid-1", address: ADDRESS, file: { ref: `${LINE}|att-1`, name: "a.png" } },
    { eventId: "p:1/guid-1", address: ADDRESS, text: "看这个" },
  ]);
});

test("an inline reply reads as what it says", async () => {
  assert.deepEqual(await received([dm("guid-1", { type: "reply", content: { type: "text", text: "确认" }, target: {} })], 1), [{ eventId: "guid-1", address: ADDRESS, text: "确认" }]);
});

test("a voice note is an event we can't read yet, so the Expert hears why", async () => {
  assert.deepEqual(await received([dm("guid-1", { type: "voice", id: "v", name: "a.caf", mimeType: "audio/x-caf" })], 1), [{ eventId: "guid-1", address: ADDRESS }]);
});

test("groups, our own messages, senderless events, reactions and read receipts are ignored", async () => {
  const text = { type: "text", text: "x" };
  assert.deepEqual(await received([
    [{ type: "group", phone: LINE }, { id: "1", direction: "inbound", sender: { id: ALICE }, content: text }],
    dm("2", text, { direction: "outbound" }),
    dm("3", text, { sender: undefined }),
    dm("4", text, { sender: { id: "" } }),
    dm("5", { type: "reaction", emoji: "👍", target: {} }),
    dm("6", { type: "read", target: {} }),
    dm("7", { type: "typing", state: "start" }),
    dm("8", { type: "poll_option", title: "x", selected: true }),
  ], 0), []);
});

test("send delivers plain text to the address and reuses one connection", async () => {
  const fake = fakeClient();
  let connects = 0;
  const channel = new IMessageChannel(CONFIG, async () => { connects += 1; return fake.client; });
  await channel.send(ADDRESS, { text: "一" }, "k:0");
  await channel.send(ADDRESS, { text: "二", replyTo: "ignored" }, "k:0");
  assert.deepEqual(fake.sent, [{ address: ALICE, text: "一" }, { address: ALICE, text: "二" }]);
  assert.equal(connects, 1);
});

test("download reads the bytes through the line the file arrived on", async () => {
  const fake = fakeClient();
  const channel = new IMessageChannel(CONFIG, async () => fake.client);
  assert.deepEqual(await channel.download({ ref: `${LINE}|known`, name: "a.png" }), Buffer.from("bytes"));
  assert.deepEqual(fake.attachments, [{ guid: "known", phone: LINE }]);
  await assert.rejects(channel.download({ ref: `${LINE}|gone`, name: "a.png" }), /not found/);
});

test("aborting ends listen and closes the client", async () => {
  const fake = fakeClient();
  const channel = new IMessageChannel(CONFIG, async () => fake.client);
  const controller = new AbortController();
  const listening = channel.listen(async () => {}, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await listening;
  assert.ok(fake.stops() >= 1);
});

test("an already aborted signal closes straight away", async () => {
  const fake = fakeClient();
  await new IMessageChannel(CONFIG, async () => fake.client).listen(async () => assert.fail("no events"), AbortSignal.abort());
  assert.ok(fake.stops() >= 1);
});

test("a stream error rejects and closes, and the next listen connects afresh", async () => {
  const failing = fakeClient({ failWith: new Error("line down") });
  const healthy = fakeClient({}, [dm("guid-1", { type: "text", text: "回来了" })]);
  const clients = [failing.client, healthy.client];
  const channel = new IMessageChannel(CONFIG, async () => clients.shift()!);
  await assert.rejects(channel.listen(async () => {}, new AbortController().signal), /line down/);
  assert.equal(failing.stops(), 1);
  const controller = new AbortController();
  const events: InboundEvent[] = [];
  await channel.listen(async batch => { events.push(...batch); controller.abort(); }, controller.signal);
  assert.equal(events[0]!.text, "回来了");
});

test("a stream that ends without an abort rejects, so the listener can't die silently", async () => {
  const fake = fakeClient({ endAfterScript: true });
  await assert.rejects(new IMessageChannel(CONFIG, async () => fake.client).listen(async () => {}, new AbortController().signal), /stream ended/);
  assert.equal(fake.stops(), 1);
});

test("a failed connection rejects listen and send, and the next call tries again", async () => {
  const fake = fakeClient();
  let attempts = 0;
  const channel = new IMessageChannel(CONFIG, async () => { attempts += 1; if (attempts === 1) throw new Error("bad secret"); return fake.client; });
  await assert.rejects(channel.listen(async () => {}, new AbortController().signal), /bad secret/);
  await channel.send(ADDRESS, { text: "好了" }, "k:0");
  assert.equal(fake.sent.length, 1);
});

test("capabilities", () => {
  assert.deepEqual(new IMessageChannel(CONFIG).capabilities(), { stream: false, edit: false, typing: false, buttons: false, maxLength: 8000, canInitiate: true, idempotentSend: false });
});

test("send never truncates: a message at maxLength goes whole", async () => {
  const fake = fakeClient();
  const channel = new IMessageChannel(CONFIG, async () => fake.client);
  const text = "好".repeat(channel.capabilities().maxLength);
  await channel.send(ADDRESS, { text }, "k:0");
  assert.equal(fake.sent[0]!.text, text);
});

test("a send that throws is an ambiguous ChannelSendError", async () => {
  const fake = fakeClient();
  fake.client.sendText = async () => { throw new Error("timeout"); };
  const error = await new IMessageChannel(CONFIG, async () => fake.client).send(ADDRESS, { text: "x" }, "k:0").then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof ChannelSendError);
  assert.equal(error.failure, "ambiguous");
});

test("recorded payload: a redelivered message parses to the same event, and a contact card is an event without text or file", async () => {
  const first = await received([dm("guid-1", { type: "text", text: "hi" }), dm("guid-1", { type: "text", text: "hi" })], 2);
  assert.equal(first[0]!.eventId, first[1]!.eventId);
  assert.deepEqual(await received([dm("guid-2", { type: "contact", name: "x" })], 1), [{ eventId: "guid-2", address: ADDRESS }]);
});
