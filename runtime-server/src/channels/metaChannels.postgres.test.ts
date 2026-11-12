import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { CredentialSeal } from "../assistant/channelCredentials.js";
import { CredentialRefresher } from "./credentialRefresh.js";
import { ChannelPolicyError, guarded } from "./eligibility.js";
import { ChannelHub } from "./hub.js";
import { InstagramChannel } from "./instagramChannel.js";
import { MessengerChannel } from "./messengerChannel.js";
import type { Handled, Inbound, TargetHandler } from "./ports.js";
import { graphError, recorder, sign } from "./recorder.testkit.js";
import { ChannelService, openChannelStores } from "./service.js";
import { SlackChannel } from "./slackChannel.js";
import { sealedTokens } from "./tenantTokens.js";
import { ChannelSendError, type ChannelAdapter, type ChannelKind } from "./types.js";
import { WhatsAppChannel, whatsappEligibility } from "./whatsappChannel.js";

/** Test time starts a minute ahead of the real clock: rows the database stamps with now() are already due, never in the clock's future. */
const START = Date.now() + 60_000;
const at = (offsetMs: number) => new Date(START + offsetMs);

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

/** The typing indicator starts in the background once the event is done. */
const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i += 1) await new Promise(resolve => setTimeout(resolve, 10)); };

class RecordingTarget implements TargetHandler {
  handled: Inbound[] = [];
  async handle(inbound: Inbound): Promise<Handled> { this.handled.push(inbound); return { replied: false, runId: "run" }; }
  async linked() { return "linked"; }
}

type Tokens = (kind: ChannelKind) => ReturnType<typeof sealedTokens>;
const SECRET = "app-secret";
const scopeOf = () => "";
const seal = new CredentialSeal("test-sealing-key");
const config = { appSecret: SECRET, verifyToken: "v" };

/** Tenants are configured the way production does: sealed credentials on a Connection, read back by scope. */
async function stack(pool: Pool, make: (tokens: Tokens) => ChannelAdapter, wrap: (target: TargetHandler) => TargetHandler = target => target) {
  const stores = await openChannelStores(pool, scopeOf);
  const adapter = make(kind => sealedTokens(stores.connections, seal, kind));
  const clock = { at: at(0) };
  const errors: unknown[] = [];
  const service = new ChannelService({ ...stores, hub: new ChannelHub([adapter], undefined, () => true), scopeOf, now: () => clock.at, onError: error => errors.push(error) });
  const target = new RecordingTarget();
  service.register("product", wrap(target)).register("assistant", target);
  const credentialed = async (tenant: string, token = "token") => stores.connections.saveCredentials(randomUUID(), adapter.kind, seal.seal({ token }), tenant);
  const connect = async (scope: string, productId: string, taskSpecific = false) => (await pool.query(
    "INSERT INTO hatch_connections (owner_account_id, channel, scope, client, target, target_key, audience, task_specific) VALUES ($1, $2, $3, $4, $5, $6, 'public', $7) RETURNING id",
    [randomUUID(), adapter.kind, scope, adapter.kind === "messenger" || adapter.kind === "instagram" ? "dm" : "im", JSON.stringify({ kind: "product", productId }), `product:${productId}`, taskSpecific])).rows[0].id as string;
  /** What the platform delivers: signed, verified and parsed like the webhook route does, then accepted. */
  const deliver = async (body: unknown) => {
    const raw = Buffer.from(JSON.stringify(body));
    assert.equal(adapter.verify!(raw, { "x-hub-signature-256": sign(raw, SECRET) }), true);
    await service.accept(adapter, (await adapter.parse!(raw)).events);
    await service.drain();
  };
  return { ...stores, adapter, service, target, clock, errors, connect, credentialed, deliver };
}
const messenger = (fetchImpl?: typeof fetch) => (tokens: Tokens) => new MessengerChannel({ ...config, tokens: tokens("messenger") }, fetchImpl);
const messaging = (page: string, mid: string, sender: string, timestamp: number) => ({ id: page, messaging: [{ sender: { id: sender }, recipient: { id: page }, timestamp, message: { mid, text: mid } }] });

test("A batch for two Pages reaches each Page's Connection, a repeat is not handled twice, and the same fan is a different contact on each Page", options, async () => isolated(async pool => {
  const env = await stack(pool, messenger(recorder().fake));
  const one = await env.connect("PAGE1", "p1");
  const two = await env.connect("PAGE2", "p2");
  const batch = { object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1), messaging("PAGE2", "m2", "PSID1", 2)] };
  await env.deliver(batch);
  await env.deliver(batch);
  assert.deepEqual(env.target.handled.map(inbound => [inbound.connection.id, inbound.connection.client, inbound.address.senderId, inbound.address.threadId, inbound.principal.kind]),
    [[one, "dm", "PSID1", "PAGE1:PSID1", "contact"], [two, "dm", "PSID1", "PAGE2:PSID1", "contact"]]);
  const contacts = env.target.handled.map(inbound => inbound.principal.kind === "contact" ? inbound.principal.contactId : "");
  assert.notEqual(contacts[0], contacts[1]);
  assert.deepEqual(env.errors, []);
}));

test("A reply goes to the Page it came from inside the 24 hour window, with that tenant's sealed token, and after it stays in Hatch as undelivered", options, async () => isolated(async pool => {
  const { calls, fake } = recorder();
  const env = await stack(pool, messenger(fake));
  await env.credentialed("PAGE2", "page-2-token");
  const connection = await env.connect("PAGE2", "p2");
  await env.deliver({ object: "page", entry: [messaging("PAGE2", "m1", "PSID9", 1)] });
  const [inbound] = env.target.handled;
  assert.ok(await env.service.reply(inbound!.id, { text: "Hello!" }));
  await env.service.drain();
  const sends = calls.filter(call => call.body.message);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.url, "https://graph.facebook.com/v27.0/PAGE2/messages");
  assert.equal((sends[0]?.init.headers as Record<string, string>).authorization, "Bearer page-2-token");
  assert.deepEqual(sends[0]?.body, { recipient: { id: "PSID9" }, messaging_type: "RESPONSE", message: { text: "Hello!" } });
  env.clock.at = new Date(env.clock.at.getTime() + 25 * 60 * 60_000);
  assert.ok(await env.service.reply(inbound!.id, { text: "too late" }));
  await env.service.drain();
  assert.equal(calls.filter(call => call.body.message).length, 1);
  assert.deepEqual((await env.outbox.undelivered(connection)).map(delivery => delivery.parts[0]!.text), ["too late"]);
}));

test("A message shows typing while the Agent works, and a typing failure changes nothing", options, async () => isolated(async pool => {
  const { calls, fake } = recorder(() => graphError(400, { code: 100 }));
  const env = await stack(pool, messenger(fake));
  await env.credentialed("PAGE1");
  await env.connect("PAGE1", "p1");
  await env.deliver({ object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1)] });
  assert.equal(env.target.handled.length, 1);
  await until(() => calls.length > 0);
  assert.deepEqual(calls.map(call => call.body.sender_action), ["typing_on"]);
  assert.deepEqual(env.errors, []);
}));

test("Revoked access fails the delivery for good and degrades the Connection", options, async () => isolated(async pool => {
  const { calls, fake } = recorder(() => graphError(400, { code: 190, message: "Error validating access token" }));
  const env = await stack(pool, messenger(fake));
  await env.credentialed("PAGE1");
  const connection = await env.connect("PAGE1", "p1");
  await env.deliver({ object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1)] });
  const before = calls.length;
  await env.service.reply(env.target.handled[0]!.id, { text: "hi" });
  await env.service.drain();
  await env.service.drain();
  assert.equal(calls.length - before, 1);
  assert.equal((await env.connections.get(connection))?.state, "degraded");
  assert.equal((await pool.query("SELECT state FROM hatch_channel_outbox")).rows[0].state, "failed");
}));

test("A send that timed out is left unknown, never sent twice", options, async () => isolated(async pool => {
  const { calls, fake } = recorder(() => { throw new DOMException("timed out", "TimeoutError"); });
  const env = await stack(pool, messenger(fake));
  await env.credentialed("PAGE1");
  await env.connect("PAGE1", "p1");
  await env.deliver({ object: "page", entry: [messaging("PAGE1", "m1", "PSID1", 1)] });
  const before = calls.length;
  await env.service.reply(env.target.handled[0]!.id, { text: "hi" });
  await env.service.drain();
  await env.service.drain();
  assert.equal(calls.length - before, 1);
  assert.equal((await pool.query("SELECT state FROM hatch_channel_outbox")).rows[0].state, "unknown");
}));

const whatsapp = (fetchImpl?: typeof fetch) => (tokens: Tokens) => new WhatsAppChannel({ ...config, tokens: tokens("whatsapp") }, fetchImpl);
const hi = { object: "whatsapp_business_account", entry: [{ id: "W1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ from: "111", id: "wamid.1", timestamp: "1", type: "text", text: { body: "hi" } }] } }] }] };

test("A Connection is not task-specific until an operator says so, so WhatsApp fails the eligibility check with a real error and never answers it", options, async () => isolated(async pool => {
  const env = await stack(pool, whatsapp(recorder().fake), target => guarded(target, { whatsapp: whatsappEligibility }));
  const connection = await env.connect("W1", "p1");
  assert.equal((await env.connections.get(connection))?.taskSpecific, false);
  await env.deliver(hi);
  assert.equal(env.target.handled.length, 0);
  assert.ok(env.errors.some(error => error instanceof ChannelPolicyError && error.code === "whatsapp_general_purpose_ai"));
}));

test("WhatsApp: a Connection an operator marked task-specific is answered through the number it was written to", options, async () => isolated(async pool => {
  const { calls, fake } = recorder();
  const env = await stack(pool, whatsapp(fake), target => guarded(target, { whatsapp: whatsappEligibility }));
  await env.credentialed("W1");
  await env.connect("W1", "p1", true);
  await env.deliver({ ...hi, entry: [{ id: "W1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN1" }, messages: [{ from_user_id: "US.123", id: "wamid.1", timestamp: "1", type: "text", text: { body: "hi" } }] } }] }] });
  assert.equal(env.target.handled.length, 1);
  await until(() => calls.length > 0);
  assert.equal(calls[0]?.body.typing_indicator.type, "text");
  await env.service.reply(env.target.handled[0]!.id, { text: "hello" });
  await env.service.drain();
  const send = calls.find(call => call.body.text);
  assert.equal(send?.url, "https://graph.facebook.com/v27.0/PN1/messages");
  assert.equal(send?.body.recipient, "US.123");
}));

// ── Tenants on a shared app ──

const slackSecret = "signing-secret";
const slack = (fetchImpl?: typeof fetch) => (tokens: Tokens) => new SlackChannel({ signingSecret: slackSecret, clientId: "cid", clientSecret: "cs", redirectUri: "https://hatch.test/cb", tokens: tokens("slack") }, fetchImpl);
const slackEvent = (event: unknown, id = "Ev1") => ({ type: "event_callback", team_id: "T1", event_id: id, event });
const accept = async (env: Awaited<ReturnType<typeof stack>>, body: unknown) => { await env.service.accept(env.adapter, (await env.adapter.parse!(Buffer.from(JSON.stringify(body)))).events); await env.service.drain(); };

test("Linking a chat on a tenant of a shared app: the code finds the Connection by the tenant the install stored", options, async () => isolated(async pool => {
  const { fake } = recorder(() => new Response(JSON.stringify({ ok: true })));
  const env = await stack(pool, slack(fake));
  const owner = randomUUID();
  // The Expert asks for a code first, then installs the app, which stores the workspace as the Connection's scope.
  const { code, url } = await env.service.connect(owner, "slack");
  assert.match(url!, /state=HATCH-/);
  assert.equal(await env.connections.ownerOfCode("slack", code, env.clock.at), owner);
  assert.equal(await env.connections.ownerOfCode("slack", "HATCH-NOPE0000", env.clock.at), undefined);
  await env.connections.saveCredentials(owner, "slack", seal.seal({ token: "xoxb-1" }), "T1");
  assert.equal(await env.connections.ownerOfCode("slack", code, env.clock.at), owner, "installing does not use the code up");
  await accept(env, slackEvent({ type: "message", channel_type: "im", channel: "D1", user: "U1", text: `link ${code}`, ts: "1.1" }));
  assert.equal((await env.connections.linked(owner)).length, 1);
  assert.equal((await env.connections.resolveConnection({ channel: "slack", scope: "T1", senderId: "U1" }))?.connection.ownerAccountId, owner);
  // Asking for a new code later keeps the workspace the install found.
  await env.service.connect(owner, "slack");
  assert.equal((await env.connections.owned(owner))[0]?.scope, "T1");
}));

test("An uninstall revokes the tenant's Connections at once: nobody stays linked, the token is gone, and a send reports lost access", options, async () => isolated(async pool => {
  const { fake } = recorder(() => new Response(JSON.stringify({ ok: true })));
  const env = await stack(pool, slack(fake));
  const owner = randomUUID();
  const { code } = await env.service.connect(owner, "slack");
  await env.connections.saveCredentials(owner, "slack", seal.seal({ token: "xoxb-1" }), "T1");
  await accept(env, slackEvent({ type: "message", channel_type: "im", channel: "D1", user: "U1", text: code, ts: "1.1" }));
  assert.equal((await env.connections.linked(owner)).length, 1);
  assert.ok(await env.connections.credentialsOf("slack", "T1"));
  await accept(env, slackEvent({ type: "app_uninstalled" }, "Ev2"));
  assert.equal((await env.connections.linked(owner)).length, 0);
  assert.deepEqual(await env.connections.owned(owner), [], "the uninstalled app's Connection is gone");
  assert.equal(await env.connections.credentialsOf("slack", "T1"), undefined);
  assert.equal(await env.connections.resolveConnection({ channel: "slack", scope: "T1", senderId: "U1" }), undefined);
  await assert.rejects(env.adapter.send({ threadId: "T1:D1", senderId: "U1" }, { text: "hi" }, "k"), (error: unknown) => error instanceof ChannelSendError && error.options.access === true);
}));

test("Another tenant is untouched by a revocation", options, async () => isolated(async pool => {
  const env = await stack(pool, slack(recorder().fake));
  const [one, two] = [randomUUID(), randomUUID()];
  await env.connections.saveCredentials(one, "slack", seal.seal({ token: "a" }), "T1");
  await env.connections.saveCredentials(two, "slack", seal.seal({ token: "b" }), "T2");
  await accept(env, slackEvent({ type: "app_uninstalled" }));
  assert.equal(await env.connections.credentialsOf("slack", "T1"), undefined);
  assert.ok(await env.connections.credentialsOf("slack", "T2"));
}));

const DAY = 86_400_000;
const refresher = (env: Awaited<ReturnType<typeof stack>>, now: Date) => new CredentialRefresher({ hub: new ChannelHub([env.adapter], undefined, () => true), connections: env.connections, seal, onError: () => undefined, now: () => now });
const instagram = (fetchImpl?: typeof fetch, now = 0) => (tokens: Tokens) => new InstagramChannel({ ...config, tokens: tokens("instagram"), now: () => now }, fetchImpl);

test("Instagram tokens are renewed before they expire, and keep their tenant", options, async () => isolated(async pool => {
  const { calls, fake } = recorder(() => new Response(JSON.stringify({ access_token: "long-2", token_type: "bearer", expires_in: 5184000 })));
  const env = await stack(pool, instagram(fake));
  const owner = randomUUID();
  await env.connections.saveCredentials(owner, "instagram", seal.seal({ token: "long-1", userId: "IG1", expiresAt: 60 * DAY, refreshedAt: 0 }), "IG1");
  await refresher(env, new Date(10 * DAY)).run();
  assert.equal(calls.length, 0, "not due yet");
  await refresher(env, new Date(50 * DAY)).run();
  assert.equal(calls.length, 1);
  const stored = seal.open<{ token: string; refreshedAt: number }>((await env.connections.credentialsOf("instagram", "IG1"))!);
  assert.deepEqual([stored.token, stored.refreshedAt], ["long-2", 50 * DAY]);
}));

test("An Instagram token that ran out cannot be renewed: its Connection is revoked and the account installs again", options, async () => isolated(async pool => {
  const env = await stack(pool, instagram(recorder().fake));
  const owner = randomUUID();
  await env.connections.saveCredentials(owner, "instagram", seal.seal({ token: "long-1", userId: "IG1", expiresAt: 60 * DAY, refreshedAt: 0 }), "IG1");
  await refresher(env, new Date(61 * DAY)).run();
  assert.deepEqual(await env.connections.owned(owner), [], "a token that no longer works is an unbound Connection, credentials and all");
  assert.equal(await env.connections.credentialsOf("instagram", "IG1"), undefined);
}));
