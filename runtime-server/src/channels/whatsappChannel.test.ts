import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelConnection } from "./connections.js";
import { ChannelPolicyError } from "./eligibility.js";
import { graphError, recorder } from "./recorder.testkit.js";
import { ChannelSendError } from "./types.js";
import { WhatsAppChannel, whatsappEligibility } from "./whatsappChannel.js";

const TASK = "123e4567-e89b-12d3-a456-426614174000";
const BSUID = "US.13491208655302741918";
const tokens = async (tenant: string) => tenant === "PN1" ? "token" : undefined;
const channel = (fetchImpl?: typeof fetch) => new WhatsAppChannel({ appSecret: "s", verifyToken: "v", tokens }, fetchImpl);
const value = (phoneNumberId: string, extra: Record<string, unknown>) => ({ messaging_product: "whatsapp", metadata: { display_phone_number: "15550783881", phone_number_id: phoneNumberId }, ...extra });
const payload = (...changes: unknown[]) => Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA1", changes: changes.map(change => ({ field: "messages", value: change })) }] }));
const text = (id: string, from: string, body: string, timestamp = "1700000000") => ({ from, id, timestamp, type: "text", text: { body } });
const parse = (...messages: unknown[]) => channel().parse(payload(value("PN1", { contacts: [{ profile: { name: "Ann" }, wa_id: "16315551181" }], messages }))).events;

test("capabilities: 24 hour service window, no initiating, 4096 characters, buttons and typing", () => {
  assert.deepEqual(channel().capabilities(), { stream: false, edit: false, typing: true, buttons: true, maxLength: 4096, replyWindowMs: 86_400_000, canInitiate: false, idempotentSend: false });
  assert.equal(channel().client, "im");
});

test("parse: a text message has the phone number as sender, and the phone number id as scope", () => {
  assert.deepEqual(parse(text("wamid.A", "16315551181", "hello")), [{ eventId: "wamid.A", address: { threadId: "PN1:16315551181", senderId: "16315551181" }, scope: "PN1", messageRef: "wamid.A", text: "hello" }]);
});

test("parse: with no phone number the BSUID is the contact", () => {
  const [event] = parse({ from_user_id: BSUID, id: "wamid.B", timestamp: "1", type: "text", text: { body: "hi" } });
  assert.deepEqual(event?.address, { threadId: `PN1:${BSUID}`, senderId: BSUID });
  assert.deepEqual(parse({ id: "wamid.C", timestamp: "1", type: "text", text: { body: "nobody" } }), []);
});

test("parse: one POST can carry several business numbers, each its own tenant", () => {
  const events = channel().parse(payload(
    value("PN1", { messages: [text("a", "111", "one")] }), value("PN2", { messages: [text("b", "111", "two")] }))).events;
  assert.deepEqual(events.map(event => [event.eventId, event.scope, event.address.threadId]), [["a", "PN1", "PN1:111"], ["b", "PN2", "PN2:111"]]);
});

test("parse: out of order messages are read by timestamp, and a repeat is kept once", () => {
  const events = parse(text("late", "111", "second", "20"), text("early", "111", "first", "10"), text("early", "111", "first", "10"));
  assert.deepEqual(events.map(event => event.text), ["first", "second"]);
});

test("parse: statuses, other fields and changes without a number are not events", () => {
  assert.deepEqual(channel().parse(payload(value("PN1", { statuses: [{ id: "wamid.A", status: "delivered", timestamp: "1", recipient_id: "111" }] }))).events, []);
  assert.deepEqual(channel().parse(Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "account_update", value: {} }] }] }))).events, []);
  assert.deepEqual(channel().parse(payload({ messaging_product: "whatsapp", messages: [text("a", "1", "x")] })).events, []);
});

test("parse: media become files named by type, with the caption as text", () => {
  const events = parse(
    { from: "111", id: "i", timestamp: "1", type: "image", image: { id: "M1", mime_type: "image/png", caption: "see" } },
    { from: "111", id: "a", timestamp: "2", type: "audio", audio: { id: "M2", mime_type: "audio/ogg; codecs=opus", voice: true } },
    { from: "111", id: "d", timestamp: "3", type: "document", document: { id: "M3", filename: "plan.pdf", mime_type: "application/pdf" } });
  assert.deepEqual(events.map(event => [event.text, event.file]), [
    ["see", { ref: "PN1:M1", name: "photo.png" }], [undefined, { ref: "PN1:M2", name: "voice.ogg" }], [undefined, { ref: "PN1:M3", name: "plan.pdf" }],
  ]);
});

test("parse: a button reply is a button, and a type we cannot read has no text and no file", () => {
  assert.deepEqual(parse({ from: "111", id: "b", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: `t:${TASK}:approve`, title: "Yes" } } })[0]?.button, { taskId: TASK, action: "approve" });
  const [unsupported] = parse({ from: "111", id: "u", timestamp: "1", type: "unsupported", errors: [{ code: 131051 }] });
  assert.equal(unsupported?.text, undefined);
  assert.equal(unsupported?.file, undefined);
});

test("send: text to a phone number", async () => {
  const { calls, fake } = recorder();
  await channel(fake).send({ threadId: "PN1:16315551181", senderId: "16315551181" }, { text: "hello", replyTo: "wamid.A" }, "k");
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PN1/messages");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer token");
  assert.deepEqual(calls[0]?.body, { messaging_product: "whatsapp", recipient_type: "individual", to: "16315551181", context: { message_id: "wamid.A" }, type: "text", text: { body: "hello", preview_url: false } });
});

test("send: a contact known only by BSUID is addressed by recipient, with no `to`", async () => {
  const { calls, fake } = recorder();
  await channel(fake).send({ threadId: `PN1:${BSUID}`, senderId: BSUID }, { text: "hi" }, "k");
  assert.equal(calls[0]?.body.recipient, BSUID);
  assert.equal("to" in calls[0]?.body, false);
});

test("send: reply buttons carry the task, with titles cut to 20", async () => {
  const { calls, fake } = recorder();
  await channel(fake).send({ threadId: "PN1:111", senderId: "111" }, { text: "ok?", buttons: [{ label: "Approve this change right now", taskId: TASK, action: "approve" }, { label: "No", taskId: TASK, action: "decline" }] }, "k");
  assert.deepEqual(calls[0]?.body.interactive, { type: "button", body: { text: "ok?" }, action: { buttons: [
    { type: "reply", reply: { id: `t:${TASK}:approve`, title: "Approve this change " } }, { type: "reply", reply: { id: `t:${TASK}:decline`, title: "No" } },
  ] } });
});

test("send: a reply too long for a button body goes first as text, and the buttons follow", async () => {
  const { calls, fake } = recorder();
  const long = "x".repeat(1500);
  await channel(fake).send({ threadId: "PN1:111", senderId: "111" }, { text: long, buttons: [{ label: "Yes", taskId: TASK, action: "approve" }, { label: "No", taskId: TASK, action: "decline" }] }, "k");
  assert.deepEqual(calls.map(call => call.body.type), ["text", "interactive"]);
  assert.equal(calls[0]?.body.text.body, long);
  assert.equal(calls[1]?.body.interactive.body.text, "Yes / No");
});

test("outside the 24 hour window WhatsApp refuses with 131047: a permanent failure, and no template is ever sent", async () => {
  const { calls, fake } = recorder(() => graphError(400, { code: 131047, message: "Re-engagement message" }));
  await assert.rejects(channel(fake).send({ threadId: "PN1:111", senderId: "111" }, { text: "late" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.failure === "permanent" && !error.options.access && /131047/.test(error.message));
  assert.deepEqual(calls.map(call => call.body.type), ["text"]);
});

test("download looks up the media and fetches it with the same token", async () => {
  const { calls, fake } = recorder(url => url.endsWith("/M1") ? new Response(JSON.stringify({ url: "https://lookaside.test/m1", file_size: 5 })) : new Response("bytes"));
  assert.equal((await channel(fake).download({ ref: "PN1:M1", name: "photo.png" })).toString(), "bytes");
  assert.deepEqual(calls.map(call => call.url), ["https://graph.facebook.com/v27.0/M1", "https://lookaside.test/m1"]);
  assert.equal((calls[1]?.init.headers as Record<string, string>).authorization, "Bearer token");
});

test("download fails when the media is gone or the number's access is", async () => {
  await assert.rejects(channel(recorder(() => new Response("{}", { status: 404 })).fake).download({ ref: "PN1:M1", name: "x" }), /404/);
  await assert.rejects(channel(recorder().fake).download({ ref: "PN2:M1", name: "x" }), (error: unknown) => error instanceof ChannelSendError && error.options.access === true);
  await assert.rejects(channel(recorder(url => url.endsWith("/M1") ? new Response(JSON.stringify({ url: "https://lookaside.test/m1" })) : new Response("", { status: 404 })).fake).download({ ref: "PN1:M1", name: "x" }), /404/);
});

const connection = (target: ChannelConnection["target"]): ChannelConnection => ({ id: "c", ownerAccountId: "a", channel: "whatsapp", client: "im", target, audience: "public", state: "active", scope: "PN1" });

test("eligibility: the Assistant and an unreviewed Product fail with a policy error; a reviewed Product passes", () => {
  const check = whatsappEligibility(new Set(["reviewed"]));
  assert.throws(() => check(connection({ kind: "assistant" })), (error: unknown) => error instanceof ChannelPolicyError && error.code === "whatsapp_general_purpose_ai");
  assert.throws(() => check(connection({ kind: "product", productId: "other" })), ChannelPolicyError);
  assert.doesNotThrow(() => check(connection({ kind: "product", productId: "reviewed" })));
});
