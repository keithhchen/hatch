import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { conformance, fakeFetch, TIMEOUT } from "./adapterConformance.js";
import { DiscordChannel, type DiscordCredentials } from "./discordChannel.js";
import { GATEWAY_URL, INTENTS, listenDiscord, type GatewaySession } from "./discordGateway.js";
import type { ChannelAdapter, InboundEvent } from "./types.js";

const CREDENTIALS: DiscordCredentials = { token: "bot-token", applicationId: "900", botId: "900", username: "hatch" };
const TASK = "123e4567-e89b-12d3-a456-426614174000";
const TO = { threadId: "555", senderId: "42" };
const channel = (fetchImpl?: typeof fetch, credentials = CREDENTIALS) => new DiscordChannel(credentials, "acct", fetchImpl);

/** A Discord message as MESSAGE_CREATE carries it; the ids are snowflakes. */
const message = (extra: Record<string, unknown> = {}) => ({ id: "1100000000000000001", channel_id: "555", type: 0, content: "hi", author: { id: "42", bot: false }, attachments: [], mentions: [], ...extra });
// ── the wire ──

class FakeSocket extends EventEmitter {
  sent: Array<{ op: number; d: any }> = [];
  closed: number[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code?: number) { this.closed.push(code ?? 1000); this.emit("close", code); }
  frame(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
  hello(interval = 41250) { this.frame({ op: 10, d: { heartbeat_interval: interval } }); }
  dispatch(t: string, d: unknown, s: number) { this.frame({ op: 0, t, s, d }); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function live(options: { session?: GatewaySession; onDispatch?: (type: string, data: any) => Promise<void>; random?: () => number } = {}) {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const session = options.session ?? {};
  const controller = new AbortController();
  const done = listenDiscord({ token: "bot-token", session, connect: url => { urls.push(url); return socket; }, onDispatch: options.onDispatch ?? (async () => undefined), signal: controller.signal, random: options.random ?? (() => 0) });
  return { socket, urls, session, controller, done };
}

/** An adapter fed MESSAGE_CREATE / INTERACTION_CREATE through its own Gateway connection. */
async function deliver(type: string, payloads: unknown[], credentials = CREDENTIALS): Promise<InboundEvent[]> {
  const socket = new FakeSocket();
  const out: InboundEvent[] = [];
  const controller = new AbortController();
  const done = new DiscordChannel(credentials, "acct", undefined, () => socket).listen(async batch => { out.push(...batch); }, controller.signal);
  socket.hello();
  payloads.forEach((payload, index) => socket.dispatch(type, payload, index + 1));
  await settle();
  controller.abort(); await done;
  return out;
}

const first = message();
const second = message({ id: "1100000000000000002", content: "again" });
const parsed = async (...data: Array<Record<string, unknown>>) => deliver("MESSAGE_CREATE", data);

test("a message is an event: the message id, the channel as the thread, the author as the sender", async () => {
  assert.deepEqual(await parsed(first), [{
    eventId: "1100000000000000001", sequence: Number((1100000000000000001n >> 22n) * 4096n + (1100000000000000001n & 0xfffn)),
    address: { threadId: "555", senderId: "42" }, messageRef: "1100000000000000001", text: "hi",
  }]);
});

test("a later message has a larger sequence, which is a whole number JSON carries exactly", async () => {
  const [a, b] = await parsed(first, second);
  assert.ok(b!.sequence! > a!.sequence!);
  assert.ok(Number.isSafeInteger(b!.sequence));
});

test("messages from bots, ourselves included, and system messages are ignored", async () => {
  assert.deepEqual(await parsed(message({ author: { id: "7", bot: true } }), message({ author: { id: "900", bot: true } }), message({ type: 7 }), message({ author: undefined })), []);
});

test("a server message is ours only when it mentions the bot or replies to it, and the mention is dropped", async () => {
  const guild = { guild_id: "g1" };
  assert.deepEqual(await parsed(message(guild)), []);
  assert.deepEqual(await parsed(message({ ...guild, content: "<@900> help", mentions: [{ id: "900" }] })).then(list => list.map(({ text, group }) => ({ text, group }))), [{ text: "help", group: true }]);
  assert.deepEqual(await parsed(message({ ...guild, content: "<@!900> nick", mentions: [{ id: "900" }] })).then(list => list.map(event => event.text)), ["nick"]);
  assert.equal((await parsed(message({ ...guild, type: 19, referenced_message: { author: { id: "900" } } }))).length, 1);
  assert.equal((await parsed(message({ ...guild, type: 19, referenced_message: { author: { id: "8" } } }))).length, 0);
});

test("a server message is never ours before probe has found the bot's id", async () => {
  const out = await deliver("MESSAGE_CREATE", [message({ guild_id: "g1", content: "<@900> hi", mentions: [{ id: "900" }] })], { token: "t", applicationId: "900" });
  assert.deepEqual(out, []);
});

test("attachments become files with their name, size and url", async () => {
  const [event] = await parsed(message({ content: "", attachments: [{ filename: "a.png", size: 12, url: "https://cdn.discordapp.com/a.png" }, { filename: "b.pdf", url: "https://cdn.discordapp.com/b.pdf" }] }));
  assert.equal(event!.text, undefined);
  assert.deepEqual(event!.files, [{ ref: "https://cdn.discordapp.com/a.png", name: "a.png", size: 12 }, { ref: "https://cdn.discordapp.com/b.pdf", name: "b.pdf" }]);
});

test("a button press is an event carrying the interaction to answer", async () => {
  const press = { id: "1100000000000000009", type: 3, application_id: "900", token: "itok", channel_id: "555", member: { user: { id: "42" } }, message: { id: "1100000000000000005" }, data: { custom_id: `t:${TASK}:approve` } };
  const [event] = await deliver("INTERACTION_CREATE", [press]);
  assert.deepEqual(event!.button, { taskId: TASK, action: "approve", ref: "1100000000000000009|itok" });
  assert.deepEqual([event!.address, event!.group, event!.messageRef], [{ threadId: "555", senderId: "42" }, undefined, "1100000000000000005"]);
  assert.deepEqual(await deliver("INTERACTION_CREATE", [{ ...press, application_id: "1" }]), []);
});

test("a press of a button we do not know is a decline of no task", async () => {
  const [event] = await deliver("INTERACTION_CREATE", [{ id: "1100000000000000009", type: 3, application_id: "900", token: "itok", channel_id: "555", user: { id: "42" }, data: { custom_id: "other" } }]);
  assert.deepEqual([event!.button?.taskId, event!.button?.action], ["", "decline"]);
});

// ── sending ──

const ok = () => new Response(JSON.stringify({ id: "1" }));
test("a send posts to the channel as the bot, and nothing it says can ping everyone", async () => {
  const { fetchImpl, calls } = fakeFetch(ok);
  await channel(fetchImpl).send(TO, { text: "hello", replyTo: "77" }, "k:0");
  assert.equal(calls[0]!.url, "https://discord.com/api/v10/channels/555/messages");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, "Bot bot-token");
  assert.deepEqual(calls[0]!.body, { content: "hello", allowed_mentions: { parse: [] }, message_reference: { message_id: "77", fail_if_not_exists: false } });
});

test("buttons and a link are message components, five to a row", async () => {
  const { fetchImpl, calls } = fakeFetch(ok);
  const buttons = Array.from({ length: 6 }, (_, n) => ({ label: `b${n}`, taskId: TASK, action: n % 2 ? "decline" as const : "approve" as const }));
  await channel(fetchImpl).send(TO, { text: "ok?", buttons, link: { label: "Sign in", url: "https://hatch.test/in" } }, "k:0");
  const [row1, row2] = calls[0]!.body.components;
  assert.deepEqual([row1.type, row1.components.length, row2.components.length], [1, 5, 2]);
  assert.deepEqual(row1.components[0], { type: 2, style: 3, label: "b0", custom_id: `t:${TASK}:approve` });
  assert.equal(row1.components[1].style, 4);
  assert.deepEqual(row2.components[1], { type: 2, style: 5, label: "Sign in", url: "https://hatch.test/in" });
});

test("acknowledging a press replaces the message's buttons, with the interaction's own token and no bot header", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  await channel(fetchImpl).acknowledge({ eventId: "e", address: TO, button: { taskId: TASK, action: "approve", ref: "9|itok" } }, "done");
  assert.equal(calls[0]!.url, "https://discord.com/api/v10/interactions/9/itok/callback");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(calls[0]!.body, { type: 7, data: { content: "done", components: [], allowed_mentions: { parse: [] } } });
});

test("typing is posted to the channel", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  await channel(fetchImpl).typing(TO);
  assert.equal(calls[0]!.url, "https://discord.com/api/v10/channels/555/typing");
});

test("a rate limit carries how long to wait: the body says it in seconds", async () => {
  const { fetchImpl } = fakeFetch(() => Response.json({ message: "You are being rate limited.", retry_after: 1.5, global: false }, { status: 429 }));
  await assert.rejects(channel(fetchImpl).send(TO, { text: "x" }, "k"), (error: any) => error.failure === "definite" && error.options.retryAfterMs === 1500);
});

test("capabilities say what Discord allows", () => {
  assert.deepEqual(channel().capabilities(), { stream: false, edit: false, typing: true, buttons: true, maxLength: 2000, canInitiate: true, idempotentSend: false });
});

test("probe names the bot, and a token Discord refuses is an error", async () => {
  assert.deepEqual(await channel(fakeFetch(() => Response.json({ id: "900", username: "hatch" })).fetchImpl).probe(), { botId: "900", username: "hatch" });
  await assert.rejects(channel(fakeFetch(() => Response.json({ message: "401: Unauthorized" }, { status: 401 })).fetchImpl).probe(), /401: Unauthorized/);
});

test("an attachment is fetched from Discord's CDN only, and within the size cap", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response("bytes"));
  assert.equal((await channel(fetchImpl).download({ ref: "https://cdn.discordapp.com/a.png", name: "a.png" })).toString(), "bytes");
  assert.equal((calls[0]!.init!.headers as Record<string, string> | undefined)?.authorization, undefined);
  await assert.rejects(channel(fetchImpl).download({ ref: "https://evil.test/a.png", name: "a" }), /not on Discord's CDN/);
  const big = fakeFetch(() => new Response("x", { headers: { "content-length": String(26 * 1024 * 1024) } }));
  await assert.rejects(channel(big.fetchImpl).download({ ref: "https://media.discordapp.net/a.png", name: "a" }), /over/);
});

const discord = (outcome: Response | Error) => fakeFetch(() => outcome).fetchImpl;
conformance("discord", {
  adapter: channel(),
  send: outcome => channel(discord(outcome)).send(TO, { text: "x" }, "k:0"),
  cases: [
    { name: "a timeout", outcome: TIMEOUT, failure: "ambiguous" },
    { name: "HTTP 500", outcome: new Response("{}", { status: 500 }), failure: "ambiguous" },
    { name: "HTTP 429", outcome: Response.json({ retry_after: 2 }, { status: 429 }), failure: "definite" },
    { name: "HTTP 400", outcome: Response.json({ code: 50035, message: "Invalid Form Body" }, { status: 400 }), failure: "permanent" },
    { name: "HTTP 404 unknown channel", outcome: Response.json({ code: 10003 }, { status: 404 }), failure: "permanent" },
    { name: "HTTP 401", outcome: Response.json({ message: "401: Unauthorized" }, { status: 401 }), failure: "permanent", access: true },
    { name: "HTTP 403", outcome: new Response("{}", { status: 403 }), failure: "permanent", access: true },
    { name: "HTTP 403 cannot send to this user (50007)", outcome: Response.json({ code: 50007 }, { status: 403 }), failure: "permanent" },
    { name: "HTTP 403 missing permissions (50013)", outcome: Response.json({ code: 50013 }, { status: 403 }), failure: "permanent" },
  ],
  delivered: {
    duplicate: () => parsed(first, first),
    ordered: async () => [await parsed(first, second), await parsed(second, first)],
  },
  // The Gateway is the only way in: no request can claim to be from Discord.
  forged: () => (channel() as ChannelAdapter).verify?.(Buffer.from("{}"), {}) ?? false,
});

// ── the Gateway connection ──

test("gateway: connects to Discord, identifies with the token and the message intents, and heartbeats after the jitter", async () => {
  const run = live({ random: () => 0.5 });
  assert.deepEqual(run.urls, [GATEWAY_URL]);
  run.socket.hello(1000);
  assert.deepEqual(run.socket.sent, [{ op: 2, d: { token: "bot-token", intents: INTENTS, properties: { os: "linux", browser: "hatch", device: "hatch" } } }]);
  assert.equal(INTENTS & (1 << 15), 1 << 15, "MESSAGE_CONTENT");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual(run.socket.sent.at(-1), { op: 1, d: null });
  run.controller.abort(); await run.done;
});

test("gateway: a heartbeat the server never acknowledged closes the connection so it resumes", async () => {
  const run = live({ session: { seq: 4 }, random: () => 0 });
  run.socket.hello(20);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.deepEqual(run.socket.sent.filter(frame => frame.op === 1), [{ op: 1, d: 4 }], "one beat went out, the second found it unanswered");
  assert.deepEqual(run.socket.closed, [4000]);
  await run.done;
});

test("gateway: an acknowledged heartbeat keeps the connection", async () => {
  const run = live({ random: () => 0 });
  run.socket.hello(20);
  const beats = setInterval(() => run.socket.frame({ op: 11 }), 5);
  await new Promise(resolve => setTimeout(resolve, 70));
  clearInterval(beats);
  assert.deepEqual(run.socket.closed, []);
  run.controller.abort(); await run.done;
});

test("gateway: READY keeps the session, each handled dispatch moves the sequence, and a heartbeat asked for carries it", async () => {
  const seen: string[] = [];
  const run = live({ onDispatch: async type => { seen.push(type); } });
  run.socket.hello();
  run.socket.dispatch("READY", { session_id: "s1", resume_gateway_url: "wss://resume.discord.test" }, 1);
  run.socket.dispatch("MESSAGE_CREATE", message(), 2);
  await settle();
  assert.deepEqual(run.session, { id: "s1", resumeUrl: "wss://resume.discord.test", seq: 2 });
  assert.deepEqual(seen, ["MESSAGE_CREATE"], "READY is bookkeeping, not an event");
  run.socket.frame({ op: 1 });
  assert.deepEqual(run.socket.sent.at(-1), { op: 1, d: 2 });
  run.controller.abort(); await run.done;
});

test("gateway: a dropped connection resumes with the session id and the last handled sequence, on the resume address", async () => {
  const run = live({ session: { id: "s1", resumeUrl: "wss://resume.discord.test", seq: 7 } });
  assert.deepEqual(run.urls, ["wss://resume.discord.test/?v=10&encoding=json"]);
  run.socket.hello();
  assert.deepEqual(run.socket.sent, [{ op: 6, d: { token: "bot-token", session_id: "s1", seq: 7 } }]);
  run.controller.abort(); await run.done;
});

test("gateway: a dispatch that fails to store is not counted, the connection closes, and nothing after it is stored", async () => {
  const stored: string[] = [];
  const run = live({ session: { id: "s1", resumeUrl: "wss://r.test", seq: 1 }, onDispatch: async (_, data) => { if (data.n === 2) throw new Error("db down"); stored.push(data.n); } });
  run.socket.hello();
  run.socket.dispatch("MESSAGE_CREATE", { n: 2 }, 2);
  run.socket.dispatch("MESSAGE_CREATE", { n: 3 }, 3);
  await settle(); await settle();
  assert.deepEqual(stored, []);
  assert.equal(run.session.seq, 1, "a resume brings 2 again");
  assert.deepEqual(run.socket.closed, [4000]);
  await run.done;
});

test("gateway: reconnect closes for a resume; an invalid session that cannot resume forgets the session", async () => {
  const again = live({ session: { id: "s1", seq: 3 } });
  again.socket.frame({ op: 7, d: null });
  assert.deepEqual([again.socket.closed, again.session.id], [[4000], "s1"]);
  await again.done;
  const invalid = live({ session: { id: "s1", seq: 3 } });
  invalid.socket.frame({ op: 9, d: false });
  assert.deepEqual([invalid.socket.closed, invalid.session], [[4000], { id: undefined, seq: undefined }]);
  await invalid.done;
  const resumable = live({ session: { id: "s1", seq: 3 } });
  resumable.socket.frame({ op: 9, d: true });
  assert.equal(resumable.session.id, "s1");
  await resumable.done;
});

test("gateway: closes that no reconnect fixes make listen fail; an expired session starts over", async () => {
  const refused = live();
  refused.socket.emit("close", 4004);
  await assert.rejects(refused.done, /closed with 4004/);
  const intents = live();
  intents.socket.emit("close", 4014);
  await assert.rejects(intents.done, /Message Content/);
  const expired = live({ session: { id: "s1", seq: 3 } });
  expired.socket.emit("close", 4009);
  await expired.done;
  assert.deepEqual(expired.session, { id: undefined, seq: undefined });
  const dropped = live({ session: { id: "s1", seq: 3 } });
  dropped.socket.emit("close", 1006);
  await dropped.done;
  assert.equal(dropped.session.id, "s1", "an ordinary drop keeps the session");
});

test("Discord: a user's DM is the channel Discord opens for them, not their user id", async () => {
  const { fetchImpl, calls } = fakeFetch(() => new Response(JSON.stringify({ id: "dm-channel-9", type: 1 }), { status: 200 }));
  assert.equal(await channel(fetchImpl).directThread("user-7"), "dm-channel-9");
  assert.match(calls[0]!.url, /\/users\/@me\/channels$/);
  assert.deepEqual(calls[0]!.body, { recipient_id: "user-7" });
  const refused = fakeFetch(() => new Response(JSON.stringify({ message: "Cannot send messages to this user" }), { status: 403 }));
  await assert.rejects(channel(refused.fetchImpl).directThread("user-7"), /did not open a DM/);
});
