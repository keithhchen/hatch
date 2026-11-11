import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { LineChannel } from "./lineChannel.js";
import { ChannelSendError } from "./types.js";

const TASK = "123e4567-e89b-12d3-a456-426614174000";
const TO = { threadId: "U1", senderId: "U1" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLY = "https://api.line.me/v2/bot/message/reply";
const PUSH = "https://api.line.me/v2/bot/message/push";

type Call = { url: string; init: RequestInit; body: any };

/** Answers each request with `respond`; records what was asked. */
function channel(respond: (url: string) => Response = () => new Response("{}"), config: Partial<ConstructorParameters<typeof LineChannel>[0]> = {}) {
  const calls: Call[] = [];
  const fake = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body as string) : undefined });
    return respond(url);
  }) as typeof fetch;
  return { calls, line: new LineChannel({ channelSecret: "secret", accessToken: "token", basicId: "@hatch", ...config }, fake) };
}
const fresh = () => `tok|${Date.now()}`;
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];
const parse = (...events: unknown[]) => channel().line.parse(Buffer.from(JSON.stringify({ destination: "U0", events }))).events;
const user = { type: "user", userId: "U1" };
const base = { webhookEventId: "E1", timestamp: 1700000000000, replyToken: "tok", source: user };
const shared = { eventId: "E1", address: TO, messageRef: "tok|1700000000000" };

test("available needs secret, token and basic id", () => {
  assert.equal(channel().line.available(), true);
  for (const missing of ["channelSecret", "accessToken", "basicId"]) assert.equal(channel(undefined, { [missing]: undefined }).line.available(), false);
});

test("verify accepts LINE's signature over the raw bytes and rejects anything else", () => {
  const { line } = channel();
  const raw = Buffer.from('{"events":[{"text":"café \\n"}]}');
  const signature = createHmac("sha256", "secret").update(raw).digest("base64");
  assert.equal(line.verify(raw, { "x-line-signature": signature }), true);
  assert.equal(line.verify(Buffer.from(`${raw} `), { "x-line-signature": signature }), false);
  assert.equal(line.verify(raw, { "x-line-signature": createHmac("sha256", "other").update(raw).digest("base64") }), false);
  assert.equal(line.verify(raw, { "x-line-signature": "short" }), false);
  assert.equal(line.verify(raw, {}), false);
  assert.equal(channel(undefined, { channelSecret: undefined }).line.verify(raw, { "x-line-signature": signature }), false);
});

test("parse maps text, image and file messages", () => {
  assert.deepEqual(parse({ ...base, type: "message", message: { id: "1", type: "text", text: "hi" } }), [{ ...shared, text: "hi" }]);
  assert.deepEqual(parse({ ...base, type: "message", message: { id: "2", type: "image", contentProvider: { type: "line" } } }), [{ ...shared, file: { ref: "2", name: "photo.jpg" } }]);
  assert.deepEqual(parse({ ...base, type: "message", message: { id: "3", type: "file", fileName: "a.pdf", fileSize: 2138 } }), [{ ...shared, file: { ref: "3", name: "a.pdf", size: 2138 } }]);
});

test("parse reads a video like an image: its content is fetched by message id", () => {
  assert.deepEqual(parse({ ...base, type: "message", message: { id: "5", type: "video", duration: 1000 } }), [{ ...shared, file: { ref: "5", name: "video.mp4" } }]);
});

test("parse leaves other message types with no text and no file", () => {
  for (const type of ["sticker", "location"]) assert.deepEqual(parse({ ...base, type: "message", message: { id: "4", type } }), [shared]);
});

test("parse turns task postbacks into buttons and skips other postbacks", () => {
  assert.deepEqual(parse({ ...base, type: "postback", postback: { data: `t:${TASK}:approve` } }), [{ ...shared, button: { taskId: TASK, action: "approve" } }]);
  assert.deepEqual(parse({ ...base, type: "postback", postback: { data: `t:${TASK}:decline` } })[0]?.button, { taskId: TASK, action: "decline" });
  assert.deepEqual(parse({ ...base, type: "postback", postback: { data: "menu" } }), []);
  assert.deepEqual(parse({ ...base, type: "postback", postback: { data: `t:${TASK}:explode` } }), []);
});

test("parse skips groups, rooms and unrelated events, and takes an empty check", () => {
  const text = { id: "1", type: "text", text: "hi" };
  assert.deepEqual(parse(), []);
  assert.deepEqual(channel().line.parse(Buffer.from("{}")).events, []);
  assert.deepEqual(parse({ ...base, type: "message", message: text, source: { type: "group", groupId: "G", userId: "U1" } }), []);
  assert.deepEqual(parse({ ...base, type: "message", message: text, source: { type: "room", roomId: "R", userId: "U1" } }), []);
  assert.deepEqual(parse({ ...base, type: "follow" }, { ...base, type: "unsend" }), []);
});

test("parse leaves messageRef off without a reply token, and keeps events in order", () => {
  const { replyToken: _, ...standby } = base;
  assert.deepEqual(parse({ ...standby, type: "message", message: { id: "1", type: "text", text: "hi" } }), [{ eventId: "E1", address: TO, text: "hi" }]);
  assert.deepEqual(parse({ ...base, type: "follow" }, { ...base, webhookEventId: "E2", type: "message", message: { id: "1", type: "text", text: "a" } }, { ...base, webhookEventId: "E3", type: "message", message: { id: "2", type: "text", text: "b" } }).map(event => event.eventId), ["E2", "E3"]);
});

test("send replies to a fresh token, with no retry key", async () => {
  const { line, calls } = channel();
  await line.send(TO, { text: "hello", replyTo: fresh() }, "k:0");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, REPLY);
  assert.deepEqual(calls[0]!.body, { replyToken: "tok", messages: [{ type: "text", text: "hello" }] });
  assert.equal(header(calls[0]!, "authorization"), "Bearer token");
  assert.equal(header(calls[0]!, "x-line-retry-key"), undefined);
});

test("send pushes with a UUID retry key when there's no usable token", async () => {
  for (const replyTo of [undefined, `tok|${Date.now() - 50_000}`, "|1700000000000", "tok|garbage", "tok"]) {
    const { line, calls } = channel();
    await line.send(TO, { text: "hello", ...(replyTo ? { replyTo } : {}) }, "k:0");
    assert.equal(calls.length, 1, String(replyTo));
    assert.equal(calls[0]!.url, PUSH);
    assert.deepEqual(calls[0]!.body, { to: "U1", messages: [{ type: "text", text: "hello" }] });
    assert.match(header(calls[0]!, "x-line-retry-key")!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

test("send falls back to push when the reply fails", async () => {
  const { line, calls } = channel(url => url === REPLY ? new Response('{"message":"Invalid reply token"}', { status: 400 }) : new Response("{}"));
  await line.send(TO, { text: "hello", replyTo: fresh() }, "k:0");
  assert.deepEqual(calls.map(call => call.url), [REPLY, PUSH]);
});

test("send throws when push fails, including after a failed reply", async () => {
  const failing = () => new Response('{"message":"You have reached your monthly limit."}', { status: 429 });
  await assert.rejects(channel(failing).line.send(TO, { text: "hello" }, "k:0"), /LINE push failed: You have reached your monthly limit/);
  const both = channel(failing);
  await assert.rejects(both.line.send(TO, { text: "hello", replyTo: fresh() }, "k:0"), /LINE push failed/);
  assert.equal(both.calls.length, 2);
  await assert.rejects(channel(() => new Response("nope", { status: 500 })).line.send(TO, { text: "hello" }, "k:0"), /LINE push failed: 500/);
});

test("send puts buttons on the message as postback quick replies", async () => {
  const { line, calls } = channel();
  await line.send(TO, { text: "hello", buttons: [
    { label: "确认", taskId: TASK, action: "approve" },
    { label: `${"x".repeat(19)}😀 too long`, taskId: TASK, action: "decline" },
  ] }, "k:0");
  const items = calls[0]!.body.messages[0].quickReply.items;
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { type: "action", action: { type: "postback", label: "确认", data: `t:${TASK}:approve`, displayText: "确认" } });
  assert.equal(items[1].action.label, "x".repeat(19));
  assert.equal(items[1].action.data, `t:${TASK}:decline`);
});

test("a button's data parses back to the same task", async () => {
  const { line, calls } = channel();
  await line.send(TO, { text: "ok?", buttons: [{ label: "确认", taskId: TASK, action: "approve" }] }, "k:0");
  const data = calls[0]!.body.messages[0].quickReply.items[0].action.data;
  assert.deepEqual(parse({ ...base, type: "postback", postback: { data } })[0]?.button, { taskId: TASK, action: "approve" });
});

test("download fetches content from the data host", async () => {
  const { line, calls } = channel(() => new Response(Buffer.from("bytes")));
  assert.deepEqual(await line.download({ ref: "325708", name: "a.pdf" }), Buffer.from("bytes"));
  assert.equal(calls[0]!.url, "https://api-data.line.me/v2/bot/message/325708/content");
  assert.equal(header(calls[0]!, "authorization"), "Bearer token");
  assert.equal(line.maxFileBytes, 20 * 1024 * 1024);
});

test("download throws on an error and on content still being prepared", async () => {
  await assert.rejects(channel(() => new Response("{}", { status: 410 })).line.download({ ref: "1", name: "a" }), /LINE file download failed: 410/);
  await assert.rejects(channel(() => new Response(null, { status: 202 })).line.download({ ref: "1", name: "a" }), /LINE file download failed: 202/);
});

test("connectUrl prefills the code, with the id and text percent-encoded", () => {
  assert.equal(channel().line.connectUrl("HATCH-ABCD2345"), "https://line.me/R/oaMessage/%40hatch/?HATCH-ABCD2345");
  assert.equal(channel(undefined, { basicId: undefined }).line.connectUrl("HATCH-ABCD2345"), undefined);
});

test("identifies itself as the shared LINE account", () => {
  const { line } = channel();
  assert.equal(line.kind, "line");
  assert.equal(line.scope, "");
});

test("capabilities", () => {
  assert.deepEqual(channel().line.capabilities(), { stream: false, edit: false, typing: false, buttons: true, maxLength: 5000, canInitiate: true, idempotentSend: true });
});

test("send never truncates or splits: a message at maxLength goes whole", async () => {
  const { line, calls } = channel();
  const text = "a".repeat(line.capabilities().maxLength);
  await line.send(TO, { text }, "k:0");
  assert.equal(calls[0]!.body.messages.length, 1);
  assert.equal(calls[0]!.body.messages[0].text, text);
});

test("the outbox key becomes the same retry key every time, and different keys differ", async () => {
  const keys: string[] = [];
  for (const key of ["a:0", "a:0", "a:1"]) {
    const { line, calls } = channel();
    await line.send(TO, { text: "hi" }, key);
    keys.push(header(calls[0]!, "x-line-retry-key")!);
  }
  assert.match(keys[0]!, UUID);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

test("send failures are classified for the outbox", async () => {
  const classify = async (respond: () => Response | Promise<Response>) => {
    const error = await channel(respond as () => Response).line.send(TO, { text: "x" }, "k:0").then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ChannelSendError);
    return error;
  };
  assert.equal((await classify(() => new Response("{}", { status: 429 }))).failure, "definite");
  const denied = await classify(() => new Response("{}", { status: 403 }));
  assert.deepEqual([denied.failure, denied.options.access], ["permanent", true]);
  const bad = await classify(() => new Response("{}", { status: 400 }));
  assert.deepEqual([bad.failure, bad.options.access], ["permanent", false]);
  assert.equal((await classify(() => new Response("{}", { status: 500 }))).failure, "ambiguous");
  assert.equal((await classify(() => { throw new Error("timeout"); })).failure, "ambiguous");
});

test("recorded payload: a redelivered webhook parses to the same event ids", () => {
  const payload = { ...base, type: "message", message: { id: "9", type: "text", text: "hi" } };
  assert.deepEqual(parse(payload).map(event => event.eventId), parse(payload).map(event => event.eventId));
  assert.equal(parse(payload, payload).length, 2);
});

test("recorded payload: an unfollow and a beacon yield nothing, a sticker yields a bare event", () => {
  assert.deepEqual(parse({ ...base, type: "unfollow" }, { ...base, type: "beacon" }), []);
  assert.deepEqual(parse({ ...base, type: "message", message: { id: "5", type: "sticker", packageId: "1", stickerId: "2" } }), [shared]);
});

test("a voice message is an m4a, fetched by its message id like an image", async () => {
  const audio = { id: "468789577898262530", type: "audio", duration: 60000, contentProvider: { type: "line" } };
  assert.deepEqual(parse({ ...base, type: "message", message: audio }), [{ ...shared, file: { ref: "468789577898262530", name: "voice.m4a" } }]);
  const { line, calls } = channel(() => new Response(Buffer.from("m4a-bytes")));
  assert.equal((await line.download({ ref: "468789577898262530", name: "voice.m4a" })).toString(), "m4a-bytes");
  assert.equal(calls[0]!.url, "https://api-data.line.me/v2/bot/message/468789577898262530/content");
});
