import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { recorder } from "./recorder.testkit.js";
import { SlackChannel } from "./slackChannel.js";
import { ChannelSendError } from "./types.js";

const TASK = "123e4567-e89b-12d3-a456-426614174000";
const SECRET = "signing-secret";
const NOW = 1_700_000_000_000;
const tokens = async (team: string) => team === "T1" ? "xoxb-1" : undefined;
const config = { signingSecret: SECRET, clientId: "cid", clientSecret: "csecret", redirectUri: "https://hatch.test/slack/callback", tokens, now: () => NOW };
const channel = (fetchImpl?: typeof fetch, overrides: object = {}) => new SlackChannel({ ...config, ...overrides }, fetchImpl);
const envelope = (event: unknown, extra: object = {}) => Buffer.from(JSON.stringify({ token: "x", team_id: "T1", api_app_id: "A1", type: "event_callback", event_id: "Ev1", event_time: 1700000000, authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }], event, ...extra }));
const im = (extra: object = {}) => ({ type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hello", ts: "1700000000.000100", event_ts: "1700000000.000100", ...extra });
const mention = (extra: object = {}) => ({ type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> what now", ts: "1700000001.000200", event_ts: "1700000001.000200", ...extra });
const slackError = (error: string, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify({ ok: false, error }), { status, headers });
const ok = () => new Response(JSON.stringify({ ok: true, ts: "1.2" }));
const to = { threadId: "T1:D1", senderId: "U1" };

test("capabilities: native streaming, edits, status, buttons; 3000 characters", () => {
  assert.deepEqual(channel().capabilities(), { stream: true, edit: true, typing: true, buttons: true, maxLength: 3000, canInitiate: true, idempotentSend: false });
  assert.equal(channel().client, "im");
});

test("available needs the signing secret and workspace tokens", () => {
  assert.equal(channel().available(), true);
  assert.equal(channel(undefined, { signingSecret: undefined }).available(), false);
  assert.equal(channel(undefined, { tokens: undefined }).available(), false);
});

function signature(raw: Buffer, timestamp: number, secret = SECRET) {
  return { "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`, "x-slack-request-timestamp": String(timestamp) };
}

test("verify accepts Slack's v0 signature, and rejects a wrong secret, a changed body and a replay", () => {
  const raw = envelope(im());
  const now = NOW / 1000;
  assert.equal(channel().verify(raw, signature(raw, now)), true);
  assert.equal(channel().verify(raw, signature(raw, now - 299)), true);
  assert.equal(channel().verify(raw, signature(raw, now - 301)), false);
  assert.equal(channel().verify(raw, signature(raw, now + 301)), false);
  assert.equal(channel().verify(raw, signature(raw, now, "other")), false);
  assert.equal(channel().verify(Buffer.from(`${raw} `), signature(raw, now)), false);
  assert.equal(channel().verify(raw, { "x-slack-signature": "v0=short", "x-slack-request-timestamp": String(now) }), false);
  assert.equal(channel().verify(raw, {}), false);
  assert.equal(channel(undefined, { signingSecret: undefined }).verify(raw, signature(raw, now)), false);
});

test("parse answers the url verification challenge and has no events", () => {
  assert.deepEqual(channel().parse(Buffer.from(JSON.stringify({ token: "x", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", type: "url_verification" }))),
    { events: [], respond: { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" } });
});

test("parse: a direct message has the workspace as scope, the user as sender and the DM as thread", () => {
  assert.deepEqual(channel().parse(envelope(im())).events, [{ eventId: "Ev1", address: { threadId: "T1:D1", senderId: "U1" }, scope: "T1", messageRef: "1700000000.000100", text: "hello" }]);
});

test("parse: a reply inside a DM thread keeps that thread, and a mention in a channel starts one", () => {
  assert.equal(channel().parse(envelope(im({ thread_ts: "1699999999.000001" }))).events[0]?.address.threadId, "T1:D1:1699999999.000001");
  const [event] = channel().parse(envelope(mention())).events;
  assert.deepEqual(event, { eventId: "Ev1", address: { threadId: "T1:C1:1700000001.000200", senderId: "U1" }, scope: "T1", messageRef: "1700000001.000200", group: true, text: "what now" });
  assert.equal(channel().parse(envelope(mention({ thread_ts: "1700000000.000001" }))).events[0]?.address.threadId, "T1:C1:1700000000.000001");
});

test("parse: a channel message that does not mention us is not ours, whoever sent it", () => {
  assert.deepEqual(channel().parse(envelope(im({ channel: "C1", channel_type: "channel" }))).events, []);
  assert.deepEqual(channel().parse(envelope(im({ channel: "G1", channel_type: "group" }))).events, []);
});

test("parse skips bots, edits, deletions and revocation notices", () => {
  for (const event of [im({ bot_id: "B1" }), im({ subtype: "bot_message" }), im({ subtype: "message_changed" }), im({ subtype: "message_deleted" }), im({ user: undefined }),
    { type: "tokens_revoked", tokens: { oauth: ["U1"], bot: ["UBOT"] } }, { type: "app_uninstalled" }]) {
    assert.deepEqual(channel().parse(envelope(event)).events, []);
  }
  assert.deepEqual(channel().parse(Buffer.from(JSON.stringify({ type: "app_rate_limited", team_id: "T1" }))).events, []);
  assert.deepEqual(channel().parse(envelope(im(), { team_id: undefined })).events, []);
});

test("parse: a retry of the same event has the same event id", () => {
  assert.deepEqual(channel().parse(envelope(im())).events, channel().parse(envelope(im())).events);
});

test("parse: files are one event each, with the text on the first, and skip files we cannot fetch", () => {
  const files = [
    { id: "F1", name: "a.pdf", size: 10, mode: "hosted", url_private_download: "https://files.slack.com/files-pri/T1-F1/download/a.pdf" },
    { id: "F2", name: null, mode: "hosted", url_private_download: "https://files.slack.com/files-pri/T1-F2/download/voice.m4a", mimetype: "audio/mp4" },
    { id: "F3", mode: "external", url_private_download: "https://elsewhere.test/x" },
    { id: "F4", mode: "hosted", file_access: "check_file_info", url_private_download: "https://files.slack.com/f4" },
  ];
  const { events } = channel().parse(envelope(im({ subtype: "file_share", text: "see", files })));
  assert.deepEqual(events.map(event => [event.eventId, event.text, event.file]), [
    ["Ev1", "see", { ref: "T1|https://files.slack.com/files-pri/T1-F1/download/a.pdf", name: "a.pdf", size: 10 }],
    ["Ev1:1", undefined, { ref: "T1|https://files.slack.com/files-pri/T1-F2/download/voice.m4a", name: "file" }],
  ]);
});

const form = (payload: unknown) => Buffer.from(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
const pressed = (value = `t:${TASK}:approve`, message: object = { ts: "1700000002.000300" }) => ({
  type: "block_actions", trigger_id: "13345224609.738474920.8088930838d88f008e0", user: { id: "U1", team_id: "T1" }, team: { id: "T1" }, channel: { id: "D1" }, message,
  actions: [{ action_id: value, block_id: "b", type: "button", value, action_ts: "1700000003.1" }],
});

test("parse: a button press is a button event on the message's thread, with a ref to clear it", () => {
  const [event] = channel().parse(form(pressed())).events;
  assert.deepEqual(event, { eventId: "13345224609.738474920.8088930838d88f008e0:0", scope: "T1", messageRef: "1700000002.000300", address: { threadId: "T1:D1", senderId: "U1" }, button: { taskId: TASK, action: "approve", ref: "D1|1700000002.000300" } });
  assert.equal(channel().parse(form(pressed(`t:${TASK}:decline`, { ts: "1.3", thread_ts: "1.1" }))).events[0]?.address.threadId, "T1:D1:1.1");
  assert.deepEqual(channel().parse(form(pressed("something else"))).events, []);
  assert.deepEqual(channel().parse(form({ type: "view_submission" })).events, []);
});

test("send posts into the thread with the workspace's token", async () => {
  const { calls, fake } = recorder(ok);
  await channel(fake).send({ threadId: "T1:C1:1700000001.000200", senderId: "U1" }, { text: "hello" }, "k");
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.postMessage");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer xoxb-1");
  assert.deepEqual(calls[0]?.body, { channel: "C1", text: "hello", unfurl_links: false, unfurl_media: false, thread_ts: "1700000001.000200" });
  await channel(fake).send(to, { text: "dm" }, "k");
  assert.equal("thread_ts" in calls[1]?.body, false);
});

test("send: approval buttons are Block Kit buttons that carry the task", async () => {
  const { calls, fake } = recorder(ok);
  await channel(fake).send(to, { text: "ok?", buttons: [{ label: "Approve", taskId: TASK, action: "approve" }, { label: "Decline", taskId: TASK, action: "decline" }] }, "k");
  assert.deepEqual(calls[0]?.body.blocks, [
    { type: "section", text: { type: "mrkdwn", text: "ok?" } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: `t:${TASK}:approve`, value: `t:${TASK}:approve` },
      { type: "button", text: { type: "plain_text", text: "Decline" }, action_id: `t:${TASK}:decline`, value: `t:${TASK}:decline` },
    ] },
  ]);
});

test("send classifies Slack's answers by their error name, since most arrive as HTTP 200", async () => {
  const cases: Array<[Response, string, boolean, number | undefined]> = [
    [slackError("ratelimited", 429, { "retry-after": "3" }), "definite", false, 3000],
    [slackError("ratelimited"), "definite", false, undefined],
    [slackError("token_revoked"), "permanent", true, undefined],
    [slackError("account_inactive"), "permanent", true, undefined],
    [slackError("invalid_auth", 401), "permanent", true, undefined],
    [slackError("channel_not_found"), "permanent", false, undefined],
    [slackError("is_archived"), "permanent", false, undefined],
    [slackError("msg_too_long"), "permanent", false, undefined],
    [slackError("internal_error"), "ambiguous", false, undefined],
    [slackError("fatal_error"), "ambiguous", false, undefined],
    [slackError("service_unavailable", 503), "ambiguous", false, undefined],
    [new Response("<html>", { status: 502 }), "ambiguous", false, undefined],
  ];
  for (const [response, failure, access, retryAfterMs] of cases) {
    const { fake } = recorder(() => response.clone());
    await assert.rejects(channel(fake).send(to, { text: "hi" }, "k"), (error: unknown) =>
      error instanceof ChannelSendError && error.failure === failure && error.options.access === access && error.options.retryAfterMs === retryAfterMs, `${failure} ${response.status}`);
  }
});

test("send: a timeout may have been posted; a workspace with no token has revoked access", async () => {
  const { fake } = recorder(() => { throw new DOMException("timed out", "TimeoutError"); });
  await assert.rejects(channel(fake).send(to, { text: "hi" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "ambiguous");
  const none = recorder(ok);
  await assert.rejects(channel(none.fake).send({ threadId: "T2:D1", senderId: "U1" }, { text: "hi" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "permanent" && error.options.access === true);
  assert.equal(none.calls.length, 0);
});

test("acknowledge removes the buttons of the pressed message", async () => {
  const { calls, fake } = recorder(ok);
  const [event] = channel().parse(form(pressed())).events;
  await channel(fake).acknowledge(event!, "Approved");
  assert.equal(calls[0]?.url, "https://slack.com/api/chat.update");
  assert.deepEqual(calls[0]?.body, { channel: "D1", ts: "1700000002.000300", text: "Approved", blocks: [] });
  await channel(fake).acknowledge({ eventId: "x", address: to }, "ignored");
  assert.equal(calls.length, 1);
});

test("download sends the token only to files.slack.com and refuses redirects", async () => {
  const { calls, fake } = recorder(() => new Response("bytes"));
  const ref = "T1|https://files.slack.com/files-pri/T1-F1/download/a.pdf";
  assert.equal((await channel(fake).download({ ref, name: "a.pdf" })).toString(), "bytes");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer xoxb-1");
  assert.equal(calls[0]?.init.redirect, "error");
  for (const bad of ["T1|https://evil.test/a", "T1|http://files.slack.com/a", "T1|https://files.slack.com.evil.test/a"]) await assert.rejects(channel(fake).download({ ref: bad, name: "a" }), /files\.slack\.com/);
  assert.equal(calls.length, 1);
  await assert.rejects(channel(recorder(() => new Response("", { status: 403 })).fake).download({ ref, name: "a" }), /403/);
  await assert.rejects(channel(fake).download({ ref: ref.replace("T1|", "T2|"), name: "a" }), (error: unknown) => error instanceof ChannelSendError && error.options.access === true);
});

test("connectUrl is the OAuth install link with the state, and install trades the code for the workspace's token", async () => {
  const url = new URL(channel().connectUrl("state-1")!);
  assert.equal(url.origin + url.pathname, "https://slack.com/oauth/v2/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: "cid", scope: "app_mentions:read,chat:write,im:history,files:read", redirect_uri: "https://hatch.test/slack/callback", state: "state-1" });
  assert.equal(channel(undefined, { clientId: undefined }).connectUrl("s"), undefined);
  const { calls, fake } = recorder(() => new Response(JSON.stringify({ ok: true, access_token: "xoxb-new", bot_user_id: "UBOT", team: { id: "T9", name: "Acme" } })));
  assert.deepEqual(await channel(fake).install("code-1"), { team: "T9", token: "xoxb-new", botUserId: "UBOT" });
  assert.equal(String(calls[0]?.init.body), "client_id=cid&client_secret=csecret&code=code-1&redirect_uri=https%3A%2F%2Fhatch.test%2Fslack%2Fcallback");
  await assert.rejects(channel(recorder(() => new Response(JSON.stringify({ ok: false, error: "invalid_code" }))).fake).install("bad"), /invalid_code/);
  await assert.rejects(channel(undefined, { clientSecret: undefined }).install("c"), /not configured/);
});
