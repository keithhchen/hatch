import assert from "node:assert/strict";
import { test } from "node:test";
import { conformance, fakeFetch, TIMEOUT, type SendOutcome } from "./adapterConformance.js";
import { WeChatKfChannel, type WeChatKfCredentials } from "./wechatKfChannel.js";
import { WeComCrypto } from "./wecomCrypto.js";

const KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CREDENTIALS: WeChatKfCredentials = { corpId: "wwcorp", secret: "sec", token: "tok", encodingAesKey: KEY };
const crypto = new WeComCrypto("tok", KEY, "wwcorp");
const FROM = { threadId: "wkf1|wm_1", senderId: "wm_1" };

/** What WeCom POSTs: the signed, encrypted notification that something is waiting to be pulled. */
function callback(token = "t1", openKfId = "wkf1", event = "kf_msg_or_event") {
  const inner = `<xml><ToUserName><![CDATA[wwcorp]]></ToUserName><CreateTime>1</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event}]]></Event><Token><![CDATA[${token}]]></Token><OpenKfId><![CDATA[${openKfId}]]></OpenKfId></xml>`;
  const encrypt = crypto.encrypt(inner);
  const [timestamp, nonce] = ["1700000000", "n0nce"];
  const raw = Buffer.from(`<xml><ToUserName><![CDATA[wwcorp]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[]]></AgentID></xml>`);
  return { raw, query: new URLSearchParams({ msg_signature: crypto.sign(timestamp, nonce, encrypt), timestamp, nonce }), encrypt };
}
const message = (msgid: string, extra: Record<string, unknown> = { msgtype: "text", text: { content: "hi" } }) =>
  ({ msgid, open_kfid: "wkf1", external_userid: "wm_1", send_time: 1, origin: 3, ...extra });
const page = (msg_list: unknown[], next_cursor = "c1", has_more = 0) => Response.json({ errcode: 0, errmsg: "ok", msg_list, next_cursor, has_more });
const ok = () => Response.json({ errcode: 0, errmsg: "ok" });
const reply = (errcode: number) => Response.json({ errcode, errmsg: "x" });
const tokens = (counter = { n: 0 }) => () => Response.json({ errcode: 0, errmsg: "ok", access_token: `at-${++counter.n}`, expires_in: 7200 });

/** Answers gettoken itself; every other call goes to `answer`, which sees the request body and its index among the other calls. */
function kf(answer: (url: string, body: any, index: number) => SendOutcome, gettoken = tokens()) {
  const fake = fakeFetch((url, _init, index) => url.includes("/cgi-bin/gettoken") ? gettoken() : answer(url, fake.calls[index]?.body, index));
  const only = (path: string) => fake.calls.filter(call => call.url.includes(path));
  return { ...fake, only, channel: new WeChatKfChannel(CREDENTIALS, "acct", fake.fetchImpl) };
}
const sendTo = (outcome: SendOutcome) => kf(url => url.includes("send_msg") ? outcome : ok()).channel.send(FROM, { text: "hi" }, "k:0");

test("available needs corp id, secret, token and EncodingAESKey", () => {
  assert.equal(new WeChatKfChannel(CREDENTIALS, "acct").available(), true);
  for (const missing of ["corpId", "secret", "token", "encodingAesKey"] as const) {
    assert.equal(new WeChatKfChannel({ ...CREDENTIALS, [missing]: "" }, "acct").available(), false, missing);
  }
});

test("identity and capabilities: no links, 48 hours, text counted in characters under 2048 bytes", () => {
  const channel = new WeChatKfChannel(CREDENTIALS, "acct");
  assert.equal(channel.kind, "wechatkf");
  assert.equal(channel.scope, "acct");
  assert.equal(channel.maxFileBytes, 20 * 1024 * 1024);
  assert.equal(channel.connectUrl("HATCH-ABCDEFGH"), undefined);
  assert.equal("chatUrl" in channel, false);
  assert.deepEqual(channel.capabilities(), { stream: false, edit: false, typing: false, buttons: false, maxLength: 2048, maxBytes: 2048, canInitiate: false, replyWindowMs: 48 * 3600_000, replyAllowance: 5, idempotentSend: true });
});

test("verify: the signature covers the body's Encrypt", () => {
  const channel = new WeChatKfChannel(CREDENTIALS, "acct");
  const { raw, query, encrypt } = callback();
  assert.equal(channel.verify(raw, {}, query), true);
  assert.equal(channel.verify(raw, {}, new URLSearchParams({ ...Object.fromEntries(query), msg_signature: "0".repeat(40) })), false);
  assert.equal(channel.verify(Buffer.from(raw.toString().replace(encrypt, crypto.encrypt("<xml/>"))), {}, query), false);
  assert.equal(channel.verify(raw, {}, new URLSearchParams({ timestamp: "1", nonce: "n" })), false);
  assert.equal(channel.verify(raw, {}), false);
  assert.equal(channel.verify(Buffer.from("not xml"), {}, query), false);
  assert.equal(new WeChatKfChannel({ ...CREDENTIALS, token: "other" }, "acct").verify(raw, {}, query), false);
});

test("challenge: a signed echostr is decrypted, anything else is refused", () => {
  const channel = new WeChatKfChannel(CREDENTIALS, "acct");
  const echostr = crypto.encrypt("echo-me");
  const signature = crypto.sign("1", "n", echostr);
  const query = (extra: Record<string, string> = {}) => new URLSearchParams({ msg_signature: signature, timestamp: "1", nonce: "n", echostr, ...extra });
  assert.equal(channel.challenge(query()), "echo-me");
  // A '+' that arrived unescaped became a space in the query.
  assert.equal(channel.challenge(new URLSearchParams(`msg_signature=${signature}&timestamp=1&nonce=n&echostr=${echostr}`)), "echo-me");
  assert.equal(channel.challenge(query({ msg_signature: "bad" })), undefined);
  assert.equal(channel.challenge(new URLSearchParams()), undefined);
  assert.equal(new WeChatKfChannel({ ...CREDENTIALS, encodingAesKey: "short" }, "acct").challenge(query()), undefined);
});

const notice = (token = "t1", key = "wkf1") => ({ key, hint: token });

test("parse only reads the callback: it names what to pull and touches no network", () => {
  const { channel, calls } = kf(() => ok());
  assert.deepEqual(channel.parse(callback("t1").raw), { events: [], pull: { key: "wkf1", hint: "t1" } });
  assert.deepEqual(channel.parse(callback("t2", "wkf2").raw), { events: [], pull: { key: "wkf2", hint: "t2" } });
  assert.equal(calls.length, 0);
});

test("pull uses the notice's token and open_kfid, starts at the given cursor and returns the new one", async () => {
  const { channel, only } = kf(() => page([message("m1")], "cursor-1"));
  assert.deepEqual(await channel.pull(notice("t1"), undefined), { events: [{ eventId: "m1", address: FROM, messageRef: "m1", text: "hi" }], cursor: "cursor-1" });
  assert.deepEqual(only("sync_msg")[0]?.body, { open_kfid: "wkf1", token: "t1", limit: 1000, voice_format: 0 });
  assert.equal(only("sync_msg")[0]?.url, "https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=at-1");
  assert.equal((await channel.pull(notice("t2"), "cursor-1")).cursor, "cursor-1");
  assert.deepEqual(only("sync_msg")[1]?.body, { open_kfid: "wkf1", token: "t2", limit: 1000, voice_format: 0, cursor: "cursor-1" });
});

test("pull keeps no state: the same cursor gives the same request again", async () => {
  const { channel, only } = kf(() => page([message("m1")], "c9"));
  await channel.pull(notice(), "c1");
  await channel.pull(notice(), "c1");
  assert.deepEqual(only("sync_msg").map(call => call.body.cursor), ["c1", "c1"]);
});

test("pull keeps going while has_more is 1, even over an empty page, and returns the last cursor", async () => {
  const pages = [page([message("m1")], "c1", 1), page([], "c2", 1), page([message("m2")], "c3", 0)];
  const { channel, only } = kf((_url, _body, index) => pages[index - 1]!);
  const pulled = await channel.pull(notice(), undefined);
  assert.deepEqual(pulled.events.map(event => event.eventId), ["m1", "m2"]);
  assert.equal(pulled.cursor, "c3");
  assert.deepEqual(only("sync_msg").map(call => call.body.cursor), [undefined, "c1", "c2"]);
});

test("a failed pull throws and returns no cursor, so the caller starts again from the same place", async () => {
  const answers = [page([message("m1")], "c1", 1), reply(-1), page([message("m1"), message("m2")], "c2")];
  const { channel, only } = kf((_url, _body, index) => answers[index - 1]!);
  await assert.rejects(channel.pull(notice(), undefined));
  assert.deepEqual((await channel.pull(notice(), undefined)).events.map(event => event.eventId), ["m1", "m2"]);
  assert.equal(only("sync_msg")[2]?.body.cursor, undefined);
});

test("other notifications name nothing to pull", () => {
  const { channel, calls } = kf(() => ok());
  assert.deepEqual(channel.parse(callback("t", "wkf1", "something_else").raw), { events: [] });
  assert.equal(calls.length, 0);
});

test("customer messages map to one event each; system and staff messages are skipped", async () => {
  const list = [
    message("m1", { msgtype: "image", image: { media_id: "mi" } }),
    message("m2", { msgtype: "voice", voice: { media_id: "mv" } }),
    message("m3", { msgtype: "file", file: { media_id: "mf" } }),
    message("m4", { msgtype: "location", location: { name: "Cafe", address: "1 Main St", latitude: 1.5, longitude: 2.5 } }),
    message("m5", { msgtype: "link", link: { title: "T", desc: "D", url: "https://x.test" } }),
    message("m6", { msgtype: "miniprogram", miniprogram: { title: "mp" } }),
    message("m7", { origin: 4, msgtype: "event", event: { event_type: "enter_session" } }),
    message("m8", { origin: 5, msgtype: "text", text: { content: "from staff" } }),
    { ...message("m9"), external_userid: "" },
  ];
  const { channel } = kf(() => page(list));
  const { events } = await channel.pull(notice(), undefined);
  const mapped = (id: string) => events.find(event => event.eventId === id);
  assert.deepEqual(mapped("m1")?.file, { ref: "mi", name: "photo.jpg" });
  assert.deepEqual(mapped("m2")?.file, { ref: "mv", name: "voice.amr" });
  assert.deepEqual(mapped("m3")?.file, { ref: "mf", name: "file" });
  assert.equal(mapped("m4")?.text, "Cafe\n1 Main St\n1.5,2.5");
  assert.equal(mapped("m5")?.text, "T\nD\nhttps://x.test");
  assert.deepEqual(mapped("m6"), { eventId: "m6", address: FROM, messageRef: "m6" });
  assert.deepEqual(events.map(event => event.eventId), ["m1", "m2", "m3", "m4", "m5", "m6"]);
  assert.ok(events.every(event => !event.group && event.scope === undefined));
});

test("a voice message is AMR: sync_msg asks for that format and the media is fetched by its media_id", async () => {
  const { channel, only } = kf(url => url.includes("sync_msg") ? page([message("v1", { msgtype: "voice", voice: { media_id: "MEDIA_V" } })]) : new Response(Buffer.from("#!AMR\nframes"), { headers: { "content-type": "audio/amr" } }));
  const { events } = await channel.pull(notice(), undefined);
  assert.deepEqual(events[0]?.file, { ref: "MEDIA_V", name: "voice.amr" });
  assert.equal(only("sync_msg")[0]!.body.voice_format, 0);
  assert.equal((await channel.download(events[0]!.file!)).subarray(0, 5).toString(), "#!AMR");
  assert.match(only("/cgi-bin/media/get")[0]!.url, /media_id=MEDIA_V$/);
});

test("the access token is cached, and a stale one is replaced once", async () => {
  const counter = { n: 0 };
  const { channel, calls } = kf((_url, _body, index) => index === 1 ? reply(42001) : page([message("m1")]), tokens(counter));
  assert.equal((await channel.pull(notice(), undefined)).events.length, 1);
  assert.equal(counter.n, 2);
  assert.ok(calls[0]!.url.includes("corpid=wwcorp") && calls[0]!.url.includes("corpsecret=sec"));
  assert.ok(calls[3]!.url.endsWith("access_token=at-2"));
  await channel.pull(notice(), undefined);
  assert.equal(counter.n, 2);
});

test("send: text to the customer through the kf account, with a msgid derived from the key", async () => {
  const { channel, only } = kf(() => ok());
  await channel.send(FROM, { text: "hello", replyTo: "m1" }, "k:0");
  await channel.send(FROM, { text: "hello" }, "k:0");
  await channel.send(FROM, { text: "hello" }, "k:1");
  const [a, b, c] = only("send_msg").map(call => call.body);
  assert.deepEqual(a, { touser: "wm_1", open_kfid: "wkf1", msgid: a.msgid, msgtype: "text", text: { content: "hello" } });
  assert.match(a.msgid, /^[0-9a-f]{32}$/);
  assert.equal(b.msgid, a.msgid);
  assert.notEqual(c.msgid, a.msgid);
  assert.equal(only("send_msg")[0]?.url, "https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=at-1");
});

test("send: a duplicate msgid means an earlier attempt went through, so it is delivered", async () => {
  await sendTo(reply(95033));
});

test("send: a bad secret while fetching the token loses access", async () => {
  const fake = fakeFetch(() => reply(40001));
  await assert.rejects(new WeChatKfChannel(CREDENTIALS, "acct", fake.fetchImpl).send(FROM, { text: "x" }, "k"), (error: any) => error.failure === "permanent" && error.options.access === true);
});

conformance("WeChat KF", {
  adapter: new WeChatKfChannel(CREDENTIALS, "acct"),
  send: sendTo,
  forged: () => new WeChatKfChannel(CREDENTIALS, "acct").verify(callback().raw, {}, new URLSearchParams({ msg_signature: "00", timestamp: "1700000000", nonce: "n0nce" })),
  cases: [
    { name: "timeout", outcome: TIMEOUT, failure: "ambiguous" },
    { name: "HTTP 429", outcome: new Response("", { status: 429 }), failure: "definite" },
    { name: "HTTP 502", outcome: new Response("", { status: 502 }), failure: "ambiguous" },
    { name: "HTTP 403", outcome: new Response("", { status: 403 }), failure: "permanent", access: true },
    { name: "errcode 45009, call frequency", outcome: reply(45009), failure: "definite" },
    { name: "errcode 45033, concurrency", outcome: reply(45033), failure: "definite" },
    { name: "errcode -1, system busy", outcome: reply(-1), failure: "ambiguous" },
    { name: "errcode 95002, window over 48 hours", outcome: reply(95002), failure: "permanent" },
    { name: "errcode 95031, no customer inquiry in 48 hours", outcome: reply(95031), failure: "permanent" },
    { name: "errcode 95001, over 5 messages", outcome: reply(95001), failure: "permanent" },
    { name: "errcode 95018, session blocks sending", outcome: reply(95018), failure: "permanent" },
    { name: "errcode 40001, invalid secret", outcome: reply(40001), failure: "permanent", access: true },
    { name: "errcode 40091, secret of another enterprise", outcome: reply(40091), failure: "permanent", access: true },
    { name: "errcode 60020, IP not whitelisted", outcome: reply(60020), failure: "permanent", access: true },
    { name: "errcode 48004, authorization revoked", outcome: reply(48004), failure: "permanent", access: true },
    { name: "errcode 48007, kf account not given to the app", outcome: reply(48007), failure: "permanent", access: true },
    { name: "errcode 95004, kf account deleted", outcome: reply(95004), failure: "permanent", access: true },
    { name: "errcode 95017, API switch off", outcome: reply(95017), failure: "permanent", access: true },
    { name: "another errcode", outcome: reply(40008), failure: "permanent" },
  ],
  delivered: {
    duplicate: async () => {
      const { channel } = kf(() => page([message("m1")]));
      return [...(await channel.pull(notice(), undefined)).events, ...(await channel.pull(notice(), undefined)).events];
    },
    ordered: async () => {
      const run = async (order: string[]) => {
        const { channel } = kf((_url, request) => page([message(request.token === "t1" ? "m1" : "m2", { external_userid: request.token === "t1" ? "wm_1" : "wm_2" })]));
        return (await Promise.all(order.map(token => channel.pull(notice(token), undefined)))).flatMap(result => result.events);
      };
      return [await run(["t1", "t2"]), await run(["t2", "t1"])];
    },
  },
});

const media = (bytes: Buffer | string, headers: Record<string, string> = { "content-type": "image/jpeg" }) => new Response(new Uint8Array(Buffer.from(bytes)), { headers });
const file = { ref: "mi", name: "photo.jpg" };

test("download: media/get by media_id", async () => {
  const { channel, only } = kf(() => media("bytes"));
  assert.equal((await channel.download(file)).toString(), "bytes");
  assert.equal(only("media/get")[0]?.url, "https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=at-1&media_id=mi");
});

test("download: a JSON body is WeCom's error, not a file; a stale token is replaced once", async () => {
  await assert.rejects(kf(() => Response.json({ errcode: 40007, errmsg: "invalid media_id" })).channel.download(file), /40007/);
  const counter = { n: 0 };
  const { channel } = kf((_url, _body, index) => index === 1 ? reply(40014) : media("ok"), tokens(counter));
  assert.equal((await channel.download(file)).toString(), "ok");
  assert.equal(counter.n, 2);
});

test("download: over the size cap is refused, by length header and by counting bytes", async () => {
  const cap = new WeChatKfChannel(CREDENTIALS, "acct").maxFileBytes;
  await assert.rejects(kf(() => media("x", { "content-type": "image/jpeg", "content-length": String(cap + 1) })).channel.download(file), /bytes/);
  await assert.rejects(kf(() => media(Buffer.alloc(cap + 1))).channel.download(file), /bytes/);
});

test("probe proves the corp id and secret by fetching an access token, and names the failure", async () => {
  const good = kf(() => ok());
  await good.channel.probe();
  assert.equal(good.only("/cgi-bin/gettoken").length, 1);
  const bad = kf(() => ok(), () => Response.json({ errcode: 40013, errmsg: "invalid corpid" }));
  await assert.rejects(bad.channel.probe(), /invalid corpid/);
});
