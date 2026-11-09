import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelConnection } from "./connections.js";
import { ChannelPolicyError } from "./eligibility.js";
import { graphError, recorder } from "./recorder.testkit.js";
import { ChannelSendError } from "./types.js";
import { WhatsAppChannel, whatsappEligibility } from "./whatsappChannel.js";

const TASK = "123e4567-e89b-12d3-a456-426614174000";
const BSUID = "US.13491208655302741918";
const tokens = async (tenant: string) => tenant === "W1" ? "token" : undefined;
const channel = (fetchImpl?: typeof fetch) => new WhatsAppChannel({ appSecret: "s", verifyToken: "v", tokens }, fetchImpl);
const value = (phoneNumberId: string, extra: Record<string, unknown>) => ({ messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: phoneNumberId }, ...extra });
const change = (field: string, body: unknown) => ({ field, value: body });
const payload = (...entries: Array<{ id: string; time?: number; changes: unknown[] }>) => Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: entries }));
const messages = (waba: string, phoneNumberId: string, ...list: unknown[]) => ({ id: waba, changes: [change("messages", value(phoneNumberId, { contacts: [{ profile: { name: "Ann" }, wa_id: "16315551181" }], messages: list }))] });
const text = (id: string, from: string, body: string, timestamp = "1700000000") => ({ from, id, timestamp, type: "text", text: { body } });
const parse = (...list: unknown[]) => channel().parse(payload(messages("W1", "PN1", ...list))).events;

test("capabilities: 24 hour service window, no initiating, 4096 characters, buttons and typing", () => {
  assert.deepEqual(channel().capabilities(), { stream: false, edit: false, typing: true, buttons: true, maxLength: 4096, replyWindowMs: 86_400_000, canInitiate: false, idempotentSend: false });
  assert.equal(channel().client, "im");
});

test("parse: a text message has the phone number as sender, the business account as scope and the number in the thread", () => {
  assert.deepEqual(parse(text("wamid.A", "16315551181", "hello")), [{ eventId: "wamid.A", address: { threadId: "W1:PN1:16315551181", senderId: "16315551181" }, scope: "W1", messageRef: "wamid.A", text: "hello" }]);
});

test("parse: with no phone number the BSUID is the contact", () => {
  const [event] = parse({ from_user_id: BSUID, id: "wamid.B", timestamp: "1", type: "text", text: { body: "hi" } });
  assert.deepEqual(event?.address, { threadId: `W1:PN1:${BSUID}`, senderId: BSUID });
  assert.deepEqual(parse({ id: "wamid.C", timestamp: "1", type: "text", text: { body: "nobody" } }), []);
});

test("parse: one POST can carry several business accounts, each its own tenant", () => {
  const events = channel().parse(payload(messages("W1", "PN1", text("a", "111", "one")), messages("W2", "PN9", text("b", "111", "two")))).events;
  assert.deepEqual(events.map(event => [event.eventId, event.scope, event.address.threadId]), [["a", "W1", "W1:PN1:111"], ["b", "W2", "W2:PN9:111"]]);
});

test("parse: out of order messages are read by timestamp, and a repeat is kept once", () => {
  const events = parse(text("late", "111", "second", "20"), text("early", "111", "first", "10"), text("early", "111", "first", "10"));
  assert.deepEqual(events.map(event => event.text), ["first", "second"]);
});

test("parse: statuses, other fields and changes without a number are not events", () => {
  assert.deepEqual(channel().parse(payload({ id: "W1", changes: [change("messages", value("PN1", { statuses: [{ id: "wamid.A", status: "delivered", timestamp: "1", recipient_id: "111" }] }))] })).events, []);
  assert.deepEqual(channel().parse(payload({ id: "W1", changes: [change("account_alerts", {})] })).events, []);
  assert.deepEqual(channel().parse(payload({ id: "W1", changes: [change("messages", { messaging_product: "whatsapp", messages: [text("a", "1", "x")] })] })).events, []);
});

test("parse: media become files named by type, with the caption as text", () => {
  const events = parse(
    { from: "111", id: "i", timestamp: "1", type: "image", image: { id: "M1", mime_type: "image/png", caption: "see" } },
    { from: "111", id: "a", timestamp: "2", type: "audio", audio: { id: "M2", mime_type: "audio/ogg; codecs=opus", voice: true } },
    { from: "111", id: "d", timestamp: "3", type: "document", document: { id: "M3", filename: "plan.pdf", mime_type: "application/pdf" } });
  assert.deepEqual(events.map(event => [event.text, event.file]), [
    ["see", { ref: "W1:M1", name: "photo.png" }], [undefined, { ref: "W1:M2", name: "voice.ogg" }], [undefined, { ref: "W1:M3", name: "plan.pdf" }],
  ]);
});

test("parse: a button reply is a button, and a type we cannot read has no text and no file", () => {
  assert.deepEqual(parse({ from: "111", id: "b", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: `t:${TASK}:approve`, title: "Yes" } } })[0]?.button, { taskId: TASK, action: "approve" });
  const [unsupported] = parse({ from: "111", id: "u", timestamp: "1", type: "unsupported", errors: [{ code: 131051 }] });
  assert.equal(unsupported?.text, undefined);
  assert.equal(unsupported?.file, undefined);
});

test("parse: an account change that ends our access is a revocation of that business account; other changes are not", () => {
  const update = (event: string, body: object = {}) => channel().parse(payload({ id: "W1", time: 1700000000, changes: [change("account_update", { event, ...body })] })).events;
  for (const event of ["PARTNER_REMOVED", "PARTNER_APP_UNINSTALLED", "ACCOUNT_DELETED", "ACCOUNT_OFFBOARDED"]) {
    assert.deepEqual(update(event), [{ eventId: `account_update:W1:${event}:1700000000`, address: { threadId: "W1", senderId: "W1" }, scope: "W1", revoked: true }]);
  }
  assert.equal(update("PARTNER_REMOVED", { waba_info: { waba_id: "W7", owner_business_id: "B" } })[0]?.scope, "W7");
  for (const event of ["PARTNER_ADDED", "ACCOUNT_RECONNECTED", "ACCOUNT_VIOLATION", "DISABLED_UPDATE"]) assert.deepEqual(update(event), []);
});

test("send: text through the number the thread was written to, to a phone number", async () => {
  const { calls, fake } = recorder();
  await channel(fake).send({ threadId: "W1:PN1:16315551181", senderId: "16315551181" }, { text: "hello", replyTo: "wamid.A" }, "k");
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PN1/messages");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer token");
  assert.deepEqual(calls[0]?.body, { messaging_product: "whatsapp", recipient_type: "individual", to: "16315551181", context: { message_id: "wamid.A" }, type: "text", text: { body: "hello", preview_url: false } });
});

test("send: a contact known only by BSUID is addressed by recipient, with no `to`", async () => {
  const { calls, fake } = recorder();
  await channel(fake).send({ threadId: `W1:PN1:${BSUID}`, senderId: BSUID }, { text: "hi" }, "k");
  assert.equal(calls[0]?.body.recipient, BSUID);
  assert.equal("to" in calls[0]?.body, false);
});

test("send: reply buttons carry the task, with titles cut to 20", async () => {
  const { calls, fake } = recorder();
  await channel(fake).send({ threadId: "W1:PN1:111", senderId: "111" }, { text: "ok?", buttons: [{ label: "Approve this change right now", taskId: TASK, action: "approve" }, { label: "No", taskId: TASK, action: "decline" }] }, "k");
  assert.deepEqual(calls[0]?.body.interactive, { type: "button", body: { text: "ok?" }, action: { buttons: [
    { type: "reply", reply: { id: `t:${TASK}:approve`, title: "Approve this change " } }, { type: "reply", reply: { id: `t:${TASK}:decline`, title: "No" } },
  ] } });
});

test("send: a reply too long for a button body goes first as text, and the buttons follow", async () => {
  const { calls, fake } = recorder();
  const long = "x".repeat(1500);
  await channel(fake).send({ threadId: "W1:PN1:111", senderId: "111" }, { text: long, buttons: [{ label: "Yes", taskId: TASK, action: "approve" }, { label: "No", taskId: TASK, action: "decline" }] }, "k");
  assert.deepEqual(calls.map(call => call.body.type), ["text", "interactive"]);
  assert.equal(calls[0]?.body.text.body, long);
  assert.equal(calls[1]?.body.interactive.body.text, "Yes / No");
});

test("outside the 24 hour window WhatsApp refuses with 131047: a permanent failure, and no template is ever sent", async () => {
  const { calls, fake } = recorder(() => graphError(400, { code: 131047, message: "Re-engagement message" }));
  await assert.rejects(channel(fake).send({ threadId: "W1:PN1:111", senderId: "111" }, { text: "late" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "permanent" && !error.options.access && /131047/.test(error.message));
  assert.deepEqual(calls.map(call => call.body.type), ["text"]);
});

test("typing marks the message read and shows the indicator, through the number it was sent to", async () => {
  const { calls, fake } = recorder(() => new Response(JSON.stringify({ success: true })));
  await channel(fake).typing({ threadId: "W1:PN1:111", senderId: "111" }, "wamid.A");
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PN1/messages");
  assert.deepEqual(calls[0]?.body, { messaging_product: "whatsapp", status: "read", message_id: "wamid.A", typing_indicator: { type: "text" } });
  await channel(fake).typing({ threadId: "W1:PN1:111", senderId: "111" });
  assert.equal(calls.length, 1, "nothing to answer, nothing to show");
});

test("probe proves the token reaches the business account and subscribes the app to it", async () => {
  const { calls, fake } = recorder(() => new Response(JSON.stringify({ name: "Acme" })));
  assert.deepEqual(await channel(fake).probe("W1", "tok"), { name: "Acme" });
  assert.deepEqual(calls.map(call => [call.init.method, call.url]), [["GET", "https://graph.facebook.com/v27.0/W1?fields=name"], ["POST", "https://graph.facebook.com/v27.0/W1/subscribed_apps"]]);
  await assert.rejects(channel(recorder(() => graphError(400, { code: 190, message: "bad token" })).fake).probe("W1", "x"), /190/);
});

test("download looks up the media and fetches it with the same token", async () => {
  const { calls, fake } = recorder(url => url.endsWith("/M1") ? new Response(JSON.stringify({ url: "https://lookaside.test/m1", file_size: 5 })) : new Response("bytes"));
  assert.equal((await channel(fake).download({ ref: "W1:M1", name: "photo.png" })).toString(), "bytes");
  assert.deepEqual(calls.map(call => call.url), ["https://graph.facebook.com/v27.0/M1", "https://lookaside.test/m1"]);
  assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, "Bearer token");
});

test("download fails when the media is gone or the account's access is", async () => {
  await assert.rejects(channel(recorder(() => new Response("{}", { status: 404 })).fake).download({ ref: "W1:M1", name: "x" }), /404/);
  await assert.rejects(channel(recorder().fake).download({ ref: "W2:M1", name: "x" }), (error: unknown) => error instanceof ChannelSendError && error.options.access === true);
  await assert.rejects(channel(recorder(url => url.endsWith("/M1") ? new Response(JSON.stringify({ url: "https://lookaside.test/m1" })) : new Response("", { status: 404 })).fake).download({ ref: "W1:M1", name: "x" }), /404/);
});

const connection = (target: ChannelConnection["target"], taskSpecific = false): ChannelConnection => ({ id: "c", ownerAccountId: "a", channel: "whatsapp", client: "im", target, audience: "public", taskSpecific, state: "active", scope: "W1" });

test("eligibility: a Connection is ineligible unless an operator marked it task-specific, and the Assistant never is", () => {
  assert.throws(() => whatsappEligibility(connection({ kind: "assistant" })), (error: unknown) => error instanceof ChannelPolicyError && error.code === "whatsapp_general_purpose_ai");
  assert.throws(() => whatsappEligibility(connection({ kind: "assistant" }, true)), ChannelPolicyError);
  assert.throws(() => whatsappEligibility(connection({ kind: "product", productId: "p" })), ChannelPolicyError);
  assert.doesNotThrow(() => whatsappEligibility(connection({ kind: "product", productId: "p" }, true)));
});
