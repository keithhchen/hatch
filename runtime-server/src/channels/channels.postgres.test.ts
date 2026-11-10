import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { ChannelCapabilities, ClientAttributes, ContentPart, Principal } from "../surfaces/contract.js";
import { ChannelHub } from "./hub.js";
import { Dispatcher } from "./dispatch.js";
import type { Claim, SignIn } from "./router.js";
import { OwnApps } from "./ownApps.js";
import { CREDENTIAL_FORMS } from "./credentialForms.js";
import { ChannelService, openChannelStores } from "./service.js";
import { ChannelSendError, type ChannelAdapter, type ChannelKind, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";
import type { ChatGateway, Handled, Inbound, TargetHandler } from "./ports.js";
import type { ConversationRef, RunProgress } from "../chat/gateway.js";
import { ProductTarget } from "./productTarget.js";
import { GuardedTarget, liveOwnProduct } from "./guardedTarget.js";
import { ChatError } from "../chat/principal.js";
import { PostgresConnections } from "./connections.js";
import { PostgresInbox } from "./inbox.js";
import { PostgresRateLimiter } from "./rateLimiter.js";
import { TelegramChannel } from "./telegramChannel.js";

/** Test time starts a minute ahead of the real clock: rows the database stamps with now() are already due, never in the clock's future. */
const START = Date.now() + 60_000;
const at = (offsetMs: number) => new Date(START + offsetMs);

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
  roles: string[] = [];
  async handle(inbound: Inbound) { if (this.failures-- > 0) throw new Error("target down"); this.handled.push(inbound); return this.result; }
  async linked(_connection: unknown, role: string) { this.roles.push(role); return "linked"; }
}

/** Stands in for Chat in another process: it answers from state of its own, the way the durable Runtime does, and never calls back. */
class FakeGateway implements ChatGateway {
  submitted: Array<{ principal: Principal; conversation: ConversationRef; client: ClientAttributes; messageId: string; parts: ContentPart[] }> = [];
  uploaded: Array<{ principal: Principal; conversation: ConversationRef; name: string }> = [];
  /** A failure for the next call to `send`: a ChatError is a refusal, anything else is a gateway that could not be reached. */
  failSend: Error | undefined;
  private runs = new Map<string, RunProgress>();
  private byMessage = new Map<string, string>();
  /** The Run that takes the next message as a steer, the way Chat folds a message into a Run that is going. */
  steerInto: string | undefined;
  /** Like Chat, a repeated message id is the same message and Run. */
  async send(principal: Principal, conversation: ConversationRef, client: ClientAttributes, messageId: string, parts: ContentPart[]) {
    if (this.failSend) { const error = this.failSend; this.failSend = undefined; throw error; }
    const known = this.byMessage.get(messageId);
    if (known) return { outcome: "replayed" as const, conversationId: "conversation-1", runId: known, messageId, acceptedAt: "2026-01-01T00:00:00.000Z" };
    this.submitted.push({ principal, conversation, client, messageId, parts });
    if (this.steerInto) { const runId = this.steerInto; this.steerInto = undefined; this.byMessage.set(messageId, runId); return { outcome: "steered" as const, conversationId: "conversation-1", runId, messageId }; }
    const runId = `run-${this.submitted.length}`;
    this.byMessage.set(messageId, runId);
    this.runs.set(runId, { ended: false });
    return { outcome: "started" as const, conversationId: "conversation-1", runId, messageId, acceptedAt: "2026-01-01T00:00:00.000Z" };
  }
  async upload(principal: Principal, conversation: ConversationRef, input: { name: string }) { this.uploaded.push({ principal, conversation, name: input.name }); return { assetId: "asset-1", kind: /\.(jpe?g|png)$/i.test(input.name) ? "image" as const : /\.(ogg|m4a|amr)$/i.test(input.name) ? "audio" as const : "file" as const }; }
  async progress(runId: string) { return this.runs.get(runId); }
  finish(runId: string, result: { ok: boolean; text: string }) { this.runs.set(runId, { ended: true, reply: { runId, status: result.ok ? "completed" : "failed", text: result.ok ? result.text : "" } }); }
  compact(runId: string, compactionId: string) { if (!this.runs.get(runId)?.ended) this.runs.set(runId, { ended: false, compactionId }); }
}

const scopeOf = (accountId: string, kind: ChannelKind) => kind === "lark" ? accountId : "";
const address = (sender: string, thread = sender): PlatformAddress => ({ senderId: sender, threadId: thread });
let counter = 0;
const message = (sender: string, text: string, extra: Partial<InboundEvent> = {}): InboundEvent => ({ eventId: `e${++counter}`, address: address(sender), text, messageRef: `m${counter}`, ...extra });

async function stack(pool: Pool, config: { adapters?: FakeAdapter[]; gateway?: ChatGateway; rates?: ConstructorParameters<typeof ChannelService>[0]["rates"]; signIn?: SignIn; claim?: Claim; own?: ConstructorParameters<typeof ChannelHub>[1] } = {}) {
  const adapters = config.adapters ?? [new FakeAdapter()];
  const stores = await openChannelStores(pool, scopeOf);
  const clock = { at: at(0) };
  const errors: unknown[] = [];
  const service = new ChannelService({ ...stores, hub: new ChannelHub(adapters, config.own), scopeOf, now: () => clock.at, ...(config.signIn ? { signIn: config.signIn } : {}), ...(config.claim ? { claim: config.claim } : {}), onError: error => errors.push(error), rates: config.rates ?? { chat: { capacity: 100, perSecond: 100 }, connection: { capacity: 100, perSecond: 100 } }, ...(config.gateway ? { gateway: config.gateway } : {}) });
  const target = new RecordingTarget();
  service.register("assistant", target);
  /** With the loops running, they may hold an event or a delivery while drain finds nothing: wait until nothing is open. */
  const settle = async () => {
    for (let waited = 0; waited < 50; waited += 1) {
      await service.drain();
      const open = await pool.query(`SELECT 1 FROM hatch_channel_outbox WHERE state IN ('pending', 'sending') AND next_attempt_at <= $1
        UNION ALL SELECT 1 FROM hatch_channel_inbox WHERE state = 'pending' AND last_error IS NULL`, [clock.at]);
      if (!open.rowCount) return;
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
  const code = await connections.issueCode(owner, "telegram", undefined, at(0));
  assert.equal(await connections.redeem("telegram", "", code, address("1"), at(16 * 60_000)), undefined);
  assert.ok(await connections.redeem("telegram", "", code, address("1"), at(14 * 60_000)));
}));

test("An account binds its Assistant and each Product separately: each chat reaches its own, as the account, and unbinding one leaves the rest", options, async () => isolated(async pool => {
  const { connections } = await stack(pool);
  const owner = randomUUID(); const stranger = randomUUID();
  const product = (productId: string) => ({ kind: "product" as const, productId });
  assert.ok(await connections.redeem("telegram", "", await connections.issueCode(owner, "telegram"), address("1")));
  assert.ok(await connections.redeem("telegram", "", await connections.issueCode(owner, "telegram", product("pa")), address("2")));
  assert.ok(await connections.redeem("telegram", "", await connections.issueCode(owner, "telegram", product("pb")), address("3")));
  assert.ok(await connections.redeem("telegram", "", await connections.issueCode(stranger, "telegram", product("pa")), address("4")));
  const reach = async (sender: string) => (await connections.resolveConnection({ channel: "telegram", scope: "", senderId: sender }))?.connection;
  assert.deepEqual([(await reach("1"))?.target, (await reach("2"))?.target, (await reach("3"))?.target], [{ kind: "assistant" }, product("pa"), product("pb")]);
  assert.equal((await reach("4"))?.ownerAccountId, stranger, "another account's binding to a Product of the same id is its own");
  assert.equal((await reach("2"))?.audience, "self");
  assert.deepEqual((await connections.linked(owner)).map(entry => entry.identity?.senderId), ["1"], "the Assistant reaches the account only where the Assistant is bound");
  assert.deepEqual((await connections.owned(owner)).map(entry => [entry.target.kind, entry.senderId]).sort(), [["assistant", "1"], ["product", "2"], ["product", "3"]]);

  await connections.revoke(owner, "telegram", product("pa"));
  assert.equal(await reach("2"), undefined);
  assert.ok(await reach("1") && await reach("3") && await reach("4"));
  // A chat holds one binding: binding it again moves it.
  assert.ok(await connections.redeem("telegram", "", await connections.issueCode(owner, "telegram", product("pb")), address("1")));
  assert.deepEqual((await reach("1"))?.target, product("pb"));
  assert.equal(await reach("3"), undefined, "a Product's binding has one chat: the new one replaces the old");
  assert.equal((await connections.linked(owner)).length, 0);
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

const openInbox = async (pool: Pool) => { await PostgresConnections.open(pool, scopeOf); return PostgresInbox.open(pool); };

test("A pull's events and cursor commit together: a failing event leaves the cursor and the earlier events where they were", options, async () => isolated(async pool => {
  const inbox = await openInbox(pool);
  await inbox.store("wechatkf", "acct", [message("1", "a")], undefined, { key: "kf1", cursor: "c1" });
  // An event with no thread violates NOT NULL after the first insert of the same call succeeded.
  const broken = { ...message("1", "c"), address: {} } as unknown as InboundEvent;
  await assert.rejects(inbox.store("wechatkf", "acct", [message("1", "b"), broken], undefined, { key: "kf1", cursor: "c2" }));
  assert.equal(await inbox.cursor("wechatkf", "acct", "kf1"), "c1");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 1);
  // The failed call did not leave the pooled connection inside a transaction.
  await inbox.store("wechatkf", "acct", [message("1", "b")], undefined, { key: "kf1", cursor: "c2" });
  assert.equal(await inbox.cursor("wechatkf", "acct", "kf1"), "c2");
}));

test("A cursor belongs to its channel, scope and key, and survives a new inbox over the same database", options, async () => isolated(async pool => {
  const inbox = await openInbox(pool);
  assert.equal(await inbox.cursor("wechatkf", "acct", "kf1"), undefined);
  await inbox.store("wechatkf", "acct", [], undefined, { key: "kf1", cursor: "c1" });
  const restarted = await PostgresInbox.open(pool);
  assert.equal(await restarted.cursor("wechatkf", "acct", "kf1"), "c1");
  for (const [channel, scope, key] of [["wechatkf", "acct", "kf2"], ["wechatkf", "other", "kf1"], ["wecom", "acct", "kf1"]] as const) assert.equal(await restarted.cursor(channel, scope, key), undefined);
}));

test("Storing a pull twice keeps one event each and the cursor is what was last written", options, async () => isolated(async pool => {
  const inbox = await openInbox(pool);
  const events = [message("1", "a"), message("1", "b")];
  assert.equal((await inbox.store("wechatkf", "acct", events, undefined, { key: "kf1", cursor: "c2" })).length, 2);
  assert.equal((await inbox.store("wechatkf", "acct", events, undefined, { key: "kf1", cursor: "c2" })).length, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 2);
  await inbox.store("wechatkf", "acct", events, undefined, { key: "kf1", cursor: "c1" });
  assert.equal(await inbox.cursor("wechatkf", "acct", "kf1"), "c1");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_cursors")).rows[0].n, 1);
}));

test("ChannelService.pull stores the pulled events with the cursor, and a failed pull changes nothing", options, async () => isolated(async pool => {
  const adapter = Object.assign(new FakeAdapter("wechatkf", "acct"), {
    seen: [] as Array<string | undefined>, failing: false, next: [message("1", "a")], cursor: "c1",
    async pull(this: any, notice: { key: string }, cursor: string | undefined) {
      this.seen.push(`${notice.key}:${cursor}`);
      if (this.failing) throw new Error("wecom down");
      return { events: this.next, cursor: this.cursor };
    },
  });
  const env = await stack(pool, { adapters: [adapter] });
  await env.service.pull(adapter, { key: "kf1", hint: "t" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 1);
  adapter.failing = true; adapter.next = [message("1", "b")]; adapter.cursor = "c2";
  await assert.rejects(env.service.pull(adapter, { key: "kf1" }), /wecom down/);
  assert.equal(await env.inbox.cursor("wechatkf", "acct", "kf1"), "c1");
  adapter.failing = false;
  await env.service.pull(adapter, { key: "kf1" });
  assert.equal(await env.inbox.cursor("wechatkf", "acct", "kf1"), "c2");
  assert.deepEqual(adapter.seen, ["kf1:undefined", "kf1:c1", "kf1:c1"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 2);
}));

test("An event is leased: a crash returns it, one thread's events go one at a time in order, and retries are bounded", options, async () => isolated(async pool => {
  await PostgresConnections.open(pool, scopeOf);
  const inbox = await PostgresInbox.open(pool);
  const now = at(0);
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
  const now = at(3_600_000);
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

test("An expired lease is reclaimed, and extending it keeps a live claimant's event", options, async () => isolated(async pool => {
  await PostgresConnections.open(pool, scopeOf);
  const inbox = await PostgresInbox.open(pool);
  const now = at(0);
  await inbox.store("telegram", "", [message("1", "first")]);
  const [item] = await inbox.claim(10, 30_000, now);
  await inbox.extend(item!.id, 30_000, new Date(now.getTime() + 20_000));
  assert.deepEqual(await inbox.claim(10, 30_000, new Date(now.getTime() + 40_000)), [], "a heartbeat keeps the claim");
  assert.equal((await inbox.claim(10, 30_000, new Date(now.getTime() + 51_000))).length, 1, "a silent claimant loses it after one lease");
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
    assert.deepEqual(first!.client, { client: "im" });
    assert.deepEqual(first!.conversation, { kind: "thread", connectionId, threadId: "stranger" });
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
    assert.equal(gateway.submitted[0]!.messageId, first.eventId, "the event id is the idempotency key");
    assert.equal(gateway.submitted[0]!.principal.kind, "contact", "org members act as contacts, never as accounts");
    assert.deepEqual(env.adapter.texts, [], "no reply while the Run is going");
    gateway.finish("run-1", { ok: true, text: "the answer" });
    gateway.finish("run-1", { ok: true, text: "the answer" });
    await env.settle();
    await env.settle();
    assert.deepEqual(env.adapter.texts, ["the answer"]);
    assert.equal(env.adapter.sent[0]!.message.replyTo, first.messageRef);
    // A Run's end is read from Chat's durable state, so it is found whenever it happened. A failed one is reported plainly.
    await env.service.accept(env.adapter, [message("member", "again")]);
    await env.settle();
    gateway.finish("run-2", { ok: false, text: "internal stack trace" });
    await env.settle();
    assert.match(env.adapter.texts.at(-1)!, /Something went wrong/);
    assert.ok(!env.adapter.texts.join("").includes("stack trace"));
    assert.equal(env.adapter.texts.length, 2);
  } finally { await env.service.close(); }
}));

/** A product Connection whose members are all in the thread or threads given: [sender, thread]. */
async function productConnection(pool: Pool, members: Array<[string, string]>) {
  await pool.query("INSERT INTO hatch_connections (owner_account_id, channel, target, target_key, audience) VALUES ($1, 'telegram', $2, 'product:p1', 'org')", [randomUUID(), JSON.stringify({ kind: "product", productId: "p1" })]);
  const connectionId = (await pool.query("SELECT id FROM hatch_connections")).rows[0].id;
  for (const [sender, thread] of members) await pool.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, 'telegram', '', $2, $3)", [connectionId, sender, thread]);
}

test("In a group, a reply goes to the message its Run answered: the other member's Run ending later is still answered", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  await productConnection(pool, [["b", "group"], ["a", "group"]]);
  const [fromB, fromA] = [message("b", "from b", { address: address("b", "group") }), message("a", "from a", { address: address("a", "group") })];
  await env.service.accept(env.adapter, [fromB]);
  await env.settle();
  await env.service.accept(env.adapter, [fromA]);
  await env.settle();
  gateway.finish("run-2", { ok: true, text: "answer to a" });
  await env.settle();
  gateway.finish("run-1", { ok: true, text: "answer to b" });
  await env.settle();
  assert.deepEqual(env.adapter.sent.map(sent => [sent.message.text, sent.message.replyTo]), [["answer to a", fromA.messageRef], ["answer to b", fromB.messageRef]]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox WHERE replied_at IS NULL")).rows[0].n, 0);
}));

test("A Run that two threads steered replies once in each thread, and nothing is marked replied that was not", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  await productConnection(pool, [["one", "one"], ["two", "two"]]);
  await env.service.accept(env.adapter, [message("one", "first")]);
  await env.settle();
  gateway.steerInto = "run-1";
  await env.service.accept(env.adapter, [message("two", "second")]);
  await env.settle();
  gateway.finish("run-1", { ok: true, text: "answer" });
  await env.settle();
  await env.settle();
  assert.deepEqual(env.adapter.sent.map(sent => [sent.to.threadId, sent.message.text]).sort(), [["one", "answer"], ["two", "answer"]]);
  assert.deepEqual(await env.inbox.openRuns(20), []);
}));

test("A removed bot's leftover delivery is failed with a reason, never sent through the shared bot; its inbound is refused", options, async () => isolated(async pool => {
  const shared = new FakeAdapter();
  const bot = new FakeAdapter("telegram", "bot-1");
  let alive = true;
  const env = await stack(pool, { adapters: [shared], own: async (_kind, scope) => alive && scope === "bot-1" ? bot : undefined });
  const logged: string[] = [];
  const dispatcher = new Dispatcher({ outbox: env.outbox, hub: env.service.hub, limiter: env.limiter, connections: env.connections, inbox: env.inbox, now: () => env.clock.at, onError: error => logged.push(String(error)) });
  await dispatcher.send({ channel: "telegram", scope: "bot-1", address: address("walker"), kind: "notice", message: { text: "leftover" } });
  alive = false;
  assert.equal(await dispatcher.step(), 1);
  const row = (await pool.query("SELECT state, last_error FROM hatch_channel_outbox")).rows[0];
  assert.equal(row.state, "failed");
  assert.match(row.last_error, /bot-1/);
  assert.equal(logged.length, 1);
  assert.deepEqual([shared.sent, bot.sent], [[], []]);
  // Inbound for the same scope is refused: stored, never routed, and nothing is said through the shared bot.
  await env.inbox.store("telegram", "bot-1", [message("walker", "hello?")]);
  await env.service.drain();
  assert.deepEqual(shared.sent, []);
  assert.equal(env.target.handled.length, 0);
  assert.equal((await pool.query("SELECT state FROM hatch_channel_inbox")).rows[0].state, "done");
  assert.equal(env.errors.length, 1);
}));

test("An event that is finally given up on is told to its sender in plain words, and logged", options, async () => isolated(async pool => {
  const env = await stack(pool);
  await link(env, "42");
  env.target.failures = 10;
  await env.service.accept(env.adapter, [message("42", "hello")]);
  for (let round = 0; round < 6; round += 1) { env.advance(120_000); await env.settle(); }
  assert.equal(env.target.handled.length, 0);
  assert.equal((await pool.query("SELECT state FROM hatch_channel_inbox ORDER BY seq DESC LIMIT 1")).rows[0].state, "failed");
  assert.equal(env.adapter.texts.filter(text => /Something went wrong/.test(text)).length, 1, "told once");
  assert.ok(!env.adapter.texts.join("").includes("target down"), "no provider text reaches the sender");
  assert.ok(env.errors.some(error => /giving up/i.test(String(error instanceof Error ? error.message : error))), "the final failure is an error of its own");
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
    await env.settle();
    await env.settle();
    assert.equal(env.adapter.texts.length, 1, "seen twice, told once");
    gateway.compact("run-1", "c2");
    await env.settle();
    assert.equal(env.adapter.texts.length, 2, "a second compaction is a second notice");
    assert.equal(gateway.submitted.length, 1, "notices never enter the conversation");
    // The user has their answer: nobody is waiting.
    gateway.finish("run-1", { ok: true, text: "done" });
    await env.settle();
    gateway.compact("run-1", "c3");
    await env.settle();
    assert.equal(env.adapter.texts.length, 3, "only the answer was added");
    assert.equal(env.adapter.texts.at(-1), "done");
  } finally { await env.service.close(); }
}));

/** A Connection of audience `org` to product p1, with `member` admitted. */
async function orgMember(pool: Pool, owner = randomUUID()) {
  const connectionId = (await pool.query("INSERT INTO hatch_connections (owner_account_id, channel, target, target_key, audience) VALUES ($1, 'telegram', $2, 'product:p1', 'org') RETURNING id", [owner, JSON.stringify({ kind: "product", productId: "p1" })])).rows[0].id;
  await pool.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, 'telegram', '', 'member', 'member')", [connectionId]);
  return { owner, connectionId: connectionId as string };
}

test("A file a contact sends is uploaded into the conversation's scope and sent as a part of the same message", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  const { connectionId } = await orgMember(pool);
  env.service.start();
  try {
    await env.service.accept(env.adapter, [message("member", "see this", { file: { ref: "f1", name: "plan.pdf", size: 5 } }), message("member", "", { file: { ref: "f2", name: "face.jpg", size: 5 } })]);
    await env.settle();
    assert.deepEqual(gateway.uploaded.map(upload => [upload.name, upload.conversation]), [["plan.pdf", { kind: "thread", connectionId, threadId: "member" }], ["face.jpg", { kind: "thread", connectionId, threadId: "member" }]]);
    assert.deepEqual(gateway.submitted.map(sent => sent.parts), [[{ type: "text", text: "see this" }, { type: "file", assetId: "asset-1" }], [{ type: "image", assetId: "asset-1" }]]);
  } finally { await env.service.close(); }
}));

test("A refusal from Chat goes back to the sender; an unreachable Chat returns the event to the queue, and the retry is the same message", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  await orgMember(pool);
  env.service.start();
  try {
    gateway.failSend = new ChatError("contact_limit_reached", "This contact has reached the message limit.", 429);
    await env.service.accept(env.adapter, [message("member", "one")]);
    await env.settle();
    assert.deepEqual(env.adapter.texts, ["This contact has reached the message limit."]);
    assert.equal(gateway.submitted.length, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox WHERE state = 'failed'")).rows[0].n, 0, "a refusal is an answer, not a failure to retry");
    gateway.failSend = new Error("connect ECONNREFUSED");
    const event = message("member", "two");
    await env.service.accept(env.adapter, [event]);
    // The loops may hold the event: wait for the failed attempt itself.
    for (let waited = 0; waited < 100 && !env.errors.length; waited += 1) { await env.service.drain(); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(gateway.submitted.length, 0, "Chat was unreachable");
    assert.equal(env.errors.length, 1);
    env.advance(10_000);
    await env.settle();
    assert.deepEqual(gateway.submitted.map(sent => sent.messageId), [event.eventId], "tried again with the same key");
  } finally { await env.service.close(); }
}));

test("Eligibility is checked before Chat: a Product that is not live and the owner's own gets a notice and no Run", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const env = await stack(pool, { gateway });
  const owner = randomUUID();
  const live = new Map<string, { creator_id: string }>();
  env.service.register("product", new GuardedTarget(new ProductTarget({ gateway, limiter: env.limiter }), [liveOwnProduct({ getLive: async productId => live.get(productId) })]));
  await orgMember(pool, owner);
  env.service.start();
  try {
    await env.service.accept(env.adapter, [message("member", "anyone there?")]);
    await env.settle();
    assert.match(env.adapter.texts.at(-1)!, /not available right now/);
    live.set("p1", { creator_id: randomUUID() });
    await env.service.accept(env.adapter, [message("member", "still?")]);
    await env.settle();
    assert.equal(env.adapter.texts.length, 2, "another Expert's Product is not lent to this audience");
    live.set("p1", { creator_id: owner });
    await env.service.accept(env.adapter, [message("member", "now?")]);
    await env.settle();
    assert.equal(gateway.submitted.length, 1);
  } finally { await env.service.close(); }
}));

test("A Registry restart loses neither a reply nor a compaction notice: both are read from Chat's durable state", options, async () => isolated(async pool => {
  const gateway = new FakeGateway();
  const first = await stack(pool, { gateway });
  first.service.register("product", new ProductTarget({ gateway, limiter: first.limiter }));
  await orgMember(pool);
  first.service.start();
  await first.service.accept(first.adapter, [message("member", "long question")]);
  await first.settle();
  await first.service.close();
  // The old process is gone while the Run goes on in Chat.
  gateway.compact("run-1", "run-1:7");
  const second = await stack(pool, { gateway });
  second.service.register("product", new ProductTarget({ gateway, limiter: second.limiter }));
  second.service.start();
  try {
    await second.settle();
    assert.equal(second.adapter.texts.length, 1, "told once that we are tidying up");
    gateway.finish("run-1", { ok: true, text: "the answer" });
    await second.settle();
    await second.settle();
    assert.deepEqual(second.adapter.texts.slice(1), ["the answer"]);
  } finally { await second.service.close(); }
}));

test("Telegram: a mention in a group reaches the Assistant of the sender who linked, and the reply goes to the group", options, async () => isolated(async pool => {
  const sent: Array<Record<string, any>> = [];
  const telegram = new TelegramChannel({ token: "t", username: "hatch_bot", webhookSecret: "s" }, "", (async (_url: string, init?: RequestInit) => {
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

test("A reply allowance: what the platform lets us send after each of its messages goes, the rest stays in Hatch as undelivered, and a new inbound message restores it", options, async () => isolated(async pool => {
  const adapter = new FakeAdapter("telegram", "", { replyAllowance: 2, maxLength: 10 });
  const env = await stack(pool, { adapters: [adapter] });
  const owner = await link(env, "42");
  const connection = (await env.connections.linked(owner))[0]!.connection;
  adapter.sent.length = 0;
  env.advance(1000);
  await env.service.accept(adapter, [message("42", "hello")]);
  await env.service.drain();
  await env.service.push(owner, { text: "aaaaaaaaaa bbbbbbbbbb cccccccccc" });
  await env.service.drain();
  assert.deepEqual(adapter.texts, ["aaaaaaaaaa", "bbbbbbbbbb"]);
  const [spent] = await env.outbox.undelivered(connection.id);
  assert.deepEqual([spent!.sentParts, spent!.state, spent!.parts.length], [2, "undelivered", 3]);
  assert.equal((await pool.query("SELECT 1 FROM hatch_channel_outbox WHERE state IN ('failed', 'unknown')")).rowCount, 0);
  env.advance(1000);
  await env.service.accept(adapter, [message("42", "again")]);
  await env.service.drain();
  await env.service.push(owner, { text: "fresh" });
  await env.service.drain();
  assert.equal(adapter.texts.at(-1), "fresh");
}));

test("An unreachable event is stored and completed, never routed and never answered", options, async () => isolated(async pool => {
  const env = await stack(pool);
  const owner = await link(env, "42");
  env.adapter.sent.length = 0; env.target.handled.length = 0;
  await env.service.accept(env.adapter, [message("42", "from another tenant", { unreachable: true })]);
  await env.service.drain();
  assert.equal(env.target.handled.length, 0);
  assert.equal(env.adapter.sent.length, 0);
  assert.equal((await pool.query("SELECT 1 FROM hatch_channel_inbox WHERE state = 'done' AND event->>'unreachable' = 'true'")).rowCount, 1);
  assert.ok(owner);
}));

// ── Telegram: our shared bot signs people in and admits guests; each Product has a bot of its own ──

test("A stranger on the shared bot is offered a sign-in link; a group gets silence; nothing is reached", options, async () => isolated(async pool => {
  const asked: Array<[string, string | undefined]> = [];
  const env = await stack(pool, { signIn: async (_kind, sender, invite) => { asked.push([sender, invite]); return `https://site.test/start?claim=${sender}`; } });
  await env.service.accept(env.adapter, [message("stranger", "hello")]);
  await env.service.accept(env.adapter, [message("stranger", "hello", { address: address("stranger", "group-1"), group: true })]);
  await env.service.drain();
  assert.deepEqual(env.adapter.sent.map(entry => entry.message.link?.url), ["https://site.test/start?claim=stranger"]);
  assert.deepEqual(asked, [["stranger", undefined]]);
  assert.equal(env.target.handled.length, 0);
}));

test("A sender asking too often gets the plain refusal instead of another link", options, async () => isolated(async pool => {
  const env = await stack(pool, { signIn: async () => undefined });
  await env.service.accept(env.adapter, [message("stranger", "hello")]);
  await env.service.drain();
  assert.match(env.adapter.texts[0]!, /请先从 Hatch Studio 连接/);
}));

test("An invite admits a guest only through a sign-in; the owner sees the guest and can revoke them", options, async () => isolated(async pool => {
  const env = await stack(pool, { signIn: async (_kind, sender, invite) => `https://site.test/start?claim=${sender}:${invite ?? ""}` });
  const owner = await link(env, "expert");
  const { code, url } = await env.service.invite(owner, "telegram", "Ann [助理]");
  assert.match(url!, /platform\.test/);
  // The code alone admits no one: the sender is sent to sign in, carrying the invite.
  await env.service.accept(env.adapter, [message("ann", code)]);
  await env.service.drain();
  assert.equal(env.adapter.sent.at(-1)!.message.link?.url, `https://site.test/start?claim=ann:${code}`);
  assert.equal((await env.service.view(owner))[0]!.people.length, 0);
  // The sign-in names the sender; only then is the invite spent.
  await env.service.admit("telegram", address("ann"), { invite: code });
  await env.service.drain();
  assert.deepEqual(env.target.roles, ["owner", "guest"]);
  assert.deepEqual((await env.service.view(owner)).find(status => status.kind === "telegram")!.people.map(person => person.label), ["Ann  助理"]);
  await assert.rejects(env.service.admit("telegram", address("bob"), { invite: code }), /expired or was already used/);
  await env.service.accept(env.adapter, [message("ann", "hi"), message("expert", "me")]);
  await env.service.drain();
  const [guest, expert] = env.target.handled.slice(-2);
  assert.deepEqual([guest!.speaker.role, guest!.speaker.label, guest!.principal.kind], ["guest", "Ann  助理", "contact"]);
  assert.deepEqual([expert!.speaker.role, expert!.principal.kind], ["owner", "account"]);
  // The Assistant reaches the owner, never the guest.
  assert.deepEqual((await env.connections.linked(owner)).map(entry => entry.identity!.senderId), ["expert"]);
  const [person] = (await env.service.view(owner)).find(status => status.kind === "telegram")!.people;
  assert.equal(await env.service.dismiss(randomUUID(), "telegram", person!.id), false, "only the owner revokes");
  assert.equal(await env.service.dismiss(owner, "telegram", person!.id), true);
  const handled = env.target.handled.length;
  await env.service.accept(env.adapter, [message("ann", "hello again")]);
  await env.service.drain();
  assert.equal(env.target.handled.length, handled, "a revoked guest reaches nothing");
}));

test("An owner cannot be a guest, and the invite stays for someone else", options, async () => isolated(async pool => {
  const env = await stack(pool);
  const owner = await link(env, "expert");
  const { code } = await env.service.invite(owner, "telegram", "x");
  await assert.rejects(env.service.admit("telegram", address("expert"), { invite: code }), /expired or was already used/);
  await env.service.admit("telegram", address("guest"), { invite: code });
  assert.equal((await env.connections.guests(owner)).length, 1);
}));

test("A Telegram id that belongs to another account cannot link by code", options, async () => isolated(async pool => {
  const env = await stack(pool, { claim: async () => false });
  const owner = randomUUID();
  const { code } = await env.service.connect(owner, "telegram");
  await env.service.accept(env.adapter, [message("taken", code)]);
  await env.service.drain();
  assert.match(env.adapter.texts.at(-1)!, /已经连着另一个 Hatch 账号/);
  assert.equal((await env.connections.linked(owner)).length, 0);
}));

type BotCall = { method: string; token: string; body: any };
/** A Telegram that knows these tokens; every call is recorded. */
function telegramApi(tokens: Record<string, string>) {
  const calls: BotCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const [, token, method] = String(url).match(/\/bot([^/]+)\/(\w+)$/)!;
    calls.push({ method: method!, token: token!, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const username = tokens[token!];
    if (!username) return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username } : true }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function productBots(pool: Pool, tokens: Record<string, string>) {
  const api = telegramApi(tokens);
  const gateway = new FakeGateway();
  const seal = { seal: (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64"), open: <T,>(sealed: string) => JSON.parse(Buffer.from(sealed, "base64").toString()) as T };
  const telegramForm = { ...CREDENTIAL_FORMS.telegram!, build: (credentials: any, scope: string) => new TelegramChannel(credentials, scope, api.fetchImpl) } as typeof CREDENTIAL_FORMS.telegram;
  const stores = await openChannelStores(pool, scopeOf);
  const own = async (kind: ChannelKind, scope: string) => {
    const sealed = kind === "telegram" ? await stores.connections.credentialsOf(kind, scope) : undefined;
    return sealed ? new TelegramChannel(seal.open(sealed), scope, api.fetchImpl) : undefined;
  };
  const env = await stack(pool, { adapters: [], gateway, own });
  env.service.register("product", new ProductTarget({ gateway, limiter: env.limiter }));
  const apps = new OwnApps({ connections: stores.connections, seal, forms: { telegram: telegramForm }, origin: "https://site.test", ownsProduct: async (_account, product) => product !== "foreign" });
  const adapterOf = async (scope: string) => (await env.service.hub.get("telegram", scope))!;
  return { ...env, api, apps, gateway, adapterOf, stores, seal };
}
const botOf = async (env: Awaited<ReturnType<typeof productBots>>, owner: string, productId: string) =>
  (await env.stores.connections.owned(owner)).find(connection => connection.channel === "telegram" && connection.target.kind === "product" && connection.target.productId === productId && connection.hasCredentials);

test("Saving a bot token proves it, points the webhook at that bot, and the Product answers anyone who writes to it", options, async () => isolated(async pool => {
  const env = await productBots(pool, { "111:aaa": "shop_bot" });
  const owner = randomUUID();
  await env.apps.save(owner, "telegram", "p1", { token: " 111:aaa " });
  assert.deepEqual(env.api.calls.map(call => call.method), ["getMe", "setWebhook"]);
  const bot = (await botOf(env, owner, "p1"))!;
  assert.equal(bot.audience, "public");
  const hook = env.api.calls[1]!.body;
  assert.equal(hook.url, `https://site.test/v1/channels/telegram/${bot.scope}/webhook`);
  assert.match(hook.secret_token, /^[0-9a-f]{48}$/);
  const adapter = await env.adapterOf(bot.scope);
  assert.equal(adapter.handle, "shop_bot");
  assert.equal(adapter.verify!(Buffer.alloc(0), { "x-telegram-bot-api-secret-token": hook.secret_token }), true);
  assert.equal(adapter.verify!(Buffer.alloc(0), { "x-telegram-bot-api-secret-token": "nope" }), false);
  // No sign-up: a stranger's first message is a conversation with the Product.
  await env.service.accept(adapter, [message("walker", "How much?")]);
  await env.settle();
  assert.deepEqual(env.gateway.submitted.map(sent => [sent.principal.kind, (sent.conversation as any).connectionId]), [["contact", bot.id]]);
  assert.equal(env.errors.length, 0);
}));

test("Each Product's bot is its own tenant: the same person is a different contact on each", options, async () => isolated(async pool => {
  const env = await productBots(pool, { "111:aaa": "shop_bot", "222:bbb": "faq_bot" });
  const owner = randomUUID();
  await env.apps.save(owner, "telegram", "p1", { token: "111:aaa" });
  await env.apps.save(owner, "telegram", "p2", { token: "222:bbb" });
  const [first, second] = [(await botOf(env, owner, "p1"))!, (await botOf(env, owner, "p2"))!];
  assert.notEqual(first.scope, second.scope);
  await env.service.accept(await env.adapterOf(first.scope), [message("walker", "one")]);
  await env.service.accept(await env.adapterOf(second.scope), [message("walker", "two")]);
  await env.settle();
  const [a, b] = env.gateway.submitted;
  assert.notDeepEqual(a!.principal, b!.principal);
  assert.deepEqual([a, b].map(sent => (sent!.conversation as any).connectionId), [first.id, second.id]);
}));

test("A bad token is refused and nothing is saved; a product that is not theirs is refused", options, async () => isolated(async pool => {
  const env = await productBots(pool, { "111:aaa": "shop_bot" });
  const owner = randomUUID();
  await assert.rejects(env.apps.save(owner, "telegram", "p1", { token: "999:bad" }), (error: any) => error.status === 422 && error.code === "telegram_probe_failed" && /Unauthorized/.test(error.message));
  assert.equal(await botOf(env, owner, "p1"), undefined);
  assert.deepEqual(env.api.calls.map(call => call.method), ["getMe"], "no webhook for a token that failed");
  await assert.rejects(env.apps.save(owner, "telegram", "foreign", { token: "111:aaa" }), (error: any) => error.status === 404);
  await assert.rejects(env.apps.save(owner, "telegram", "p1", {}), (error: any) => error.status === 400);
}));

test("Replacing the token lets the old bot go; saving the same token again does not", options, async () => isolated(async pool => {
  const env = await productBots(pool, { "111:aaa": "shop_bot", "222:bbb": "new_bot" });
  const owner = randomUUID();
  await env.apps.save(owner, "telegram", "p1", { token: "111:aaa" });
  const old = (await botOf(env, owner, "p1"))!;
  await env.service.accept(await env.adapterOf(old.scope), [message("walker", "hi")]);
  await env.settle();
  env.api.calls.length = 0;
  await env.apps.save(owner, "telegram", "p1", { token: "111:aaa" });
  assert.deepEqual(env.api.calls.map(call => call.method), ["getMe", "setWebhook"], "the same bot is not let go");
  env.api.calls.length = 0;
  await env.apps.save(owner, "telegram", "p1", { token: "222:bbb" });
  assert.deepEqual(env.api.calls.map(call => [call.method, call.token]), [["getMe", "222:bbb"], ["setWebhook", "222:bbb"], ["deleteWebhook", "111:aaa"]]);
  const current = (await botOf(env, owner, "p1"))!;
  assert.equal(await env.stores.connections.credentialsOf("telegram", old.scope), undefined, "the old bot's credentials are gone");
  assert.equal((await env.adapterOf(current.scope)).handle, "new_bot");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_connections WHERE owner_account_id = $1 AND channel = 'telegram'", [owner])).rows[0].n, 1, "a Product has one bot");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_channel_identities WHERE connection_id = $1", [current.id])).rows[0].n, 0, "nobody carries over to the new bot");
}));

test("Removing a bot ends its webhook, its credentials and its conversations", options, async () => isolated(async pool => {
  const env = await productBots(pool, { "111:aaa": "shop_bot" });
  const owner = randomUUID();
  await env.apps.save(owner, "telegram", "p1", { token: "111:aaa" });
  const bot = (await botOf(env, owner, "p1"))!;
  env.api.calls.length = 0;
  await env.apps.remove(owner, "telegram", "p1");
  assert.deepEqual(env.api.calls.map(call => [call.method, call.token]), [["deleteWebhook", "111:aaa"]]);
  assert.equal(await botOf(env, owner, "p1"), undefined);
  assert.equal(await env.service.hub.get("telegram", bot.scope), undefined);
  await env.apps.save(owner, "telegram", "p1", { token: "111:aaa" });
  assert.equal((await botOf(env, owner, "p1"))!.state, "active", "a bot can be added again");
}));
