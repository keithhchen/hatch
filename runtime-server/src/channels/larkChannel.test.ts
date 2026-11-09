import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptLark, LarkChannel, type LarkCredentials } from "./larkChannel.js";
import { ChannelSendError } from "./types.js";

const PLAIN: LarkCredentials = { domain: "lark", appId: "cli_a", appSecret: "secret", verificationToken: "vtoken" };
const SEALED: LarkCredentials = { ...PLAIN, encryptKey: "ekey" };
const TO = { threadId: "ou_1", senderId: "ou_1" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function encrypt(plain: string, key: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}
function signed(raw: Buffer, key = "ekey") {
  const [timestamp, nonce] = ["1700000000", "n0nce"];
  return { "x-lark-request-timestamp": timestamp, "x-lark-request-nonce": nonce, "x-lark-signature": createHash("sha256").update(timestamp + nonce + key).update(raw).digest("hex") };
}
const receive = (message_type: string, content: unknown, chat_type = "p2p") => json({
  schema: "2.0",
  header: { event_id: "ev1", event_type: "im.message.receive_v1", token: "vtoken" },
  event: { sender: { sender_id: { open_id: "ou_1" } }, message: { message_id: "om_1", chat_type, message_type, content: JSON.stringify(content) } },
});
const press = (value: unknown) => json({
  schema: "2.0",
  header: { event_id: "ev2", event_type: "card.action.trigger", token: "vtoken" },
  event: { operator: { open_id: "ou_1" }, token: "update-token", action: { value, tag: "button" }, context: { open_message_id: "om_9" } },
});

/** Answers the token endpoint itself and records every other call. */
function fakeLark(answer: (url: string, init?: RequestInit) => Response = () => Response.json({ code: 0, msg: "ok" })) {
  const calls: Array<{ url: string; init?: RequestInit; body: any }> = [];
  let tokens = 0;
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/tenant_access_token/internal")) { tokens++; return Response.json({ code: 0, msg: "ok", tenant_access_token: `t-${tokens}`, expire: 7200 }); }
    calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, tokens: () => tokens };
}

test("available needs app id, secret and verification token", () => {
  assert.equal(new LarkChannel(PLAIN, "acct").available(), true);
  assert.equal(new LarkChannel({ ...PLAIN, verificationToken: "" }, "acct").available(), false);
  assert.equal(new LarkChannel({ ...PLAIN, appSecret: "" }, "acct").available(), false);
});

test("identity, links and domains", () => {
  const lark = new LarkChannel(PLAIN, "acct");
  assert.equal(lark.kind, "lark");
  assert.equal(lark.scope, "acct");
  assert.equal(lark.maxFileBytes, 50 * 1024 * 1024);
  assert.equal(lark.connectUrl("HATCH-ABCDEFGH"), undefined);
  assert.equal(lark.chatUrl(), "https://applink.larksuite.com/client/bot/open?appId=cli_a");
  assert.equal(new LarkChannel({ ...PLAIN, domain: "feishu" }, "acct").chatUrl(), "https://applink.feishu.cn/client/bot/open?appId=cli_a");
});

test("signature: accepts the right one, refuses wrong, missing, and a changed body", () => {
  const channel = new LarkChannel(SEALED, "acct");
  const raw = json({ encrypt: encrypt(JSON.stringify({ header: { event_type: "x" } }), "ekey") });
  assert.equal(channel.verify(raw, signed(raw)), true);
  assert.equal(channel.verify(raw, signed(raw, "other")), false);
  assert.equal(channel.verify(raw, {}), false);
  assert.equal(channel.verify(json({ encrypt: encrypt("{}", "ekey") }), signed(raw)), false);
});

test("with an encrypt key the body's token alone does not authenticate an event", () => {
  const channel = new LarkChannel(SEALED, "acct");
  assert.equal(channel.verify(receive("text", { text: "hi" }), {}), false);
  assert.equal(channel.verify(json({ encrypt: encrypt(receive("text", { text: "hi" }).toString(), "ekey") }), {}), false);
});

test("without an encrypt key the body's token is checked, for events and card presses", () => {
  const channel = new LarkChannel(PLAIN, "acct");
  assert.equal(channel.verify(receive("text", { text: "hi" }), {}), true);
  assert.equal(channel.verify(press({ taskId: "t", action: "approve" }), {}), true);
  assert.equal(channel.verify(json({ header: { token: "wrong" }, token: "vtoken" }), {}), false);
  assert.equal(channel.verify(json({ header: { event_type: "x" } }), {}), false);
  assert.equal(channel.verify(json({ token: 7 }), {}), false);
  assert.equal(channel.verify(Buffer.from("null"), {}), false);
  assert.equal(channel.verify(Buffer.from("not json"), {}), false);
});

test("an empty configured token refuses everything", () => {
  const channel = new LarkChannel({ ...PLAIN, verificationToken: "" }, "acct");
  assert.equal(channel.verify(json({ type: "url_verification", token: "", challenge: "c" }), {}), false);
  assert.equal(channel.verify(json({ header: { token: "" } }), {}), false);
});

test("decrypt matches Lark's published example", () => {
  assert.equal(decryptLark("P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=", "test key"), "hello world");
});

test("decrypt round trip through parse", () => {
  const channel = new LarkChannel(SEALED, "acct");
  const raw = json({ encrypt: encrypt(receive("text", { text: "你好" }).toString(), "ekey") });
  assert.equal(channel.parse(raw).events[0]?.text, "你好");
});

test("undecryptable bodies are refused, not thrown", () => {
  const channel = new LarkChannel(SEALED, "acct");
  assert.equal(channel.verify(json({ encrypt: encrypt("{}", "other") }), {}), false);
  assert.equal(channel.verify(json({ encrypt: 7 }), {}), false);
  assert.equal(new LarkChannel(PLAIN, "acct").verify(json({ encrypt: encrypt("{}", "ekey") }), {}), false);
});

test("url_verification, plain: right token answers the challenge, wrong token is refused", () => {
  const channel = new LarkChannel(PLAIN, "acct");
  const raw = json({ type: "url_verification", token: "vtoken", challenge: "abc" });
  assert.equal(channel.verify(raw, {}), true);
  assert.deepEqual(channel.parse(raw), { events: [], respond: { challenge: "abc" } });
  assert.equal(channel.verify(json({ type: "url_verification", token: "wrong", challenge: "abc" }), {}), false);
});

test("url_verification, encrypted: passes unsigned on the token inside, wrong token is refused", () => {
  const channel = new LarkChannel(SEALED, "acct");
  const raw = json({ encrypt: encrypt(JSON.stringify({ type: "url_verification", token: "vtoken", challenge: "abc" }), "ekey") });
  assert.equal(channel.verify(raw, {}), true);
  assert.deepEqual(channel.parse(raw), { events: [], respond: { challenge: "abc" } });
  assert.equal(channel.verify(json({ encrypt: encrypt(JSON.stringify({ type: "url_verification", token: "wrong", challenge: "abc" }), "ekey") }), {}), false);
});

test("an event dressed as url_verification gets past verify on the token but yields no events", () => {
  const channel = new LarkChannel(SEALED, "acct");
  const smuggled = { ...JSON.parse(receive("text", { text: "HATCH-ABCDEFGH" }).toString()), type: "url_verification", token: "vtoken", challenge: "c" };
  const raw = json({ encrypt: encrypt(JSON.stringify(smuggled), "ekey") });
  assert.equal(channel.verify(raw, {}), true);
  assert.deepEqual(channel.parse(raw), { events: [], respond: { challenge: "c" } });
});

test("parse text", () => {
  const { events, respond } = new LarkChannel(PLAIN, "acct").parse(receive("text", { text: " HATCH-ABCDEFGH " }));
  assert.deepEqual(events, [{ eventId: "om_1", address: TO, messageRef: "om_1", text: "HATCH-ABCDEFGH" }]);
  assert.equal(respond, undefined);
});

test("parse image and file encode message id, key and type", () => {
  const channel = new LarkChannel(PLAIN, "acct");
  assert.deepEqual(channel.parse(receive("image", { image_key: "img_1" })).events[0]?.file, { ref: "om_1|img_1|image", name: "photo.jpg" });
  assert.deepEqual(channel.parse(receive("file", { file_key: "file_1", file_name: "deck.pdf" })).events[0]?.file, { ref: "om_1|file_1|file", name: "deck.pdf" });
});

test("parse post flattens to plain text", () => {
  const post = { title: "标题", content: [[{ tag: "text", text: "看" }, { tag: "a", text: "这个", href: "https://x.test" }], [{ tag: "at", user_name: "Ann" }, { tag: "img", image_key: "img" }]] };
  assert.equal(new LarkChannel(PLAIN, "acct").parse(receive("post", post)).events[0]?.text, "标题\n看[这个](https://x.test)\nAnn");
});

test("other types are an event with no text and no file", () => {
  for (const [type, content] of [["sticker", { file_key: "f" }], ["post", { content: [[{ tag: "img", image_key: "i" }]] }]] as const) {
    assert.deepEqual(new LarkChannel(PLAIN, "acct").parse(receive(type, content)).events, [{ eventId: "om_1", address: TO, messageRef: "om_1" }]);
  }
});

test("group chats and other event types are ignored", () => {
  const channel = new LarkChannel(PLAIN, "acct");
  assert.deepEqual(channel.parse(receive("text", { text: "hi" }, "group")).events, []);
  assert.deepEqual(channel.parse(json({ header: { event_type: "im.chat.updated_v1" }, event: {} })).events, []);
});

test("a card press becomes a button event with a toast", () => {
  const { events, respond } = new LarkChannel(PLAIN, "acct").parse(press({ taskId: "task-1", action: "approve" }));
  assert.deepEqual(events, [{ eventId: "ev2", address: TO, button: { taskId: "task-1", action: "approve" } }]);
  assert.deepEqual(respond, { toast: { type: "info", content: "收到" } });
});

test("an unknown card value never approves anything", () => {
  const channel = new LarkChannel(PLAIN, "acct");
  for (const value of [{ taskId: "t", action: "delete" }, { action: "approve" }, "text", undefined]) {
    const { events, respond } = channel.parse(press(value));
    assert.deepEqual(events[0]?.button, { taskId: "", action: "decline" });
    assert.ok(respond);
  }
});

test("the tenant token is cached until shortly before expiry", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const lark = fakeLark();
  const channel = new LarkChannel(PLAIN, "acct", lark.fetchImpl);
  await channel.send(TO, { text: "a" }, "k:0");
  await channel.send(TO, { text: "b" }, "k:0");
  assert.equal(lark.tokens(), 1);
  assert.equal((lark.calls[1]?.init?.headers as Record<string, string>).authorization, "Bearer t-1");
  t.mock.timers.setTime(7200_000 - 60_000);
  await channel.send(TO, { text: "c" }, "k:0");
  assert.equal(lark.tokens(), 2);
  assert.equal((lark.calls[2]?.init?.headers as Record<string, string>).authorization, "Bearer t-2");
});

test("create without replyTo, reply with it, each with its key's uuid", async () => {
  const lark = fakeLark();
  const channel = new LarkChannel(PLAIN, "acct", lark.fetchImpl);
  await channel.send(TO, { text: "hello" }, "k:0");
  await channel.send(TO, { text: "hello", replyTo: "om_1" }, "k:1");
  const [create, reply] = lark.calls;
  assert.equal(create?.url, "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id");
  assert.equal(create?.body.receive_id, "ou_1");
  assert.equal(create?.body.msg_type, "text");
  assert.deepEqual(JSON.parse(create?.body.content), { text: "hello" });
  assert.equal(reply?.url, "https://open.larksuite.com/open-apis/im/v1/messages/om_1/reply");
  assert.equal(reply?.body.receive_id, undefined);
  assert.ok(create?.body.uuid && reply?.body.uuid && create.body.uuid !== reply.body.uuid);
  assert.ok(create.body.uuid.length <= 50);
});

test("feishu uses its own host", async () => {
  const lark = fakeLark();
  await new LarkChannel({ ...PLAIN, domain: "feishu" }, "acct", lark.fetchImpl).send(TO, { text: "x" }, "k:0");
  assert.match(lark.calls[0]!.url, /^https:\/\/open\.feishu\.cn\//);
});

test("buttons send an interactive card whose values come back through parse", async () => {
  const lark = fakeLark();
  const channel = new LarkChannel(PLAIN, "acct", lark.fetchImpl);
  await channel.send(TO, { text: "发布吗?", buttons: [{ label: "确认", taskId: "t1", action: "approve" }, { label: "取消", taskId: "t1", action: "decline" }] }, "k:0");
  const body = lark.calls[0]?.body;
  assert.equal(body.msg_type, "interactive");
  const sent = JSON.parse(body.content);
  assert.equal(sent.schema, "2.0");
  assert.equal(sent.body.elements[0].text.content, "发布吗?");
  const approve = sent.body.elements[1];
  assert.equal(approve.text.content, "确认");
  assert.deepEqual(channel.parse(press(approve.behaviors[0].value)).events[0]?.button, { taskId: "t1", action: "approve" });
  assert.deepEqual(sent.body.elements[2].behaviors[0].value, { taskId: "t1", action: "decline" });
});

test("a non-zero code throws, even with HTTP 200", async () => {
  const lark = fakeLark(() => Response.json({ code: 230002, msg: "Bot is not in the chat" }));
  await assert.rejects(new LarkChannel(PLAIN, "acct", lark.fetchImpl).send(TO, { text: "x" }, "k:0"), /Bot is not in the chat \(code 230002\)/);
});

test("an HTTP failure without a code throws", async () => {
  const lark = fakeLark(() => new Response("bad gateway", { status: 502 }));
  await assert.rejects(new LarkChannel(PLAIN, "acct", lark.fetchImpl).send(TO, { text: "x" }, "k:0"), /HTTP 502/);
});

test("download fetches the resource with the type from the ref", async () => {
  const lark = fakeLark(() => new Response(Buffer.from("bytes"), { headers: { "content-type": "application/octet-stream" } }));
  const channel = new LarkChannel(PLAIN, "acct", lark.fetchImpl);
  assert.equal((await channel.download({ ref: "om_1|img_1|image", name: "photo.jpg" })).toString(), "bytes");
  assert.equal(lark.calls[0]?.url, "https://open.larksuite.com/open-apis/im/v1/messages/om_1/resources/img_1?type=image");
  assert.equal((lark.calls[0]?.init?.headers as Record<string, string>).authorization, "Bearer t-1");
  await channel.download({ ref: "om_1|file_1|file", name: "deck.pdf" });
  assert.match(lark.calls[1]!.url, /\/resources\/file_1\?type=file$/);
});

test("download failures throw, including code with HTTP 200", async () => {
  const refused = fakeLark(() => Response.json({ code: 234003, msg: "File not in msg." }, { status: 400 }));
  await assert.rejects(new LarkChannel(PLAIN, "acct", refused.fetchImpl).download({ ref: "m|k|file", name: "a" }), /code 234003/);
  const ok = fakeLark(() => Response.json({ code: 234001, msg: "Invalid request param." }));
  await assert.rejects(new LarkChannel(PLAIN, "acct", ok.fetchImpl).download({ ref: "m|k|file", name: "a" }), /code 234001/);
  await assert.rejects(new LarkChannel(PLAIN, "acct", fakeLark().fetchImpl).download({ ref: "nonsense", name: "a" }), /malformed/);
});

test("a JSON file the Expert sent is not mistaken for a failure", async () => {
  const lark = fakeLark(() => Response.json({ code: 0, title: "mine" }));
  assert.deepEqual(JSON.parse((await new LarkChannel(PLAIN, "acct", lark.fetchImpl).download({ ref: "m|k|file", name: "a.json" })).toString()), { code: 0, title: "mine" });
  const coded = fakeLark(() => Response.json({ code: 7 }));
  assert.deepEqual(JSON.parse((await new LarkChannel(PLAIN, "acct", coded.fetchImpl).download({ ref: "m|k|file", name: "a.json" })).toString()), { code: 7 });
});

test("download stops at maxFileBytes, since events carry no size", async () => {
  const channel = (response: () => Response) => new LarkChannel(PLAIN, "acct", fakeLark(response).fetchImpl);
  const max = 50 * 1024 * 1024;
  await assert.rejects(channel(() => new Response("x", { headers: { "content-length": String(max + 1) } })).download({ ref: "m|k|file", name: "a" }), /over/);
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  const stream = () => new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(chunk); } }));
  await assert.rejects(channel(stream).download({ ref: "m|k|file", name: "a" }), /over/);
  assert.ok(pulled <= 55, `read ${pulled} MB`);
});

test("probe calls the bot info API", async () => {
  const lark = fakeLark(() => Response.json({ code: 0, msg: "ok", bot: { open_id: "ou_bot" } }));
  await new LarkChannel(PLAIN, "acct", lark.fetchImpl).probe();
  assert.equal(lark.tokens(), 1);
  assert.equal(lark.calls[0]?.url, "https://open.larksuite.com/open-apis/bot/v3/info");
  assert.equal(lark.calls[0]?.init?.method, "GET");
});

test("probe names wrong credentials, a missing bot, and bot API failures", async () => {
  const wrong = (async () => Response.json({ code: 10014, msg: "app secret invalid" }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(new LarkChannel(PLAIN, "acct", wrong).probe(), /check the App ID, App Secret and domain \(lark\).*app secret invalid \(code 10014\)/);
  await assert.rejects(new LarkChannel(PLAIN, "acct", fakeLark(() => Response.json({ code: 0 })).fetchImpl).probe(), /enable the Bot capability/);
  await assert.rejects(new LarkChannel(PLAIN, "acct", fakeLark(() => Response.json({ code: 99991672, msg: "no permission" })).fetchImpl).probe(), /no permission/);
});

test("a failed token is not cached and the secret stays out of the error", async () => {
  let attempts = 0;
  const fetchImpl = (async () => { attempts++; return Response.json({ code: 10014, msg: "bad" }); }) as unknown as typeof fetch;
  const channel = new LarkChannel({ ...PLAIN, appSecret: "s3cr3t" }, "acct", fetchImpl);
  await assert.rejects(channel.probe(), error => !(error as Error).message.includes("s3cr3t"));
  await assert.rejects(channel.probe());
  assert.equal(attempts, 2);
});

test("capabilities", () => {
  assert.deepEqual(new LarkChannel(PLAIN, "acct").capabilities(), { stream: false, edit: false, typing: false, buttons: true, maxLength: 9000, canInitiate: true, idempotentSend: true });
});

test("send never truncates: a message at maxLength goes whole, as text and as a card", async () => {
  const lark = fakeLark();
  const channel = new LarkChannel(PLAIN, "acct", lark.fetchImpl);
  const text = "汉\"😀".repeat(3000).slice(0, channel.capabilities().maxLength);
  await channel.send(TO, { text }, "k:0");
  await channel.send(TO, { text, buttons: [{ label: "确认", taskId: "t1", action: "approve" }] }, "k:0");
  assert.equal(JSON.parse(lark.calls[0]!.body.content).text, text);
  assert.equal(JSON.parse(lark.calls[1]!.body.content).body.elements[0].text.content, text);
  assert.ok(Buffer.byteLength(String(lark.calls[1]!.init?.body)) < 30 * 1024);
});

test("the outbox key becomes the same uuid every time, and different keys differ", async () => {
  const uuids: string[] = [];
  for (const key of ["a:0", "a:0", "a:1"]) {
    const lark = fakeLark();
    await new LarkChannel(PLAIN, "acct", lark.fetchImpl).send(TO, { text: "hi" }, key);
    uuids.push(lark.calls[0]!.body.uuid);
  }
  assert.match(uuids[0]!, UUID);
  assert.equal(uuids[0], uuids[1]);
  assert.notEqual(uuids[0], uuids[2]);
});

test("send failures are classified for the outbox", async () => {
  const classify = async (answer: () => Response) => {
    const lark = fakeLark(answer);
    const error = await new LarkChannel(PLAIN, "acct", lark.fetchImpl).send(TO, { text: "x" }, "k:0").then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ChannelSendError);
    return error;
  };
  assert.equal((await classify(() => new Response("{}", { status: 429 }))).failure, "definite");
  const denied = await classify(() => new Response("{}", { status: 403 }));
  assert.deepEqual([denied.failure, denied.options.access], ["permanent", true]);
  assert.equal((await classify(() => new Response("{}", { status: 400 }))).failure, "permanent");
  assert.equal((await classify(() => new Response("{}", { status: 500 }))).failure, "ambiguous");
  assert.equal((await classify(() => Response.json({ code: 230002, msg: "Bot is not in the chat" }))).failure, "permanent");
  assert.equal((await classify(() => Response.json({ code: 99991400, msg: "rate limit" }))).failure, "definite");
  assert.equal((await classify(() => { throw new Error("timeout"); })).failure, "ambiguous");
});

test("recorded payload: a redelivered message parses to the same event id, and an unknown event type yields nothing", () => {
  const channel = new LarkChannel(PLAIN, "acct");
  const payload = receive("text", { text: "hi" });
  assert.deepEqual(channel.parse(payload), channel.parse(payload));
  assert.deepEqual(channel.parse(json({ header: { event_id: "e9", event_type: "im.message.reaction.created_v1" }, event: {} })).events, []);
});
