import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { test } from "node:test";
import { conformance, fakeFetch, TIMEOUT } from "./adapterConformance.js";
import { WeComBotChannel, type WeComBotCredentials } from "./wecomBotChannel.js";
import { WeComCrypto } from "./wecomCrypto.js";

const KEY = Buffer.alloc(32, 7).toString("base64").slice(0, 43);
const CREDENTIALS: WeComBotCredentials = { token: "tok", encodingAesKey: KEY };
const crypto = new WeComCrypto("tok", KEY);
const REPLY = "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=RC1";
const TO = { threadId: "zhangsan", senderId: "zhangsan" };

/** A callback as WeCom sends it: the plain JSON sealed in `encrypt`, the signature in the query. */
function callback(plain: unknown, token = "tok") {
  const encrypt = crypto.encrypt(JSON.stringify(plain));
  const [timestamp, nonce] = ["1700000000", "n0nce"];
  const signature = new WeComCrypto(token, KEY).sign(timestamp, nonce, encrypt);
  return { raw: Buffer.from(JSON.stringify({ encrypt })), query: new URLSearchParams({ msg_signature: signature, timestamp, nonce }) };
}
const message = (msgtype: string, extra: object = {}, group = false, msgid = "m1") => callback({
  msgid, aibotid: "bot1", chattype: group ? "group" : "single", ...(group ? { chatid: "wrcg1" } : {}),
  from: { userid: "zhangsan" }, response_url: REPLY, msgtype, ...extra,
});
const parse = (channel: WeComBotChannel, call: { raw: Buffer }) => channel.parse(call.raw) as { events: any[]; respond?: unknown };

test("available needs a token and a 43 character EncodingAESKey", () => {
  assert.equal(new WeComBotChannel(CREDENTIALS, "acct").available(), true);
  assert.equal(new WeComBotChannel({ ...CREDENTIALS, token: "" }, "acct").available(), false);
  assert.equal(new WeComBotChannel({ ...CREDENTIALS, encodingAesKey: "" }, "acct").available(), false);
  assert.equal(new WeComBotChannel({ ...CREDENTIALS, encodingAesKey: "short" }, "acct").available(), false);
});

test("capabilities: a final reply into a one-time response_url", () => {
  const channel = new WeComBotChannel(CREDENTIALS, "acct");
  assert.equal(channel.kind, "wecom");
  assert.equal(channel.scope, "acct");
  assert.equal(channel.connectUrl("HATCH-ABCDEFGH"), undefined);
  assert.deepEqual(channel.capabilities(), { stream: false, edit: false, typing: false, buttons: false, maxLength: 6826, replyWindowMs: 3_600_000, canInitiate: false, idempotentSend: false });
  assert.ok(6826 * 3 <= 20480);
});

test("signature: accepts the right one, refuses wrong, wrong token, tampered ciphertext and missing query", () => {
  const channel = new WeComBotChannel(CREDENTIALS, "acct");
  const good = message("text", { text: { content: "hi" } });
  assert.equal(channel.verify(good.raw, {}, good.query), true);
  const wrong = new URLSearchParams(good.query); wrong.set("msg_signature", "0".repeat(40));
  assert.equal(channel.verify(good.raw, {}, wrong), false);
  const other = message("text", { text: { content: "hi" } }, false, "m1");
  assert.equal(channel.verify(other.raw, {}, good.query), false);
  const foreign = callback({ msgid: "x" }, "other-token");
  assert.equal(channel.verify(foreign.raw, {}, foreign.query), false);
  assert.equal(channel.verify(good.raw, {}), false);
  assert.equal(channel.verify(good.raw, {}, new URLSearchParams()), false);
  assert.equal(channel.verify(Buffer.from("nonsense"), {}, good.query), false);
});

test("challenge answers the echostr with its plaintext, and refuses a forged one", () => {
  const channel = new WeComBotChannel(CREDENTIALS, "acct");
  const echostr = crypto.encrypt("hello-echo");
  const query = new URLSearchParams({ msg_signature: crypto.sign("1700000000", "n1", echostr), timestamp: "1700000000", nonce: "n1", echostr });
  assert.equal(channel.challenge(query), "hello-echo");
  query.set("msg_signature", "0".repeat(40));
  assert.equal(channel.challenge(query), undefined);
  assert.equal(channel.challenge(new URLSearchParams()), undefined);
});

test("a single chat text: thread and sender are the user, the response_url rides as messageRef", () => {
  const { events } = parse(new WeComBotChannel(CREDENTIALS, "acct"), message("text", { text: { content: "hello" } }));
  assert.deepEqual(events, [{ eventId: "m1", address: { threadId: "zhangsan", senderId: "zhangsan" }, messageRef: REPLY, text: "hello" }]);
});

test("a group message: thread is the chat, sender the person, the leading @bot is stripped", () => {
  const { events } = parse(new WeComBotChannel(CREDENTIALS, "acct"), message("text", { text: { content: "@Hatch 这是今日的测试情况" } }, true));
  assert.deepEqual(events[0].address, { threadId: "wrcg1", senderId: "zhangsan" });
  assert.equal(events[0].group, true);
  assert.equal(events[0].text, "这是今日的测试情况");
});

test("mixed joins its text parts; voice is its transcript; quote is ignored", () => {
  const channel = new WeComBotChannel(CREDENTIALS, "acct");
  const mixed = message("mixed", { mixed: { msg_item: [{ msgtype: "text", text: { content: "look" } }, { msgtype: "image", image: { url: "https://x/i" } }, { msgtype: "text", text: { content: "at this" } }] } });
  assert.equal(parse(channel, mixed).events[0].text, "look\nat this");
  assert.equal(parse(channel, message("voice", { voice: { content: "turn left" } })).events[0].text, "turn left");
  const quoted = message("text", { text: { content: "yes" }, quote: { msgtype: "text", text: { content: "old" } } });
  assert.equal(parse(channel, quoted).events[0].text, "yes");
});

test("image, file and video carry the media URL as the file ref", () => {
  const channel = new WeComBotChannel(CREDENTIALS, "acct");
  const file = (type: string) => parse(channel, message(type, { [type]: { url: `https://m/${type}` } })).events[0].file;
  assert.deepEqual(file("image"), { ref: "https://m/image", name: "image.jpg" });
  assert.deepEqual(file("file"), { ref: "https://m/file", name: "file" });
  assert.deepEqual(file("video"), { ref: "https://m/video", name: "video.mp4" });
});

test("stream refresh, enter_chat, feedback and unknown messages yield no events and an empty reply", () => {
  const channel = new WeComBotChannel(CREDENTIALS, "acct");
  for (const plain of [
    { msgid: "r1", chattype: "single", from: { userid: "u" }, msgtype: "stream", stream: { id: "S1" } },
    { msgid: "e1", from: { userid: "u" }, msgtype: "event", event: { eventtype: "enter_chat" } },
    { msgid: "f1", chattype: "single", from: { userid: "u" }, msgtype: "event", event: { eventtype: "feedback_event", feedback_event: { id: "x", type: 1 } } },
    { msgid: "x1", chattype: "single", from: { userid: "u" }, msgtype: "location" },
  ]) assert.deepEqual(parse(channel, callback(plain)), { events: [] });
});

test("a message from nobody is not an event", () => {
  assert.deepEqual(parse(new WeComBotChannel(CREDENTIALS, "acct"), callback({ msgid: "m", msgtype: "text", text: { content: "x" } })), { events: [] });
});

const channel = new WeComBotChannel(CREDENTIALS, "acct", fakeFetch(() => Response.json({ errcode: 0, errmsg: "ok" })).fetchImpl);
const sendWith = (outcome: Response | Error) => {
  const { fetchImpl } = fakeFetch(() => outcome);
  return new WeComBotChannel(CREDENTIALS, "acct", fetchImpl).send(TO, { text: "hi", replyTo: REPLY }, "k1");
};

conformance("wecom", {
  adapter: channel,
  send: sendWith,
  cases: [
    { name: "a timeout", outcome: TIMEOUT, failure: "ambiguous" },
    { name: "HTTP 5xx", outcome: new Response("", { status: 502 }), failure: "ambiguous" },
    { name: "HTTP 429", outcome: new Response("", { status: 429 }), failure: "definite" },
    { name: "the rate-limit errcode 45009", outcome: Response.json({ errcode: 45009, errmsg: "api freq out of limit" }), failure: "definite" },
    { name: "an expired or used response_url", outcome: Response.json({ errcode: 846604, errmsg: "expired" }), failure: "permanent" },
    { name: "HTTP 400", outcome: new Response("", { status: 400 }), failure: "permanent" },
    { name: "HTTP 401", outcome: new Response("", { status: 401 }), failure: "permanent", access: true },
    { name: "HTTP 403", outcome: new Response("", { status: 403 }), failure: "permanent", access: true },
  ],
  delivered: {
    async duplicate() {
      const call = message("text", { text: { content: "again" } });
      return [...parse(channel, call).events, ...parse(channel, call).events];
    },
    async ordered() {
      const [a, b] = [message("text", { text: { content: "a" } }, false, "ma"), message("text", { text: { content: "b" } }, true, "mb")];
      return [[a, b].flatMap(call => parse(channel, call).events), [b, a].flatMap(call => parse(channel, call).events)];
    },
  },
  forged: () => channel.verify(message("text").raw, {}, new URLSearchParams({ msg_signature: "bad", timestamp: "1", nonce: "n" })),
});

test("send posts markdown to the response_url", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ errcode: 0, errmsg: "ok" }));
  await new WeComBotChannel(CREDENTIALS, "acct", fetchImpl).send(TO, { text: "**done**", replyTo: REPLY }, "k1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, REPLY);
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(calls[0]!.body, { msgtype: "markdown", markdown: { content: "**done**" } });
});

test("a smart bot cannot start a conversation: send without replyTo is permanent and calls nothing", async () => {
  const { fetchImpl, calls } = fakeFetch(() => Response.json({ errcode: 0 }));
  await assert.rejects(new WeComBotChannel(CREDENTIALS, "acct", fetchImpl).send(TO, { text: "hi" }, "k1"), (error: any) => error.failure === "permanent");
  assert.equal(calls.length, 0);
});

function sealMedia(bytes: Buffer): Buffer {
  const key = Buffer.from(`${KEY}=`, "base64");
  const pad = 32 - (bytes.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16)).setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([bytes, Buffer.alloc(pad, pad)])), cipher.final()]);
}

test("download decrypts the media with the EncodingAESKey", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(new Uint8Array(sealMedia(Buffer.from("picture bytes")))));
  const bytes = await new WeComBotChannel(CREDENTIALS, "acct", fetchImpl).download({ ref: "https://m/image", name: "image.jpg" });
  assert.equal(bytes.toString(), "picture bytes");
  assert.equal(calls[0]!.url, "https://m/image");
});

test("download of an expired URL, or a body that is not ours, throws", async () => {
  const download = (response: Response) => new WeComBotChannel(CREDENTIALS, "acct", fakeFetch(() => response).fetchImpl).download({ ref: "https://m/f", name: "f" });
  await assert.rejects(download(new Response("", { status: 404 })), /expired|failed/);
  await assert.rejects(download(Response.json({ errcode: 1 })), /expired|decrypt/);
});

test("download stops at maxFileBytes", async () => {
  const max = new WeComBotChannel(CREDENTIALS, "acct").maxFileBytes;
  const download = (response: Response) => new WeComBotChannel(CREDENTIALS, "acct", fakeFetch(() => response).fetchImpl).download({ ref: "https://m/f", name: "f" });
  await assert.rejects(download(new Response("x", { headers: { "content-length": String(max + 1) } })), /over/);
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  await assert.rejects(download(new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk); } }))), /over/);
  assert.ok(pulled <= max / chunk.length + 5);
});
