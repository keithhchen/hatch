import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { conformance, fakeFetch, TIMEOUT } from "./adapterConformance.js";
import { LarkChannel, type LarkCredentials } from "./larkChannel.js";
import { decodeFrame, encodeFrame, type Frame } from "./larkLongConnection.js";
import type { InboundEvent } from "./types.js";

const CREDENTIALS: LarkCredentials = { domain: "feishu", appId: "cli_f", appSecret: "secret", verificationToken: "vtoken", botOpenId: "ou_bot" };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const TO = { threadId: "ou_1", senderId: "ou_1" };

type Message = Record<string, unknown>;
const receive = (message: Message, sender: Record<string, unknown> = {}, id = "ev1") => json({
  schema: "2.0",
  header: { event_id: id, event_type: "im.message.receive_v1", token: "vtoken", tenant_key: "t1" },
  event: { sender: { sender_id: { open_id: "ou_1" }, tenant_key: "t1", ...sender }, message: { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hi" }), ...message } },
});
const group = (text: string, mentions: unknown[], extra: Message = {}) => receive({ chat_type: "group", content: JSON.stringify({ text }), mentions, ...extra });
const BOT = { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Hatch", mentioned_type: "bot" };
const ANN = { key: "@_user_2", id: { open_id: "ou_2" }, name: "Ann", mentioned_type: "user" };
const channel = (fetchImpl?: typeof fetch) => new LarkChannel(CREDENTIALS, "acct", fetchImpl);
const sendOutcome = async (outcome: Response | Error) => {
  const { fetchImpl } = fakeFetch(url => url.endsWith("/tenant_access_token/internal") ? Response.json({ code: 0, tenant_access_token: "t-1", expire: 7200 }) : outcome);
  await channel(fetchImpl).send(TO, { text: "x" }, "k:0");
};
const lark = (code: number, msg = "x") => Response.json({ code, msg });

test("a Feishu app is its own kind, on Feishu's host", async () => {
  const feishu = channel();
  assert.equal(feishu.kind, "feishu");
  assert.equal(new LarkChannel({ ...CREDENTIALS, domain: "lark" }, "acct").kind, "lark");
  const { fetchImpl, calls } = fakeFetch(url => url.endsWith("/tenant_access_token/internal") ? Response.json({ code: 0, tenant_access_token: "t", expire: 7200 }) : lark(0));
  await channel(fetchImpl).send(TO, { text: "hi" }, "k:0");
  assert.match(calls.at(-1)!.url, /^https:\/\/open\.feishu\.cn\/open-apis\/im\/v1\/messages\?receive_id_type=open_id$/);
});

test("a group message reaches the bot only when it mentions the bot, with thread and sender apart", () => {
  const { events } = channel().parse(group("@_user_1 你好", [BOT]));
  assert.deepEqual(events, [{ eventId: "om_1", address: { threadId: "oc_1", senderId: "ou_1" }, group: true, messageRef: "om_1", text: "你好" }]);
  assert.deepEqual(channel().parse(group("@_user_2 你好", [ANN])).events, []);
  assert.deepEqual(channel().parse(group("你好", [])).events, []);
  assert.deepEqual(new LarkChannel({ ...CREDENTIALS, botOpenId: undefined }, "acct").parse(group("@_user_1 你好", [BOT])).events, []);
});

test("other people mentioned in a group message stay in the text by name", () => {
  assert.equal(channel().parse(group("@_user_1 问问 @_user_2", [BOT, ANN])).events[0]?.text, "问问 @Ann");
});

test("a cross-tenant sender in a one-to-one chat is not answered, since Feishu refuses the reply", () => {
  assert.deepEqual(channel().parse(receive({}, { tenant_key: "t2" })).events, []);
  assert.equal(channel().parse(receive({})).events.length, 1);
  // An external group can be answered once its owner shares it with the bot.
  assert.equal(channel().parse(receive({ chat_type: "group", content: JSON.stringify({ text: "@_user_1 hi" }), mentions: [BOT] }, { tenant_key: "t2" })).events.length, 1);
});

test("voice and video messages are files", () => {
  assert.deepEqual(channel().parse(receive({ message_type: "audio", content: JSON.stringify({ file_key: "f1", duration: 3000 }) })).events[0]?.file, { ref: "om_1|f1|file", name: "voice.opus" });
  assert.deepEqual(channel().parse(receive({ message_type: "media", content: JSON.stringify({ file_key: "f2", image_key: "i", file_name: "clip.mp4" }) })).events[0]?.file, { ref: "om_1|f2|file", name: "clip.mp4" });
});

test("a group thread is sent to by chat id", async () => {
  const { fetchImpl, calls } = fakeFetch(url => url.endsWith("/tenant_access_token/internal") ? Response.json({ code: 0, tenant_access_token: "t", expire: 7200 }) : lark(0));
  await channel(fetchImpl).send({ threadId: "oc_1", senderId: "ou_1" }, { text: "hi" }, "k:0");
  assert.match(calls.at(-1)!.url, /receive_id_type=chat_id$/);
  assert.equal(calls.at(-1)!.body.receive_id, "oc_1");
});

test("capabilities say what Feishu allows", () => {
  assert.deepEqual(channel().capabilities(), { stream: false, edit: false, typing: false, buttons: true, maxLength: 9000, canInitiate: true, idempotentSend: true });
});

const events = async (...raws: Buffer[]): Promise<InboundEvent[]> => raws.flatMap(raw => channel().parse(raw).events);
const first = receive({ message_id: "om_1" }, {}, "e1");
const second = receive({ message_id: "om_2" }, {}, "e2");
conformance("feishu", {
  adapter: channel(),
  send: sendOutcome,
  cases: [
    { name: "a timeout", outcome: TIMEOUT, failure: "ambiguous" },
    { name: "HTTP 500", outcome: new Response("{}", { status: 500 }), failure: "ambiguous" },
    { name: "HTTP 429", outcome: new Response("{}", { status: 429 }), failure: "definite" },
    { name: "frequency limit 230020", outcome: lark(230020), failure: "definite" },
    { name: "frequency limit 99991400", outcome: lark(99991400), failure: "definite" },
    { name: "an external group not shared with the bot (230027)", outcome: lark(230027), failure: "permanent" },
    { name: "a cross-tenant one-to-one chat (230038)", outcome: lark(230038), failure: "permanent" },
    { name: "the user resigned or left the bot's scope (230013)", outcome: lark(230013), failure: "permanent" },
    { name: "an app disabled in the tenant (99991662)", outcome: lark(99991662), failure: "permanent", access: true },
    { name: "an app uninstalled from the tenant (11210)", outcome: lark(11210), failure: "permanent", access: true },
    { name: "HTTP 403", outcome: new Response("{}", { status: 403 }), failure: "permanent", access: true },
  ],
  delivered: {
    duplicate: () => events(first, first),
    ordered: async () => [await events(first, second), await events(second, first)],
  },
  forged: () => channel().verify(first, { "x-lark-signature": "nope" }) && new LarkChannel({ ...CREDENTIALS, encryptKey: "k" }, "acct").verify(first, {}),
});

// ── the long connection ──

const FRAME_HEADERS = (type: string, extra: Record<string, string> = {}) => Object.entries({ type, ...extra }).map(([key, value]) => ({ key, value }));
const eventFrame = (body: unknown, extra: Record<string, string> = {}): Frame => ({ SeqID: 1, LogID: 1, service: 7, method: 1, headers: FRAME_HEADERS("event", { message_id: "m1", sum: "1", seq: "0", trace_id: "tr", ...extra }), payload: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

class FakeSocket extends EventEmitter {
  sent: Frame[] = [];
  closed = false;
  send(data: Uint8Array) { this.sent.push(decodeFrame(Buffer.from(data))); }
  close() { this.closed = true; this.emit("close"); }
  deliver(frame: Frame) { this.emit("message", Buffer.from(encodeFrame(frame))); }
}
const ENDPOINT = Response.json({ code: 0, data: { URL: "wss://ws.feishu.test/ws?device_id=d1&service_id=7", ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 30, ReconnectNonce: 30 } } });

function connection(endpoint: Response = ENDPOINT) {
  const socket = new FakeSocket();
  const { fetchImpl, calls } = fakeFetch(() => endpoint.clone());
  const received: InboundEvent[][] = [];
  const controller = new AbortController();
  const adapter = new LarkChannel(CREDENTIALS, "acct", fetchImpl, () => socket);
  const done = adapter.listen(async batch => { received.push(batch); }, controller.signal);
  return { socket, calls, received, controller, done, settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test("long connection: asks Feishu for the socket with the app's credentials and pings with the service id", async () => {
  const live = connection();
  await live.settle();
  assert.equal(live.calls[0]!.url, "https://open.feishu.cn/callback/ws/endpoint");
  assert.deepEqual(live.calls[0]!.body, { AppID: "cli_f", AppSecret: "secret" });
  live.socket.emit("open");
  await live.settle();
  const ping = live.socket.sent[0]!;
  assert.deepEqual([ping.service, ping.method, ping.headers.find(h => h.key === "type")?.value], [7, 0, "ping"]);
  live.controller.abort();
  await live.done;
  assert.equal(live.socket.closed, true);
});

test("long connection: an event becomes events, and is acknowledged only after it is stored", async () => {
  const live = connection();
  await live.settle(); live.socket.emit("open");
  live.socket.deliver(eventFrame(JSON.parse(first.toString())));
  await live.settle();
  assert.deepEqual(live.received[0]?.map(event => event.eventId), ["om_1"]);
  const ack = live.socket.sent.at(-1)!;
  assert.equal(JSON.parse(Buffer.from(ack.payload!).toString()).code, 200);
  assert.ok(ack.headers.some(h => h.key === "biz_rt"));
  live.controller.abort(); await live.done;
});

test("long connection: a redelivered frame gives the same event id", async () => {
  const live = connection();
  await live.settle(); live.socket.emit("open");
  for (let i = 0; i < 2; i++) { live.socket.deliver(eventFrame(JSON.parse(first.toString()))); await live.settle(); }
  assert.deepEqual(live.received.flat().map(event => event.eventId), ["om_1", "om_1"]);
  live.controller.abort(); await live.done;
});

test("long connection: a big event arrives in pieces, out of order, and is joined", async () => {
  const live = connection();
  await live.settle(); live.socket.emit("open");
  const body = first.toString();
  const cut = Math.floor(body.length / 2);
  live.socket.deliver({ ...eventFrame(body.slice(cut), { sum: "2", seq: "1" }) });
  await live.settle();
  assert.equal(live.received.length, 0);
  live.socket.deliver({ ...eventFrame(body.slice(0, cut), { sum: "2", seq: "0" }) });
  await live.settle();
  assert.deepEqual(live.received[0]?.map(event => event.eventId), ["om_1"]);
  live.controller.abort(); await live.done;
});

test("long connection: a failure to store is answered 500 so Feishu retries", async () => {
  const socket = new FakeSocket();
  const { fetchImpl } = fakeFetch(() => ENDPOINT.clone());
  const controller = new AbortController();
  const done = new LarkChannel(CREDENTIALS, "acct", fetchImpl, () => socket).listen(async () => { throw new Error("db down"); }, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); socket.emit("open");
  socket.deliver(eventFrame(JSON.parse(first.toString())));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(Buffer.from(socket.sent.at(-1)!.payload!).toString()).code, 500);
  controller.abort(); await done;
});

test("long connection: revoked or wrong credentials make listen fail with Feishu's reason", async () => {
  const live = connection(Response.json({ code: 1000040350, msg: "app secret invalid" }));
  await assert.rejects(live.done, /app secret invalid/);
});

test("long connection: a closed socket ends listen so the caller reconnects", async () => {
  const live = connection();
  await live.settle(); live.socket.emit("open"); live.socket.emit("close");
  await live.done;
});

test("frames survive the codec", () => {
  const frame = eventFrame({ a: "汉" });
  assert.deepEqual(decodeFrame(Buffer.from(encodeFrame(frame))), frame);
});
