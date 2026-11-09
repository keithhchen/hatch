import assert from "node:assert/strict";
import test from "node:test";
import { InstagramChannel } from "./instagramChannel.js";
import { render } from "./render.js";
import { MessengerChannel } from "./messengerChannel.js";
import { graphError, recorder } from "./recorder.testkit.js";
import type { MetaMessagingChannel } from "./metaMessaging.js";
import { ChannelSendError, CredentialsExpired } from "./types.js";

const TASK = "123e4567-e89b-12d3-a456-426614174000";
const SECRET = "app-secret";
const VERIFY = "verify-me";
const config = { appSecret: SECRET, verifyToken: VERIFY, tokens: async (tenant: string) => tenant === "PAGE1" || tenant === "IG1" ? "token" : undefined };
const payload = (object: string, ...entry: unknown[]) => Buffer.from(JSON.stringify({ object, entry }));
const instagram = (fetchImpl?: typeof fetch) => new InstagramChannel(config, fetchImpl);
const messenger = (fetchImpl?: typeof fetch) => new MessengerChannel(config, fetchImpl);
const when = (id: string, timestamp: number, sender = "IGSID1", message: unknown = { mid: id, text: id }) => ({ sender: { id: sender }, recipient: { id: "IG1" }, timestamp, message });

test("capabilities come from the documented limits", () => {
  assert.deepEqual(instagram().capabilities(), { stream: false, edit: false, typing: false, buttons: true, maxLength: 1000, maxBytes: 1000, replyWindowMs: 86_400_000, canInitiate: false, idempotentSend: false });
  assert.deepEqual(messenger().capabilities(), { stream: false, edit: false, typing: true, buttons: true, maxLength: 2000, replyWindowMs: 86_400_000, canInitiate: false, idempotentSend: false });
  assert.equal(instagram().client, "dm");
  assert.equal(messenger().client, "dm");
});

test("instagram parse: a text message has the IGSID as sender and the account as scope and thread prefix", () => {
  const { events } = instagram().parse(payload("instagram", { id: "IG1", time: 1700000000, messaging: [when("m1", 1700000000000)] }));
  assert.deepEqual(events, [{ eventId: "m1", address: { threadId: "IG1:IGSID1", senderId: "IGSID1" }, scope: "IG1", messageRef: "m1", text: "m1" }]);
});

test("a batch with entries for several tenants keeps each event on its own tenant", () => {
  const { events } = messenger().parse(payload("page",
    { id: "PAGE1", messaging: [when("a", 1, "PSID1"), when("b", 2, "PSID2")] },
    { id: "PAGE2", messaging: [when("c", 3, "PSID1")] }));
  assert.deepEqual(events.map(event => [event.eventId, event.scope, event.address.threadId, event.address.senderId]), [
    ["a", "PAGE1", "PAGE1:PSID1", "PSID1"], ["b", "PAGE1", "PAGE1:PSID2", "PSID2"], ["c", "PAGE2", "PAGE2:PSID1", "PSID1"],
  ]);
});

test("events that arrive out of order are read by their timestamps", () => {
  const { events } = messenger().parse(payload("page", { id: "PAGE1", messaging: [when("second", 20), when("third", 30), when("first", 10)] }));
  assert.deepEqual(events.map(event => event.text), ["first", "second", "third"]);
});

test("a repeated delivery has the same event id, and a repeat inside one batch is kept once", () => {
  const body = payload("instagram", { id: "IG1", messaging: [when("m1", 1), when("m1", 1)] });
  assert.deepEqual(instagram().parse(body).events.map(event => event.eventId), ["m1"]);
  assert.deepEqual(instagram().parse(body).events, instagram().parse(body).events);
});

test("parse skips echoes, deletions, reads, reactions and messages with nobody to answer", () => {
  const events = (...messaging: unknown[]) => instagram().parse(payload("instagram", { id: "IG1", messaging })).events;
  assert.deepEqual(events(when("e", 1, "IG1", { mid: "e", text: "ours", is_echo: true })), []);
  assert.deepEqual(events(when("d", 1, "IGSID1", { mid: "d", is_deleted: true })), []);
  assert.deepEqual(events({ sender: { id: "IGSID1" }, timestamp: 1, read: { mid: "m" } }, { sender: { id: "IGSID1" }, timestamp: 2, reaction: { mid: "m", action: "react" } }), []);
  assert.deepEqual(events({ timestamp: 1, message: { mid: "x", text: "hi" } }), []);
});

test("parse reads attachments as files, one event each, with the text on the first", () => {
  const message = { mid: "m1", text: "look", attachments: [
    { type: "image", payload: { url: "https://cdn.test/a.jpg" } },
    { type: "audio", payload: { url: "https://cdn.test/v.mp4" } },
    { type: "file", payload: { url: "https://cdn.test/docs/report.pdf" } },
    { type: "ephemeral" }, { type: "location", payload: { coordinates: { lat: 1, long: 2 } } },
  ] };
  const { events } = instagram().parse(payload("instagram", { id: "IG1", messaging: [when("m1", 1, "IGSID1", message)] }));
  assert.deepEqual(events.map(event => [event.eventId, event.text, event.file]), [
    ["m1", "look", { ref: "https://cdn.test/a.jpg", name: "photo.jpg" }],
    ["m1:1", undefined, { ref: "https://cdn.test/v.mp4", name: "voice.m4a" }],
    ["m1:2", undefined, { ref: "https://cdn.test/docs/report.pdf", name: "report.pdf" }],
  ]);
});

test("parse turns quick replies and postbacks of a task into buttons, and reads other quick replies as text", () => {
  const events = (...messaging: unknown[]) => messenger().parse(payload("page", { id: "PAGE1", messaging })).events;
  assert.deepEqual(events(when("q", 1, "PSID1", { mid: "q", text: "Yes", quick_reply: { payload: `t:${TASK}:approve` } }))[0]?.button, { taskId: TASK, action: "approve" });
  assert.deepEqual(events({ sender: { id: "PSID1" }, timestamp: 1, postback: { mid: "p", title: "No", payload: `t:${TASK}:decline` } })[0]?.button, { taskId: TASK, action: "decline" });
  assert.deepEqual(events({ sender: { id: "PSID1" }, timestamp: 1, postback: { mid: "p", title: "Menu", payload: "MENU" } }), []);
  assert.equal(events(when("q", 1, "PSID1", { mid: "q", text: "Blue", quick_reply: { payload: "blue" } }))[0]?.text, "Blue");
});

test("instagram send goes to the account's own endpoint with the tenant's token", async () => {
  const { calls, fake } = recorder();
  await instagram(fake).send({ threadId: "IG1:IGSID1", senderId: "IGSID1" }, { text: "hello" }, "k");
  assert.equal(calls[0]?.url, "https://graph.instagram.com/v27.0/IG1/messages");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer token");
  assert.deepEqual(calls[0]?.body, { recipient: { id: "IGSID1" }, message: { text: "hello" } });
});

test("instagram declares 1000 bytes, so the core renders no message over it, in any script", () => {
  const capabilities = instagram().capabilities();
  assert.equal(capabilities.maxBytes, 1000);
  for (const text of ["你好".repeat(400), "😀".repeat(600), "plain text ".repeat(200)]) {
    const parts = render({ text }, capabilities);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(Buffer.byteLength(part.text) <= 1000 && part.text.length <= 1000);
    assert.equal(parts.map(part => part.text).join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  }
});

test("messenger shows typing with a sender action to the contact on their Page", async () => {
  const { calls, fake } = recorder();
  assert.equal(messenger().capabilities().typing, true);
  await messenger(fake).typing({ threadId: "PAGE1:PSID1", senderId: "PSID1" });
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PAGE1/messages");
  assert.deepEqual(calls[0]?.body, { recipient: { id: "PSID1" }, sender_action: "typing_on" });
  await assert.rejects(messenger(fake).typing({ threadId: "PAGE9:PSID1", senderId: "PSID1" }), ChannelSendError);
});

test("instagram does not declare typing: its documents disagree on whether the sender action exists", () => {
  assert.equal(instagram().capabilities().typing, false);
  assert.equal("typing" in instagram(), false);
});

test("messenger probe proves the Page's token and subscribes the app to its messages", async () => {
  const { calls, fake } = recorder(() => new Response(JSON.stringify({ name: "Acme" })));
  assert.deepEqual(await messenger(fake).probe("PAGE1", "tok"), { name: "Acme" });
  assert.deepEqual(calls.map(call => [call.init.method, call.url]), [["GET", "https://graph.facebook.com/v27.0/PAGE1?fields=name"], ["POST", "https://graph.facebook.com/v27.0/PAGE1/subscribed_apps?subscribed_fields=messages,messaging_postbacks"]]);
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer tok");
  await assert.rejects(messenger(recorder(() => graphError(400, { code: 190, message: "bad token" })).fake).probe("PAGE1", "x"), /190/);
});

const login = { clientId: "ig-app", clientSecret: "ig-secret", redirectUri: "https://hatch.test/v1/channels/instagram/oauth/callback" };
const DAY = 86_400_000;
const igToken = (extra: object = {}) => ({ token: "long-1", userId: "IG1", expiresAt: 60 * DAY, refreshedAt: 0, ...extra });
const igLogin = (fetchImpl: typeof fetch, now = 0) => new InstagramChannel({ ...config, ...login, now: () => now }, fetchImpl);

test("instagram connectUrl is the business login with the state, and needs its app configured", () => {
  const url = new URL(igLogin(recorder().fake).connectUrl("state-1")!);
  assert.equal(url.origin + url.pathname, "https://www.instagram.com/oauth/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: "ig-app", redirect_uri: login.redirectUri, response_type: "code", scope: "instagram_business_basic,instagram_business_manage_messages", state: "state-1" });
  assert.equal(instagram().connectUrl("s"), undefined);
});

test("instagram install trades the code for a 60-day token and subscribes the account to messages", async () => {
  const { calls, fake } = recorder(url => url.startsWith("https://api.instagram.com/oauth/access_token") ? new Response(JSON.stringify({ data: [{ access_token: "short", user_id: "IG1", permissions: "x" }] }))
    : url.startsWith("https://graph.instagram.com/access_token") ? new Response(JSON.stringify({ access_token: "long-1", token_type: "bearer", expires_in: 5183944 })) : new Response(JSON.stringify({ success: true })));
  const installed = await igLogin(fake, 1000).install("code-1");
  assert.deepEqual(installed, { scope: "IG1", credentials: { token: "long-1", userId: "IG1", expiresAt: 1000 + 5183944 * 1000, refreshedAt: 1000 } });
  assert.equal(String(calls[0]?.init.body), "client_id=ig-app&client_secret=ig-secret&grant_type=authorization_code&redirect_uri=https%3A%2F%2Fhatch.test%2Fv1%2Fchannels%2Finstagram%2Foauth%2Fcallback&code=code-1");
  assert.match(calls[1]!.url, /grant_type=ig_exchange_token.*access_token=short/);
  assert.equal(calls[2]?.url, "https://graph.instagram.com/v27.0/IG1/subscribed_apps?subscribed_fields=messages");
  assert.equal((calls[2]?.init.headers as Record<string, string>).authorization, "Bearer long-1");
  await assert.rejects(igLogin(recorder(() => new Response(JSON.stringify({ error_message: "Invalid authorization code" }), { status: 400 })).fake).install("bad"), /Invalid authorization code/);
  await assert.rejects(instagram().install("c"), /not configured/);
});

test("instagram refresh renews a token in its last two weeks once it is a day old, and not before", async () => {
  const { calls, fake } = recorder(() => new Response(JSON.stringify({ access_token: "long-2", token_type: "bearer", expires_in: 5184000 })));
  const at = (days: number) => new Date(days * DAY);
  assert.equal(await igLogin(fake).refresh(igToken(), at(10)), undefined);
  assert.equal(await igLogin(fake).refresh(igToken({ refreshedAt: 47 * DAY }), at(47.5)), undefined, "less than a day old");
  assert.equal(calls.length, 0);
  assert.deepEqual(await igLogin(fake).refresh(igToken(), at(50)), igToken({ token: "long-2", expiresAt: 50 * DAY + 5184000 * 1000, refreshedAt: 50 * DAY }));
  assert.match(calls[0]!.url, /^https:\/\/graph\.instagram\.com\/refresh_access_token\?grant_type=ig_refresh_token&access_token=long-1$/);
});

test("instagram refresh of an expired token says it cannot be renewed; a failed renewal is an ordinary error", async () => {
  await assert.rejects(igLogin(recorder().fake).refresh(igToken(), new Date(61 * DAY)), CredentialsExpired);
  await assert.rejects(igLogin(recorder(() => new Response("{}", { status: 500 })).fake).refresh(igToken(), new Date(50 * DAY)), (error: unknown) => error instanceof Error && !(error instanceof CredentialsExpired));
});

test("quick replies go on the last message only, titles cut to 20", async () => {
  const { calls, fake } = recorder();
  await messenger(fake).send({ threadId: "PAGE1:PSID1", senderId: "PSID1" }, { text: "ok?", buttons: [{ label: "Approve this change right now please", taskId: TASK, action: "approve" }, { label: "No", taskId: TASK, action: "decline" }] }, "k");
  assert.deepEqual(calls[0]?.body, {
    recipient: { id: "PSID1" }, messaging_type: "RESPONSE",
    message: { text: "ok?", quick_replies: [{ content_type: "text", title: "Approve this change ", payload: `t:${TASK}:approve` }, { content_type: "text", title: "No", payload: `t:${TASK}:decline` }] },
  });
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PAGE1/messages");
});

test("instagram: the Business AI handover error is a real permanent failure that says who holds the conversation", async () => {
  const { fake } = recorder(() => graphError(400, { code: 100, error_subcode: 2534037, message: "Invalid parameter" }));
  await assert.rejects(instagram(fake).send({ threadId: "IG1:IGSID1", senderId: "IGSID1" }, { text: "hi" }, "k"), (error: unknown) =>
    error instanceof ChannelSendError && error.failure === "permanent" && !error.options.access && /Business AI owns this conversation.*100\/2534037/.test(error.message));
});

test("messenger: outside the window is permanent, and the token being revoked loses access", async () => {
  const outside = recorder(() => graphError(400, { code: 10, error_subcode: 2018278, message: "outside allowed window" }));
  await assert.rejects(messenger(outside.fake).send({ threadId: "PAGE1:PSID1", senderId: "PSID1" }, { text: "hi" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "permanent" && !error.options.access);
  const revoked = recorder(() => graphError(400, { code: 190, error_subcode: 458, message: "user removed the app" }));
  await assert.rejects(messenger(revoked.fake).send({ threadId: "PAGE1:PSID1", senderId: "PSID1" }, { text: "hi" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "permanent" && error.options.access === true);
});

test("download fetches the attachment URL without a token, over https only", async () => {
  const { calls, fake } = recorder(() => new Response("bytes"));
  assert.equal((await messenger(fake).download({ ref: "https://cdn.test/a.jpg", name: "photo.jpg" })).toString(), "bytes");
  assert.equal((calls[0]?.init.headers as unknown), undefined);
  await assert.rejects(messenger(fake).download({ ref: "http://cdn.test/a.jpg", name: "x" }), /https/);
  const failing = recorder(() => new Response("", { status: 404 }));
  await assert.rejects(messenger(failing.fake).download({ ref: "https://cdn.test/a.jpg", name: "x" }), /404/);
  const huge = recorder(() => new Response("x", { headers: { "content-length": String(21 * 1024 * 1024) } }));
  await assert.rejects(messenger(huge.fake).download({ ref: "https://cdn.test/a.jpg", name: "x" }), /over/);
});

test("a fan has to message first: the adapter cannot start a conversation", () => {
  for (const channel of [instagram(), messenger()] as MetaMessagingChannel[]) assert.equal(channel.capabilities().canInitiate, false);
});
