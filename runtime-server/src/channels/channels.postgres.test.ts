import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { ChannelHub } from "./hub.js";
import { ChannelService, openChannelStores } from "./service.js";
import { ChannelSendError, type ChannelAdapter, type ChannelKind, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";
import type { ChatGateway, Handled, Inbound, TargetHandler } from "./ports.js";
import { ProductTarget } from "./productTarget.js";
import { PostgresConnections } from "./connections.js";
import { PostgresInbox } from "./inbox.js";
import { PostgresRateLimiter } from "./rateLimiter.js";
import { TelegramChannel } from "./telegramChannel.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };
async function isolated<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `hatch_channels_test_${randomUUID().replaceAll("-", "")}`;
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

// ── Doubles. Automated test dependencies: the product never constructs these. ──

class FakeAdapter implements ChannelAdapter {
  readonly sent: Array<{ to: PlatformAddress; message: OutboundMessage; key: string }> = [];
  /** One entry per send, consumed in order: a failure to throw, or undefined to succeed. */
  failures: Array<Error | undefined> = [];
  downloadFailures = 0;
  readonly maxFileBytes = 1_000_000;
  constructor(readonly kind: ChannelKind = "telegram", readonly scope = "", private overrides: Partial<ChannelCapabilities> = {}) {}
  capabilities(): ChannelCapabilities { return { stream: false, edit: false, typing: false, buttons: true, maxLength: 4000, canInitiate: true, idempotentSend: false, ...this.overrides }; }
  available() { return true; }
  async send(to: PlatformAddress, message: OutboundMessage, key: string) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push({ to, message, key });
  }
  async download(_file: InboundFile) { if (this.downloadFailures-- > 0) throw new Error("platform timeout"); return Buffer.from("bytes"); }
  connectUrl(code: string) { return `https://platform.test/start?${code}`; }
  acknowledged: string[] = [];
  async acknowledge(_event: InboundEvent, text?: string) { this.acknowledged.push(text ?? ""); }
  get texts() { return this.sent.map(entry => entry.message.text); }
}

class RecordingTarget implements TargetHandler {
  handled: Inbound[] = [];
  failures = 0;
  result: Handled = { replied: false };
  async handle(inbound: Inbound) { if (this.failures-- > 0) throw new Error("target down"); this.handled.push(inbound); return this.result; }
  async linked() { return "linked"; }
}

class FakeGateway implements ChatGateway {
  submitted: Array<Parameters<ChatGateway["submit"]>[0]> = [];
  results = new Map<string, { ok: boolean; text: string }>();
  private ends = new Set<(runId: string) => void>();
  private compactions = new Set<(event: { runId: string; compactionId: string }) => void>();
  async submit(input: Parameters<ChatGateway["submit"]>[0]) { this.submitted.push(input); return { runId: `run-${this.submitted.length}` }; }
  async upload() { return { assetId: "asset-1" }; }
  async finalReply(runId: string) { return this.results.get(runId); }
  onRunEnd(listener: (runId: string) => void) { this.ends.add(listener); return () => void this.ends.delete(listener); }
  onCompaction(listener: (event: { runId: string; compactionId: string }) => void) { this.compactions.add(listener); return () => void this.compactions.delete(listener); }
  /** `announce: false` is a Run that ended while nobody was listening, such as across a restart. */
  finish(runId: string, result: { ok: boolean; text: string }, announce = true) { this.results.set(runId, result); if (announce) for (const listener of this.ends) listener(runId); }
  compact(runId: string, compactionId: string) { for (const listener of this.compactions) listener({ runId, compactionId }); }
}

const scopeOf = (accountId: string, kind: ChannelKind) => kind === "lark" ? accountId : "";
const address = (sender: string, thread = sender): PlatformAddress => ({ senderId: sender, threadId: thread });
let counter = 0;
const message = (sender: string, text: string, extra: Partial<InboundEvent> = {}): InboundEvent => ({ eventId: `e${++counter}`, address: address(sender), text, messageRef: `m${counter}`, ...extra });

async function stack(pool: Pool, config: { adapters?: FakeAdapter[]; gateway?: ChatGateway; rates?: ConstructorParameters<typeof ChannelService>[0]["rates"] } = {}) {
  const adapters = config.adapters ?? [new FakeAdapter()];
  const stores = await openChannelStores(pool, scopeOf);
  const clock = { at: new Date("2026-11-10T00:00:00Z") };
  const errors: unknown[] = [];
  const service = new ChannelService({ ...stores, hub: new ChannelHub(adapters), scopeOf, now: () => clock.at, onError: error => errors.push(error), rates: config.rates ?? { chat: { capacity: 100, perSecond: 100 }, connection: { capacity: 100, perSecond: 100 } }, ...(config.gateway ? { gateway: config.gateway } : {}) });
  const target = new RecordingTarget();
  service.register("assistant", target);
  /** With the loops running, they may hold a delivery while drain finds nothing: wait until nothing is open. */
  const settle = async () => {
    for (let waited = 0; waited < 50; waited += 1) {
      await service.drain();
      if (!(await pool.query("SELECT 1 FROM hatch_channel_outbox WHERE state IN ('pending', 'sending') AND next_attempt_at <= $1", [clock.at])).rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  return { ...stores, service, settle, adapter: adapters[0]!, target, clock, errors, advance: (ms: number) => { clock.at = new Date(clock.at.getTime() + ms); } };
}

/** Links `sender` as the owner of a new account on the shared platform. */
async function link(env: Awaited<ReturnType<typeof stack>>, sender: string, thread = sender) {
  const owner = randomUUID();
  const { code } = await env.service.connect(owner, "telegram");
  await env.service.accept(env.adapter, [{ eventId: `link-${sender}-${owner}`, address: address(sender, thread), text: code }]);
  await env.service.drain();
  return owner;
}

// ── Connections ──

test("A one-time code links a sender to an account; the sender can move, and revoking ends the link", options, async () => isolated(async pool => {
  const env = await stack(pool);
  const owner = await link(env, "42");
  assert.equal(env.adapter.texts.at(-1), "linked");
  const resolved = await env.connections.resolveConnection({ channel: "telegram", scope: "", senderId: "42" });
  assert.equal(resolved?.connection.ownerAccountId, owner);
  assert.equal(resolved?.connection.audience, "self");

  // A code works once.
  const again = await env.connections.redeem("telegram", "", "HATCH-AAAAAAAA", address("9"));
  assert.equal(again, undefined);
  // The sender moves to another account when they redeem that account's code.
  const other = randomUUID();
  const code = await env.connections.issueCode(other, "telegram");
  assert.ok(await env.connections.redeem("telegram", "", code, address("42")));
  assert.equal((await env.connections.resolveConnection({ channel: "telegram", scope: "", senderId: "42" }))?.connection.ownerAccountId, other);
  assert.equal((await env.connections.linked(owner)).length, 0);
  assert.equal(await env.connections.redeem("telegram", "", code, address("43")), undefined, "the code was used");

  await env.connections.revoke(other, "telegram");
  assert.equal(await env.connections.resolveConnection({ channel: "telegram", scope: "", senderId: "42" }), undefined);
  assert.equal((await env.connections.owned(other))[0]?.state, "revoked");
  // Relinking brings it back.
  const fresh = await env.connections.issueCode(other, "telegram");
  assert.equal((await env.connections.redeem("telegram", "", fresh, address("44")))?.state, "active");
}));

test("An expired code does not link", options, async () => isolated(async pool => {
  const { connections } = await stack(pool);
  const owner = randomUUID();
  const code = await connections.issueCode(owner, "telegram", new Date("2026-11-10T00:00:00Z"));
  assert.equal(await connections.redeem("telegram", "", code, address("1"), new Date("2026-11-10T00:16:00Z")), undefined);
  assert.ok(await connections.redeem("telegram", "", code, address("1"), new Date("2026-11-10T00:14:00Z")));
}));

test("The database refuses a Connection that would give anyone but its owner the Assistant", options, async () => isolated(async pool => {
  await stack(pool);
  const insert = (audience: string, target: object, key: string) => pool.query("INSERT INTO hatch_connections (owner_account_id, channel, target, target_key, audience) VALUES ($1, 'telegram', $2, $3, $4)", [randomUUID(), JSON.stringify(target), key, audience]);
  await assert.rejects(insert("public", { kind: "assistant" }, "assistant"), /check/i);
  await assert.rejects(insert("org", { kind: "assistant" }, "assistant"), /check/i);
  await insert("self", { kind: "assistant" }, "assistant");
  await insert("public", { kind: "product", productId: "p1" }, "product:p1");
}));

test("The legacy channel table moves over once and is not read again", options, async () => isolated(async pool => {
  const owner = randomUUID();
  await pool.query(`CREATE TABLE hatch_assistant_channels (account_id UUID NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', peer_id TEXT, link_code TEXT, link_expires_at TIMESTAMPTZ, credentials TEXT, last_event_at TIMESTAMPTZ, PRIMARY KEY (account_id, kind))`);
  await pool.query("INSERT INTO hatch_assistant_channels (account_id, kind, peer_id, last_event_at) VALUES ($1, 'telegram', '42', now())", [owner]);
  await pool.query("INSERT INTO hatch_assistant_channels (account_id, kind, scope, credentials) VALUES ($1::uuid, 'lark', $1::text, 'sealed-blob')", [owner]);
  const first = await PostgresConnections.open(pool, scopeOf);
  const resolved = await first.resolveConnection({ channel: "telegram", scope: "", senderId: "42" });
  assert.equal(resolved?.connection.ownerAccountId, owner);
  assert.equal(resolved?.identity?.threadId, "42");
  assert.equal(await first.credentials(owner, "lark"), "sealed-blob");
  assert.equal((await pool.query("SELECT to_regclass('hatch_assistant_channels') AS old")).rows[0].old, null);
  await PostgresConnections.open(pool, scopeOf);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_connections")).rows[0].n, 2, "a second open adds nothing");
}));

test("One endpoint, several tenants: each event resolves to its own Connection, and contacts stay in theirs", options, async () => isolated(async pool => {
  const { connections } = await stack(pool);
  const connect = async (scope: string, productId: string) => {
    const id = (await pool.query("INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience) VALUES ($1, 'telegram', $2, $3, $4, 'public') RETURNING id", [randomUUID(), scope, JSON.stringify({ kind: "product", productId }), `product:${productId}`])).rows[0].id;
    return (await connections.get(id))!;
  };
  const pageA = await connect("page-a", "p1");
  const pageB = await connect("page-b", "p2");
  const a = await connections.resolveConnection({ channel: "telegram", scope: "page-a", senderId: "u1" });
  assert.equal(a?.connection.id, pageA.id, "an unknown sender reaches the tenant's own Connection");
  assert.equal(a?.identity, undefined);
  const metA = await connections.meet(pageA, address("u1"));
  const metB = await connections.meet(pageB, address("u1"));
  assert.notEqual(metA.id, metB.id, "the same person is a different contact in each Connection");
  assert.equal((await connections.resolveConnection({ channel: "telegram", scope: "page-b", senderId: "u1" }))?.connection.id, pageB.id);
  assert.equal(await connections.resolveConnection({ channel: "telegram", scope: "page-c", senderId: "u1" }), undefined);
}));

// ── Inbox ──

test("Duplicate deliveries are refused by the database, even concurrently, and replays keep one event", options, async () => isolated(async pool => {
  const inbox = await (async () => { await PostgresConnections.open(pool, scopeOf); return PostgresInbox.open(pool); })();
  const event = message("1", "hello");
  const stored = await Promise.all(Array.from({ length: 8 }, () => inbox.store("telegram", "", [event])));
  assert.equal(stored.flat().length, 1);
  // Out of order: a later event arriving first does not hide an earlier one that follows.
  const [one, two] = [message("1", "one"), message("1", "two")];
  await inbox.store("telegram", "", [two]);
  await inbox.store("telegram", "", [one, two]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 3);
}));

test("An event is leased: a crash returns it, one thread's events go one at a time in order, and retries are bounded", options, async () => isolated(async pool => {
  await PostgresConnections.open(pool, scopeOf);
  const inbox = await PostgresInbox.open(pool);
  const now = new Date("2026-11-10T00:00:00Z");
  const [first, second] = await inbox.store("telegram", "", [message("1", "first"), message("1", "second")]);
  await inbox.store("telegram", "", [message("2", "other thread")]);
  const claimed = await inbox.claim(10, 60_000, now);
  assert.deepEqual(claimed.map(item => item.event.text), ["first", "other thread"], "the second message waits for the first");
  assert.deepEqual(await inbox.claim(10, 60_000, now), [], "leased events are not handed out twice");
  // The process died holding the lease.
  const later = new Date(now.getTime() + 61_000);
  assert.equal((await inbox.claim(10, 60_000, later)).filter(item => item.id === first!.id).length, 1);
  await inbox.complete(first!.id, {});
  assert.equal((await inbox.claim(10, 60_000, later)).filter(item => item.id === second!.id).length, 1, "the next one is released by completion");
  let state = "pending";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await inbox.claim(10, 1, new Date(later.getTime() + attempt * 100_000));
    state = await inbox.retry(second!.id, "boom", 0, 5, new Date(later.getTime() + attempt * 100_000));
  }
  assert.equal(state, "failed");
}));

// ── Outbox and delivery ──

test("Long replies go as several messages in order with buttons last, and nothing is cut", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await link(env, "42");
  const text = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}: ${"word ".repeat(150)}`).join("\n\n");
  await env.service.reply((await pool.query("SELECT id FROM hatch_channel_inbox ORDER BY seq LIMIT 1")).rows[0].id, { text, buttons: [{ label: "OK", taskId: randomUUID(), action: "approve" }] });
  await env.service.drain();
  const parts = env.adapter.sent.slice(1).map(entry => entry.message);
  assert.ok(parts.length > 3);
  assert.ok(parts.every(part => part.text.length <= 4000));
  assert.equal(parts.map(part => part.text).join("\n\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  assert.ok(parts.slice(0, -1).every(part => !part.buttons));
  assert.equal(parts.at(-1)!.buttons?.length, 1);
}));

test("Buttons become typed instructions where a platform has none", options, async () => isolated(async pool => {
  const env = await stack(pool, { adapters: [new FakeAdapter("telegram", "", { buttons: false })] });
  const owner = await link(env, "42");
  await env.service.push(owner, { text: "Publish?", buttons: [{ label: "确认", taskId: randomUUID(), action: "approve" }, { label: "取消", taskId: randomUUID(), action: "decline" }] });
  await env.service.drain();
  const sent = env.adapter.sent.at(-1)!.message;
  assert.equal(sent.buttons, undefined);
  assert.match(sent.text, /回复「确认」或「取消」/);
}));

async function pushOne(env: Awaited<ReturnType<typeof stack>>, text = "hello") {
  const owner = await link(env, "42");
  env.adapter.sent.length = 0;
  await env.service.push(owner, { text });
  return owner;
}

test("A failure that may have reached the platform is never resent unless the send is idempotent", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await pushOne(env);
  env.adapter.failures = [new ChannelSendError("timeout", "ambiguous")];
  await env.service.drain();
  const [row] = (await pool.query("SELECT state FROM hatch_channel_outbox ORDER BY seq DESC LIMIT 1")).rows;
  assert.equal(row.state, "unknown");
  env.advance(10 * 60_000);
  await env.service.drain();
  assert.equal(env.adapter.sent.length, 0, "nothing was sent twice");
}));

test("An idempotent platform gets the same key again after an ambiguous failure", options, async () => isolated(async pool => {
  const adapter = new FakeAdapter("telegram", "", { idempotentSend: true });
  const env = await stack(pool, { adapters: [adapter] });
  await pushOne(env);
  adapter.failures = [new ChannelSendError("timeout", "ambiguous"), new ChannelSendError("timeout", "ambiguous")];
  const keys: string[] = [];
  const send = adapter.send.bind(adapter);
  adapter.send = async (to, message, key) => { keys.push(key); return send(to, message, key); };
  for (let round = 0; round < 3; round += 1) { await env.service.drain(); env.advance(10 * 60_000); }
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1, "one key for the one message");
  assert.equal(adapter.sent.length, 1);
  assert.equal((await pool.query("SELECT state FROM hatch_channel_outbox ORDER BY seq DESC LIMIT 1")).rows[0].state, "sent");
}));

test("A refused send is retried a bounded number of times, then failed", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await pushOne(env);
  env.adapter.failures = Array.from({ length: 20 }, () => new ChannelSendError("rate limited", "definite"));
  for (let round = 0; round < 10; round += 1) { await env.service.drain(); env.advance(10 * 60_000); }
  const row = (await pool.query("SELECT state, attempts FROM hatch_channel_outbox ORDER BY seq DESC LIMIT 1")).rows[0];
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 5);
}));

test("Lost access marks the Connection degraded; a later send that works restores it", options, async () => isolated(async pool => {
  const env = await stack(pool);
  const owner = await pushOne(env);
  env.adapter.failures = [new ChannelSendError("forbidden", "permanent", { access: true })];
  await env.service.drain();
  assert.equal((await env.connections.owned(owner))[0]?.state, "degraded");
  assert.equal((await pool.query("SELECT state FROM hatch_channel_outbox ORDER BY seq DESC LIMIT 1")).rows[0].state, "failed");
  await env.service.push(owner, { text: "again" });
  await env.service.drain();
  assert.equal((await env.connections.owned(owner))[0]?.state, "active");
}));

test("After a partial failure only the unsent parts are sent", options, async () => isolated(async pool => {
  const env = await stack(pool, { adapters: [new FakeAdapter("telegram", "", { maxLength: 100 })] });
  const owner = await link(env, "42");
  env.adapter.sent.length = 0;
  await env.service.push(owner, { text: `${"a".repeat(90)}\n\n${"b".repeat(90)}\n\n${"c".repeat(90)}` });
  env.adapter.failures = [undefined, new ChannelSendError("busy", "definite")];
  await env.service.drain();
  assert.equal(env.adapter.sent.length, 1);
  env.advance(60_000);
  await env.service.drain();
  assert.deepEqual(env.adapter.texts.map(text => text[0]), ["a", "b", "c"], "each part exactly once, in order");
}));

test("A lease that ran out mid-send is unknown on a platform without idempotency, and resent with its key on one with", options, async () => isolated(async pool => {
  for (const idempotentSend of [false, true]) {
    const env = await stack(pool, { adapters: [new FakeAdapter("telegram", "", { idempotentSend })] });
    await pushOne(env);
    const [delivery] = await env.outbox.claim(10, 1_000, env.clock.at);
    await env.outbox.begin(delivery!.id);
    env.advance(5_000);
    await env.service.drain();
    const state = (await env.outbox.get(delivery!.id))!.state;
    assert.equal(state, idempotentSend ? "sent" : "unknown");
    assert.equal(env.adapter.sent.length, idempotentSend ? 1 : 0);
    await pool.query("DELETE FROM hatch_channel_outbox");
  }
}));

test("Outside the reply window a reply stays in Hatch as undelivered, and is never sent", options, async () => isolated(async pool => {
  const adapter = new FakeAdapter("telegram", "", { replyWindowMs: 60_000, canInitiate: false });
  const env = await stack(pool, { adapters: [adapter] });
  const owner = await link(env, "42");
  adapter.sent.length = 0;
  await env.service.push(owner, { text: "inside" });
  await env.service.drain();
  assert.deepEqual(adapter.texts, ["inside"]);
  assert.equal(await env.service.canReach(owner), true);
  env.advance(61_000);
  assert.equal(await env.service.canReach(owner), false, "checked before a reply is generated");
  await env.service.push(owner, { text: "too late" });
  await env.service.drain();
  assert.deepEqual(adapter.texts, ["inside"]);
  const connection = (await env.connections.linked(owner))[0]!.connection;
  assert.deepEqual((await env.outbox.undelivered(connection.id)).map(delivery => delivery.parts[0]!.text), ["too late"]);
  // The window may also close while a delivery waits.
  await env.service.accept(adapter, [message("42", "I'm back")]);
  await env.service.drain();
  await env.service.push(owner, { text: "queued" });
  env.advance(61_000);
  await env.service.drain();
  assert.deepEqual(adapter.texts, ["inside"]);
  assert.equal((await env.outbox.undelivered(connection.id)).length, 2);
}));

test("The rate limit is shared and defers instead of failing", options, async () => isolated(async pool => {
  const env = await stack(pool, { rates: { chat: { capacity: 2, perSecond: 1 }, connection: { capacity: 100, perSecond: 100 } } });
  const owner = await link(env, "42");
  env.adapter.sent.length = 0;
  for (const text of ["1", "2", "3"]) await env.service.push(owner, { text });
  await env.service.drain();
  assert.equal(env.adapter.texts.length, 1, "the link notice already used one token, so only one more fits");
  env.advance(5_000);
  await env.service.drain();
  assert.deepEqual(env.adapter.texts, ["1", "2", "3"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_outbox WHERE state = 'failed'")).rows[0].n, 0);
  // Two processes, one bucket.
  const limiterA = await PostgresRateLimiter.open(pool);
  const limiterB = await PostgresRateLimiter.open(pool);
  const rate = { capacity: 2, perSecond: 1 };
  const now = new Date("2026-11-10T01:00:00Z");
  const taken = await Promise.all([limiterA, limiterB, limiterA, limiterB].map(limiter => limiter.take("shared", rate, now)));
  assert.equal(taken.filter(wait => wait === 0).length, 2);
}));

test("A thread's deliveries go out in order: a later one waits for an earlier one that is being retried", options, async () => isolated(async pool => {
  const env = await stack(pool);
  const owner = await link(env, "42");
  env.adapter.sent.length = 0;
  await env.service.push(owner, { text: "first" });
  await env.service.push(owner, { text: "second" });
  env.adapter.failures = [new ChannelSendError("busy", "definite")];
  await env.service.drain();
  assert.deepEqual(env.adapter.texts, [], "second did not overtake first");
  env.advance(60_000);
  await env.service.drain();
  assert.deepEqual(env.adapter.texts, ["first", "second"]);
}));

// ── Routing ──

test("An event the platform delivers twice is handled once", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await link(env, "42");
  const event = message("42", "hello");
  await Promise.all([env.service.accept(env.adapter, [event]), env.service.accept(env.adapter, [event])]);
  await env.service.accept(env.adapter, [event]);
  await env.service.drain();
  assert.equal(env.target.handled.length, 1);
  assert.equal(env.target.handled[0]!.principal.kind, "account");
}));

test("A crash while handling returns the event, and a file download is repeated, not lost", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await link(env, "42");
  const file = message("42", "", { text: undefined, file: { ref: "f1", name: "notes.md" } });
  env.target.failures = 1;
  await env.service.accept(env.adapter, [file]);
  await env.service.drain();
  assert.equal(env.target.handled.length, 0);
  assert.equal(env.errors.length, 1);
  env.advance(30_000);
  await env.service.drain();
  assert.equal(env.target.handled.length, 1, "handled after the retry");
  assert.equal(env.target.handled[0]!.event.file?.ref, "f1");
  assert.equal((await pool.query("SELECT state FROM hatch_channel_inbox ORDER BY seq DESC LIMIT 1")).rows[0].state, "done");
}));

test("Groups: permission follows the sender, not the thread", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await link(env, "expert");
  const inGroup = (sender: string, extra: Partial<InboundEvent> = {}) => message(sender, "do it", { address: address(sender, "group-1"), group: true, ...extra });
  env.adapter.sent.length = 0;
  await env.service.accept(env.adapter, [inGroup("expert"), inGroup("stranger"), inGroup("stranger", { text: undefined, button: { taskId: randomUUID(), action: "approve" } })]);
  await env.service.drain();
  assert.deepEqual(env.target.handled.map(inbound => inbound.event.address), [address("expert", "group-1")]);
  assert.equal(env.target.handled[0]!.address.threadId, "group-1");
  assert.notEqual(env.target.handled[0]!.address.threadId, env.target.handled[0]!.address.senderId);
  assert.deepEqual(env.adapter.texts, [], "a stranger in a group gets silence");
  // In a private chat, a stranger is told how to connect, and still reaches nothing.
  await env.service.accept(env.adapter, [message("stranger", "hi")]);
  await env.service.drain();
  assert.match(env.adapter.texts.at(-1)!, /请先从 Hatch Studio 连接/);
  assert.equal(env.target.handled.length, 1);
}));

test("A link code posted in a group does not link", options, async () => isolated(async pool => {
  const env = await stack(pool);
  const owner = randomUUID();
  const { code } = await env.service.connect(owner, "telegram");
  await env.service.accept(env.adapter, [message("42", code, { address: address("42", "group-1"), group: true })]);
  await env.service.drain();
  assert.equal((await env.connections.linked(owner)).length, 0);
}));

test("A public contact has a contact principal and never reaches Studio tools", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const adapter = new FakeAdapter("telegram", "page-1");
  const env = await stack(pool, { adapters: [adapter], gateway });
  const product = new ProductTarget({ gateway, limiter: env.limiter, contactRate: { capacity: 2, perSecond: 0.001 } });
  env.service.register("product", product);
  const connectionId = (await pool.query("INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience) VALUES ($1, 'telegram', 'page-1', $2, 'product:p1', 'public') RETURNING id", [randomUUID(), JSON.stringify({ kind: "product", productId: "p1" })])).rows[0].id;
  env.service.start();
  try {
    await env.service.accept(adapter, [message("stranger", "How much?"), message("stranger", "And shipping?"), message("stranger", "Hello?")]);
    await env.settle();
    assert.equal(env.target.handled.length, 0, "the Assistant is never reached");
    assert.equal(gateway.submitted.length, 2, "the third was limited before a Run");
    const [first] = gateway.submitted;
    assert.equal(first!.principal.kind, "contact");
    assert.equal(first!.principal.kind === "contact" && first!.principal.connectionId, connectionId);
    assert.equal(first!.client, "im");
    assert.equal(first!.productId, "p1");
    assert.deepEqual(first!.parts, [{ type: "text", text: "How much?" }]);
    assert.match(adapter.texts.at(-1)!, /Too many messages/);
  } finally { await env.service.close(); }
}));

test("A Run's final reply is sent once, however it is announced, and a failed Run says so", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  const owner = randomUUID();
  await pool.query("INSERT INTO hatch_connections (owner_account_id, channel, target, target_key, audience) VALUES ($1, 'telegram', $2, 'product:p1', 'org')", [owner, JSON.stringify({ kind: "product", productId: "p1" })]);
  const connectionId = (await pool.query("SELECT id FROM hatch_connections")).rows[0].id;
  await pool.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, 'telegram', '', 'member', 'member')", [connectionId]);
  env.service.start();
  try {
    const first = message("member", "question");
    await env.service.accept(env.adapter, [first, first]);
    await env.settle();
    assert.equal(gateway.submitted.length, 1);
    assert.equal(gateway.submitted[0]!.clientKey, first.eventId, "the event id is the idempotency key");
    assert.equal(gateway.submitted[0]!.principal.kind, "contact", "org members act as contacts, never as accounts");
    assert.deepEqual(env.adapter.texts, [], "no reply while the Run is going");
    gateway.finish("run-1", { ok: true, text: "the answer" });
    gateway.finish("run-1", { ok: true, text: "the answer" });
    await env.settle();
    await env.settle();
    assert.deepEqual(env.adapter.texts, ["the answer"]);
    assert.equal(env.adapter.sent[0]!.message.replyTo, first.messageRef);
    // A Run that ended while nobody listened is found by the sweep. A failed one is reported plainly.
    await env.service.accept(env.adapter, [message("member", "again")]);
    await env.settle();
    gateway.finish("run-2", { ok: false, text: "internal stack trace" }, false);
    await env.settle();
    assert.match(env.adapter.texts.at(-1)!, /Something went wrong/);
    assert.ok(!env.adapter.texts.join("").includes("stack trace"));
    assert.equal(env.adapter.texts.length, 2);
  } finally { await env.service.close(); }
}));

test("Compaction: one notice per compaction, only where someone is waiting, and it is not part of the conversation", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  const connectionId = (await pool.query("INSERT INTO hatch_connections (owner_account_id, channel, target, target_key, audience) VALUES ($1, 'telegram', $2, 'product:p1', 'org') RETURNING id", [randomUUID(), JSON.stringify({ kind: "product", productId: "p1" })])).rows[0].id;
  await pool.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, 'telegram', '', 'member', 'member')", [connectionId]);
  env.service.start();
  try {
    await env.service.accept(env.adapter, [message("member", "long question")]);
    await env.settle();
    gateway.compact("run-1", "c1");
    gateway.compact("run-1", "c1");
    await new Promise(resolve => setTimeout(resolve, 100));
    await env.settle();
    assert.equal(env.adapter.texts.length, 1, "twice announced, once told");
    gateway.compact("run-1", "c2");
    await new Promise(resolve => setTimeout(resolve, 100));
    await env.settle();
    assert.equal(env.adapter.texts.length, 2, "a second compaction is a second notice");
    assert.equal(gateway.submitted.length, 1, "notices never enter the conversation");
    // The user has their answer: nobody is waiting.
    gateway.finish("run-1", { ok: true, text: "done" });
    await env.settle();
    gateway.compact("run-1", "c3");
    await new Promise(resolve => setTimeout(resolve, 100));
    await env.settle();
    assert.equal(env.adapter.texts.length, 3, "only the answer was added");
    assert.equal(env.adapter.texts.at(-1), "done");
  } finally { await env.service.close(); }
}));

test("Telegram: a mention in a group reaches the Assistant of the sender who linked, and the reply goes to the group", options, async () => isolated(async pool => {
  const sent: Array<Record<string, any>> = [];
  const telegram = new TelegramChannel({ token: "t", username: "hatch_bot", webhookSecret: "s" }, (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as typeof fetch);
  const stores = await openChannelStores(pool, scopeOf);
  const target = new RecordingTarget();
  const service = new ChannelService({ ...stores, hub: new ChannelHub([telegram]), scopeOf, rates: { chat: { capacity: 100, perSecond: 100 }, connection: { capacity: 100, perSecond: 100 } } }).register("assistant", target);
  const owner = randomUUID();
  const { code } = await service.connect(owner, "telegram");
  const update = (id: number, from: number, text: string, chat = from, type = "private") => telegram.parse(Buffer.from(JSON.stringify({ update_id: id, message: { message_id: id, from: { id: from }, chat: { id: chat, type }, text } }))).events;
  await service.accept(telegram, update(1, 42, `/start ${code}`));
  await service.drain();
  await service.accept(telegram, [...update(2, 42, "@hatch_bot publish it", -100, "supergroup"), ...update(3, 42, "chatter", -100, "supergroup"), ...update(4, 99, "@hatch_bot hi", -100, "supergroup")]);
  await service.drain();
  assert.deepEqual(target.handled.map(inbound => [inbound.event.text, inbound.address.threadId, inbound.address.senderId]), [["publish it", "-100", "42"]]);
  const reply = await service.reply(target.handled[0]!.id, { text: "published" });
  assert.equal(reply, true);
  await service.drain();
  const last = sent.at(-1)!;
  assert.equal(last.chat_id, -100);
  assert.equal(last.text, "published");
  assert.equal(last.reply_parameters.message_id, 2);
}));
