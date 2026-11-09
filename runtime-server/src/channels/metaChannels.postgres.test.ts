import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { ChannelPolicyError, guarded } from "./eligibility.js";
import { ChannelHub } from "./hub.js";
import { MessengerChannel } from "./messengerChannel.js";
import type { Handled, Inbound, TargetHandler } from "./ports.js";
import { graphError, recorder, sign } from "./recorder.testkit.js";
import { ChannelService, openChannelStores } from "./service.js";
import type { ChannelAdapter, ChannelKind } from "./types.js";
import { WhatsAppChannel, whatsappEligibility } from "./whatsappChannel.js";

// Opt-in integration tests over a real database. Every test owns a random schema. The platforms are never called: fetch is recorded.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };
async function isolated<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `hatch_meta_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 8 });
    return await body(pool);
  } finally {
    await pool?.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  }
}

class RecordingTarget implements TargetHandler {
  handled: Inbound[] = [];
  async handle(inbound: Inbound): Promise<Handled> { this.handled.push(inbound); return { replied: false }; }
  async linked() { return "linked"; }
}

const SECRET = "app-secret";
const scopeOf = () => "";
const tokens = async (tenant: string) => ["PAGE1", "PAGE2", "PN1"].includes(tenant) ? "token" : undefined;
const config = { appSecret: SECRET, verifyToken: "v", tokens };

async function stack(pool: Pool, adapter: ChannelAdapter, wrap: (target: TargetHandler) => TargetHandler = target => target) {
  const stores = await openChannelStores(pool, scopeOf);
  const clock = { at: new Date("2026-11-10T00:00:00Z") };
  const errors: unknown[] = [];
  const service = new ChannelService({ ...stores, hub: new ChannelHub([adapter]), scopeOf, now: () => clock.at, onError: error => errors.push(error) });
  const target = new RecordingTarget();
  service.register("product", wrap(target));
  const connect = async (channel: ChannelKind, scope: string, productId: string) => (await pool.query(
    "INSERT INTO hatch_connections (owner_account_id, channel, scope, client, target, target_key, audience) VALUES ($1, $2, $3, $4, $5, $6, 'public') RETURNING id",
    [randomUUID(), channel, scope, channel === "messenger" ? "dm" : "im", JSON.stringify({ kind: "product", productId }), `product:${productId}`])).rows[0].id as string;
  /** What the platform delivers: signed, verified and parsed like the webhook route does, then accepted. */
  const deliver = async (body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    assert.equal(adapter.verify!(raw, { "x-hub-signature-256": sign(raw, SECRET) }), true);
    await service.accept(adapter, adapter.parse!(raw).events);
    await service.drain();
  };
  return { ...stores, service, target, clock, errors, connect, deliver };
}

const messaging = (page: string, mid: string, sender: string, timestamp: number) => ({ id: page, messaging: [{ sender: { id: sender }, recipient: { id: page }, timestamp, message: { mid, text: mid } }] });

test("A batch for two Pages reaches each Page's Connection, a repeat is not handled twice, and the same fan is a different contact on each Page", options, async () => isolated(async pool => {
  const env = await stack(pool, new MessengerChannel(config, recorder().fake));
  const one = await env.connect("messenger", "PAGE1", "p1");
  const two = await env.connect("messenger", "PAGE2", "p2");
  const batch = { object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1), messaging("PAGE2", "m2", "PSID1", 2)] };
  await env.deliver(batch);
  await env.deliver(batch);
  assert.deepEqual(env.target.handled.map(inbound => [inbound.connection.id, inbound.connection.client, inbound.address.senderId, inbound.address.threadId, inbound.principal.kind]),
    [[one, "dm", "PSID1", "PAGE1:PSID1", "contact"], [two, "dm", "PSID1", "PAGE2:PSID1", "contact"]]);
  const contacts = env.target.handled.map(inbound => inbound.principal.kind === "contact" ? inbound.principal.contactId : "");
  assert.notEqual(contacts[0], contacts[1]);
  assert.deepEqual(env.errors, []);
}));

test("A reply goes to the Page it came from inside the 24 hour window, and after it stays in Hatch as undelivered with nothing sent", options, async () => isolated(async pool => {
  const { calls, fake } = recorder();
  const env = await stack(pool, new MessengerChannel(config, fake));
  const connection = await env.connect("messenger", "PAGE2", "p2");
  await env.deliver({ object: "page", entry: [messaging("PAGE2", "m1", "PSID9", 1)] });
  const [inbound] = env.target.handled;
  assert.ok(await env.service.reply(inbound!.id, { text: "Hello!" }));
  await env.service.drain();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PAGE2/messages");
  assert.deepEqual(calls[0]?.body, { recipient: { id: "PSID9" }, messaging_type: "RESPONSE", message: { text: "Hello!" } });
  env.clock.at = new Date(env.clock.at.getTime() + 25 * 60 * 60_000);
  assert.ok(await env.service.reply(inbound!.id, { text: "too late" }));
  await env.service.drain();
  assert.equal(calls.length, 1);
  assert.deepEqual((await env.outbox.undelivered(connection)).map(delivery => delivery.parts[0]!.text), ["too late"]);
}));

test("Revoked access fails the delivery for good and degrades the Connection; a duplicate-free retry is not attempted", options, async () => isolated(async pool => {
  const { calls, fake } = recorder(() => graphError(400, { code: 190, message: "Error validating access token" }));
  const env = await stack(pool, new MessengerChannel(config, fake));
  const connection = await env.connect("messenger", "PAGE1", "p1");
  await env.deliver({ object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1)] });
  await env.service.reply(env.target.handled[0]!.id, { text: "hi" });
  await env.service.drain();
  await env.service.drain();
  assert.equal(calls.length, 1);
  assert.equal((await env.connections.get(connection))?.state, "degraded");
  assert.equal((await pool.query("SELECT state FROM hatch_channel_outbox")).rows[0].state, "failed");
}));

test("A send that timed out is left unknown, never sent twice", options, async () => isolated(async pool => {
  const { calls, fake } = recorder(() => { throw new DOMException("timed out", "TimeoutError"); });
  const env = await stack(pool, new MessengerChannel(config, fake));
  await env.connect("messenger", "PAGE1", "p1");
  await env.deliver({ object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1)] });
  await env.service.reply(env.target.handled[0]!.id, { text: "hi" });
  await env.service.drain();
  await env.service.drain();
  assert.equal(calls.length, 1);
  assert.equal((await pool.query("SELECT state FROM hatch_channel_outbox")).rows[0].state, "unknown");
}));

test("WhatsApp: an unreviewed Product fails the eligibility check with a real error and is never answered; a reviewed one is", options, async () => isolated(async pool => {
  const whatsapp = new WhatsAppChannel(config, recorder().fake);
  const text = { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ from: "111", id: "wamid.1", timestamp: "1", type: "text", text: { body: "hi" } }] } }] }] };
  const blocked = await stack(pool, whatsapp, target => guarded(target, { whatsapp: whatsappEligibility(new Set()) }));
  await blocked.connect("whatsapp", "PN1", "p1");
  await blocked.deliver(text);
  assert.equal(blocked.target.handled.length, 0);
  assert.ok(blocked.errors.some(error => error instanceof ChannelPolicyError && error.code === "whatsapp_general_purpose_ai"));
}));

test("WhatsApp: a reviewed Product is answered through the number it was written to", options, async () => isolated(async pool => {
  const { calls, fake } = recorder();
  const env = await stack(pool, new WhatsAppChannel(config, fake), target => guarded(target, { whatsapp: whatsappEligibility(new Set(["p1"])) }));
  await env.connect("whatsapp", "PN1", "p1");
  await env.deliver({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ from_user_id: "US.123", id: "wamid.1", timestamp: "1", type: "text", text: { body: "hi" } }] } }] }] });
  assert.equal(env.target.handled.length, 1);
  await env.service.reply(env.target.handled[0]!.id, { text: "hello" });
  await env.service.drain();
  assert.equal(calls[0]?.url, "https://graph.facebook.com/v27.0/PN1/messages");
  assert.equal(calls[0]?.body.recipient, "US.123");
}));
