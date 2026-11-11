import { randomUUID } from "node:crypto";
import { Scenario, Blocked } from "../lib/scenario.mjs";
import { Auth, ChatApi, ChatSocket, StudioApi } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";
import { ConversationEvidence, outboxStates, postWebhook, tally, TERMINAL } from "../lib/idem-helpers.mjs";
import { sleep, until } from "../lib/util.mjs";

const SYSTEM = "You are a terse test responder. Follow each message literally and answer with as few words as possible.";
const say = (word) => `Reply with exactly the word: ${word}`;

/**
 * Idempotency end to end: duplicate, out-of-order and timed-out webhooks, outbound faults, and repeated HTTP, SSE, WebSocket and Studio sends.
 * Every count comes from the product's own durable state (Runtime and Registry databases) and the fake platform's call record.
 * A part that fails for a tool reason is recorded and the next part still runs.
 */
class Idempotency extends Scenario {
  constructor() { super({ id: 4, title: "Idempotency end to end: webhooks, outbound faults, HTTP/SSE/WS sends, Studio keys" }); }

  async run(stack, rec) {
    this.stack = stack; this.rec = rec;
    this.ev = new ConversationEvidence(stack.runtimePool);
    this.owner = await stack.account("owner");
    this.productId = await stack.product(this.owner, { system: SYSTEM });
    this.chat = new ChatApi(stack.url, Auth.bearer(this.owner.apiKey));
    this.hooks = new TelegramWebhooks(stack.registryUrl);
    this.duplicateTurns = 0;
    this.duplicateDeliveries = 0;
    for (const [name, part] of [["a_telegram_inbound", () => this.telegramInbound()], ["b_outbound_faults", () => this.outboundFaults()], ["c_http_chat", () => this.httpChat()], ["d_desktop_ws", () => this.desktopSocket()], ["e_studio", () => this.studio()]]) {
      try { await part(); } catch (error) {
        if (error instanceof Blocked) rec.note(`part ${name} blocked: ${error.message}`);
        else rec.check(`part ${name} ran to the end`, false, String(error?.stack ?? error).slice(0, 600));
      }
    }
    rec.measure("duplicate_turns_total", this.duplicateTurns);
    rec.measure("duplicate_outbound_deliveries_total", this.duplicateDeliveries);
    rec.measure("outbox_states_final", await outboxStates(stack));
  }

  // ── (a) inbound webhooks ──────────────────────────────────────────────

  async imConnection() {
    if (!this.connection) this.connection = await this.stack.connection({ owner: this.owner, audience: "org", productId: this.productId });
    return this.connection;
  }
  async admitChat(chatId) { await this.stack.admit(await this.imConnection(), { senderId: String(chatId) }); }

  /** What the product holds about one IM thread: inbox rows, Runs, user turns the model saw, replies sent. */
  async imCounts(chatId) {
    const { stack } = this;
    const inbox = (await stack.registryPool.query("SELECT event_id, state, run_id, attempts FROM hatch_channel_inbox WHERE thread_id = $1 ORDER BY seq", [String(chatId)])).rows;
    const outbox = (await stack.registryPool.query("SELECT id, state, source_key, attempts, sent_parts FROM hatch_channel_outbox WHERE thread_id = $1 ORDER BY seq", [String(chatId)])).rows;
    const runIds = [...new Set(inbox.map((row) => row.run_id).filter(Boolean))];
    const conversations = [...new Set((await Promise.all(runIds.map((runId) => this.ev.idOf({ runId })))).filter(Boolean))];
    const users = []; const replies = []; let runs = 0;
    for (const id of conversations) { runs += (await this.ev.runs(id)).length; users.push(...await this.ev.modelUsers(id)); replies.push(...await this.ev.modelReplies(id)); }
    const platform = stack.platform.calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === chatId);
    return { inbox, outbox, runs, runIds, conversations, users, replies, platformAttempts: platform.length, delivered: platform.filter((call) => call.delivered), texts: platform.filter((call) => call.delivered).map((call) => call.body.text) };
  }

  async settleReplies(chatId, { minDelivered = 1, quietMs = 8000 } = {}) {
    await until(`reply to chat ${chatId}`, async () => this.stack.platform.sends().filter((c) => c.body.chat_id === chatId).length >= minDelivered, { timeoutMs: 120_000, everyMs: 250 });
    await sleep(quietMs);
  }

  async telegramInbound() {
    const { stack, rec, hooks } = this;
    const results = {};
    // A1: the same update, posted ten times in a row.
    { const chat = 7101; await this.admitChat(chat);
      const update = hooks.message({ chatId: chat, text: say("alpha") });
      const statuses = []; for (let i = 0; i < 10; i++) statuses.push((await postWebhook(hooks, update)).status);
      await this.settleReplies(chat);
      const again = await Promise.all(Array.from({ length: 5 }, () => postWebhook(hooks, update)));   // a late redelivery, after the reply
      await sleep(6000);
      const counts = await this.imCounts(chat);
      results.sequential = this.report("A1 same update x10 sequential, then x5 after the reply", counts, { posts: statuses.length + again.length, non200: [...statuses, ...again.map((a) => a.status)].filter((s) => s !== 200).length });
    }
    // A2: the same update, ten at once.
    { const chat = 7102; await this.admitChat(chat);
      const update = hooks.message({ chatId: chat, text: say("bravo") });
      const answers = await Promise.all(Array.from({ length: 10 }, () => postWebhook(hooks, update)));
      await this.settleReplies(chat);
      results.concurrent = this.report("A2 same update x10 concurrent", await this.imCounts(chat), { posts: 10, non200: answers.filter((a) => a.status !== 200).length });
    }
    // A3: update ids out of order: the higher id arrives first; then both are redelivered in the opposite order.
    { const chat = 7103; await this.admitChat(chat);
      const base = this.hooks.nextUpdate + 500; this.hooks.nextUpdate = base + 10;
      const high = hooks.message({ updateId: base + 1, chatId: chat, text: say("delta") });
      const low = hooks.message({ updateId: base, chatId: chat, text: say("charlie") });
      const answers = []; for (const update of [high, low, low, high, high, low]) answers.push((await postWebhook(hooks, update)).status);
      await this.settleReplies(chat);
      const counts = await this.imCounts(chat);
      results.outOfOrder = this.report("A3 update ids out of order + redelivery", counts, { posts: 6, non200: answers.filter((s) => s !== 200).length }, 2);
      const order = counts.users.map((u) => /delta|charlie/.exec(u.content ?? "")?.[0]);
      rec.measure("a3_transcript_order_of_arrival_vs_update_id", order);
      rec.note(`A3: update ${base + 1} (delta) arrived before ${base} (charlie); the transcript order is ${order.join(" then ")}. Chat order follows arrival, not update_id.`);
    }
    // A4: a webhook whose HTTP response the platform gave up on: cut the connection right after sending, then retry, as Telegram does.
    { const chat = 7104; await this.admitChat(chat);
      const update = hooks.message({ chatId: chat, text: say("echo") });
      const cut = []; for (let i = 0; i < 3; i++) { cut.push(await postWebhook(hooks, update, { abortAfterMs: 0 })); await sleep(150); }
      await sleep(500);
      const storedBeforeAnyRetry = (await stack.registryPool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox WHERE thread_id = $1", [String(chat)])).rows[0].n;
      rec.measure("a4_inbox_rows_after_cut_posts_only", storedBeforeAnyRetry);
      rec.check("A4 the cut posts were stored although the platform never saw an answer", storedBeforeAnyRetry === 1 && cut.every((c) => c.aborted), { storedBeforeAnyRetry, cut: cut.map((c) => c.aborted) });
      const retries = []; for (let i = 0; i < 3; i++) retries.push((await postWebhook(hooks, update)).status);
      await this.settleReplies(chat);
      results.timedOut = this.report("A4 webhook cut client-side x3, then retried x3", await this.imCounts(chat), { posts: 6, cutShortClientSide: cut.filter((c) => c.aborted).length, non200: retries.filter((s) => s !== 200).length });
    }
    // A5: one update id carrying other content (a platform bug or a forgery): the first write wins; the second must not become a turn.
    { const chat = 7105; await this.admitChat(chat);
      const id = this.hooks.nextUpdate++;
      const first = await postWebhook(hooks, hooks.message({ updateId: id, chatId: chat, text: say("foxtrot") }));
      const second = await postWebhook(hooks, hooks.message({ updateId: id, chatId: chat, text: say("GOLF") }));
      await this.settleReplies(chat);
      const counts = await this.imCounts(chat);
      rec.measure("a5_same_update_id_other_content", { statuses: [first.status, second.status], texts: counts.users.map((u) => u.content), inboxRows: counts.inbox.length });
      rec.check("A5 same update id, other content: one turn, the first text; webhook answered 200", first.status === 200 && second.status === 200 && counts.users.length === 1 && /foxtrot/.test(counts.users[0].content), { statuses: [first.status, second.status], texts: counts.users.map((u) => u.content) });
      rec.note("A5: a redelivered update id with different content is dropped silently (200, no turn, no notice); it is not rejected as a conflict the way a changed client_message_id is on the HTTP and WebSocket doors.");
    }
    rec.measure("a_summary", results);
  }

  /** Records one inbound case and asserts: one inbox row per distinct update, one user turn per distinct text, no repeated delivery. */
  report(name, c, extra, distinctUpdates = 1) {
    const { rec } = this;
    const perText = {}; for (const u of c.users) perText[u.content] = (perText[u.content] ?? 0) + 1;
    const duplicateTurns = Object.values(perText).reduce((sum, n) => sum + Math.max(0, n - 1), 0) + Math.max(0, c.users.length - distinctUpdates);
    const sources = c.outbox.map((row) => row.source_key);
    const duplicateDeliveries = Math.max(0, c.delivered.length - c.runs) + (sources.length - new Set(sources).size);
    this.duplicateTurns += duplicateTurns; this.duplicateDeliveries += duplicateDeliveries;
    const summary = { ...extra, inboxRows: c.inbox.length, inboxStates: tally(c.inbox, (r) => r.state), runs: c.runs, userTurnsSeenByModel: c.users.length, modelReplies: c.replies.length, outboundDelivered: c.delivered.length, outboundAttempts: c.platformAttempts, outboxStates: tally(c.outbox, (r) => r.state), duplicateTurns, duplicateDeliveries };
    rec.measure(name, summary);
    rec.evidenceOf(name, { runIds: c.runIds, inboxEvents: c.inbox.map((r) => r.event_id), outboxIds: c.outbox.map((r) => r.id) });
    rec.check(`${name}: one inbox row per distinct update (${distinctUpdates})`, c.inbox.length === distinctUpdates, { rows: c.inbox.length });
    rec.check(`${name}: duplicate turns = 0`, duplicateTurns === 0, { users: c.users.map((u) => u.content), runs: c.runs });
    rec.check(`${name}: every distinct message reached the model once`, c.users.length === distinctUpdates, { seen: c.users.length });
    rec.check(`${name}: duplicate outbound deliveries = 0 (delivered <= Runs, one outbox row per source key)`, duplicateDeliveries === 0, { delivered: c.delivered.length, runs: c.runs, texts: c.texts });
    rec.check(`${name}: the webhook always answered 200`, extra.non200 === 0, extra);
    return summary;
  }

  // ── (b) outbound faults ───────────────────────────────────────────────

  async outboundFaults() {
    const { stack, rec, hooks } = this;
    const hit = (chat) => (call) => call.method === "sendMessage" && call.body.chat_id === chat;
    const slow = (chat) => ({ match: hit(chat), hangMs: 17_000 });   // longer than the adapter's 15 s timeout
    const cases = [
      { chat: 7201, name: "429 once, then OK", faults: [{ status: 429, body: { ok: false, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } }, headers: { "retry-after": "1" } }], expect: { state: "sent", delivered: 1, attempts: 2 } },
      { chat: 7202, name: "429 twice, then OK", faults: [{ status: 429, body: { ok: false, description: "Too Many Requests" } }, { status: 429, body: { ok: false, description: "Too Many Requests" } }], expect: { state: "sent", delivered: 1, attempts: 3 } },
      { chat: 7203, name: "timeout, platform received it anyway", faults: [{ ...slow(7203), deliverAnyway: true }], expect: { state: "unknown", attempts: 1 } },
      { chat: 7204, name: "timeout, platform never received it", faults: [slow(7204)], expect: { state: "unknown", attempts: 1 } },
      { chat: 7205, name: "5xx once, then OK", faults: [{ status: 502, body: { ok: false, description: "Bad Gateway" } }], expect: { state: "unknown", attempts: 1 } },
      { chat: 7206, name: "400 permanent", faults: [{ status: 400, body: { ok: false, description: "Bad Request: chat not found" } }], expect: { state: "failed", attempts: 1 } }
    ];
    for (const c of cases) { await this.admitChat(c.chat); for (const fault of c.faults) stack.platform.inject({ match: hit(c.chat), ...fault }); }
    for (const c of cases) await postWebhook(hooks, hooks.message({ chatId: c.chat, text: say(`fault${c.chat}`) }));
    const outboxOf = async (chat) => (await stack.registryPool.query("SELECT state, attempts, sent_parts, last_error, source_key FROM hatch_channel_outbox WHERE thread_id = $1", [String(chat)])).rows;
    const finished = (rows) => rows.length > 0 && rows.every((r) => ["sent", "unknown", "failed", "cancelled", "undelivered"].includes(r.state));
    for (const c of cases) await until(`outbox of ${c.chat} to finish`, async () => finished(await outboxOf(c.chat)), { timeoutMs: 150_000, everyMs: 500 });
    await sleep(25_000);   // long enough for any wrongful resend (backoff is 2 s, 4 s, 8 s)
    const detail = {};
    for (const c of cases) {
      const rows = await outboxOf(c.chat);
      const calls = stack.platform.calls.filter((call) => call.method === "sendMessage" && call.body.chat_id === c.chat);
      const row = rows[0];
      detail[c.name] = { chat: c.chat, outboxRows: rows.length, state: row?.state, rowAttempts: row?.attempts, platformAttempts: calls.length, platformFaults: calls.map((call) => call.fault ?? "ok"), delivered: calls.filter((call) => call.delivered).length, lastError: row?.last_error?.slice(0, 120) };
      rec.check(`b: ${c.name}: outbox ends ${c.expect.state}`, row?.state === c.expect.state, detail[c.name]);
      rec.check(`b: ${c.name}: the platform was asked exactly ${c.expect.attempts} time(s) (no resend of an ambiguous send)`, calls.length === c.expect.attempts, detail[c.name]);
      if (c.expect.delivered !== undefined) rec.check(`b: ${c.name}: exactly one delivered`, detail[c.name].delivered === c.expect.delivered, detail[c.name]);
      if (detail[c.name].delivered > 1) this.duplicateDeliveries += detail[c.name].delivered - 1;
      rec.check(`b: ${c.name}: never delivered twice`, detail[c.name].delivered <= 1, detail[c.name]);
    }
    const all = await outboxStates(stack);
    rec.measure("b_fault_cases", detail);
    rec.measure("b_outbox_states", { sent: all.sent ?? 0, unknown: all.unknown ?? 0, failed: all.failed ?? 0, pending: (all.pending ?? 0) + (all.sending ?? 0), other: Object.fromEntries(Object.entries(all).filter(([k]) => !["sent", "unknown", "failed", "pending", "sending"].includes(k))) });
    const unknownRows = cases.filter((c) => detail[c.name].state === "unknown");
    rec.measure("b_unknown_delivered_by_platform", unknownRows.filter((c) => detail[c.name].delivered > 0).length);
    rec.measure("b_unknown_not_delivered_by_platform", unknownRows.filter((c) => detail[c.name].delivered === 0).length);
    rec.note("b: `unknown` is a reply the product will not resend because the platform may already have it. Where the platform did not have it (timeout without delivery, 502), the user never receives that reply; the product trades a possible duplicate for a possible silent loss on non-idempotent Telegram, as deliveryAfterFailure documents.");
  }

  // ── (c) HTTP and SSE Chat ─────────────────────────────────────────────

  async conversation() { return this.chat.create(this.productId); }

  async countsOf(conversationId) { const id = await this.ev.idOf({ publicId: conversationId }); return { id, ...(await this.ev.counts(id)) }; }

  /** Asserts one Run, one user turn, and reports model calls. `expectedReplies` is the model calls a single answer takes. */
  async expectOneTurn(name, conversationId, { turns = 1 } = {}) {
    const id = await this.ev.idOf({ publicId: conversationId });
    await this.ev.quiesce(id);
    const counts = await this.ev.counts(id);
    const runs = await this.ev.runs(id);
    const dup = Math.max(0, counts.modelUsers - turns);
    this.duplicateTurns += dup;
    this.rec.measure(name, { ...counts, expectedTurns: turns, runStatuses: tally(runs, (r) => r.status), duplicateTurns: dup });
    this.rec.evidenceOf(name, { conversation: conversationId, runIds: runs.map((r) => r.id) });
    this.rec.check(`${name}: ${turns} Run(s)`, counts.runs === turns, counts);
    this.rec.check(`${name}: ${turns} user message(s) in the journal and in the model transcript`, counts.journalUsers === turns && counts.modelUsers === turns, counts);
    this.rec.check(`${name}: model calls = ${turns} (one answer per Run)`, counts.modelReplies === turns, counts);
    return counts;
  }

  async httpChat() {
    const { chat, productId, rec } = this;
    // C1: the same key and content, ten times in a row; the first waits for the answer, the rest come after it.
    { const conv = await this.conversation(); const key = randomUUID();
      const first = await chat.send(conv, productId, { key, content: say("one"), wait: 90 });
      const repeats = []; for (let i = 0; i < 9; i++) repeats.push(await chat.send(conv, productId, { key, content: say("one"), wait: 30 }));
      rec.check("C1 first send answered, repeats replay the same Run", first.status === 200 && repeats.every((r) => r.status === 200 && r.json?.run?.id === first.json?.run?.id && r.json?.outcome === "replayed"), { first: first.status, outcomes: repeats.map((r) => r.json?.outcome ?? r.status) });
      await this.expectOneTurn("c1_http_sequential_x10", conv);
    }
    // C1b: repeats while the Run is still running.
    { const conv = await this.conversation(); const key = randomUUID();
      const sends = []; for (let i = 0; i < 6; i++) sends.push(await chat.send(conv, productId, { key, content: "Count from 1 to 25, one number per line." }));
      rec.measure("c1b_outcomes_during_run", tally(sends, (r) => r.json?.outcome ?? `http_${r.status}`));
      rec.check("C1b repeats while running are accepted without a second Run", sends.every((r) => [200, 202].includes(r.status) && r.json?.run_id === sends[0].json?.run_id || r.json?.run?.id === sends[0].json?.run_id), sends.map((r) => [r.status, r.json?.outcome]));
      await this.expectOneTurn("c1b_http_repeat_while_running_x6", conv);
    }
    // C2: ten concurrent sends of one key.
    { const conv = await this.conversation(); const key = randomUUID();
      const sends = await Promise.all(Array.from({ length: 10 }, () => chat.send(conv, productId, { key, content: say("two") })));
      rec.measure("c2_http_concurrent_outcomes", tally(sends, (r) => r.json?.outcome ?? `http_${r.status}:${r.json?.error?.code}`));
      rec.check("C2 no concurrent same-key send failed", sends.every((r) => [200, 202].includes(r.status)), sends.map((r) => [r.status, r.json?.error?.code]));
      rec.check("C2 exactly one send started the Run", sends.filter((r) => r.json?.outcome === "started").length === 1, tally(sends, (r) => r.json?.outcome));
      await this.expectOneTurn("c2_http_concurrent_x10", conv);
    }
    // C3: SSE: two concurrent streams on one key, then a replay stream after the Run has ended.
    { const conv = await this.conversation(); const key = randomUUID();
      const read = async (signal) => { const { frames } = await chat.sendSse(conv, productId, { key, content: say("three"), signal }); const seen = []; for await (const f of frames) seen.push(f.json?.type ?? f.event); return seen; };
      const [a, b] = await Promise.all([read(), read()]);
      rec.measure("c3_sse_concurrent_frames", { a: a.length, b: b.length, aAccepted: a.filter((t) => t === "message.accepted").length });
      await this.expectOneTurn("c3_sse_same_key_x2", conv);
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
      let endedByServer = false; const replayFrames = [];
      try { const { frames } = await chat.sendSse(conv, productId, { key, content: say("three"), signal: ctrl.signal }); for await (const f of frames) replayFrames.push(f.json?.type ?? f.event); endedByServer = !ctrl.signal.aborted; } catch (error) { replayFrames.push(`error:${error.message}`); }
      clearTimeout(timer);
      rec.measure("c3_sse_replay_after_end", { endedByServer, frames: replayFrames });
      rec.check("C3 an SSE replay of a finished Run's key ends by itself", endedByServer, replayFrames);
      if (!endedByServer) rec.defect({ title: "SSE send replayed on a key whose Run already ended never closes", severity: "low", expected: "A replayed send on a finished Run answers with the accepted event and ends the stream (the stream is documented to end when its Run ends).", actual: `The stream stayed open for 8 s and was cut by the client; frames: ${replayFrames.join(",")}`, repro: "POST /v1/conversations/:id/messages Accept: text/event-stream twice with one client_message_id, the second after the Run completed; the second response never ends (src/index.ts openEventStream waits for a run.state event that is never published again)." });
      await this.expectOneTurn("c3_sse_after_replay", conv);
    }
    // C4: same key, different content, rejected - after the Run, during the Run, and for a steered message.
    { const conv = await this.conversation(); const key = randomUUID();
      const ok = await chat.send(conv, productId, { key, content: say("four"), wait: 90 });
      const clash = await chat.send(conv, productId, { key, content: say("FOUR, but different") });
      const same = await chat.send(conv, productId, { key, content: say("four") });
      rec.check("C4 same key, other content, after the Run: 409 client_message_conflict", ok.status === 200 && clash.status === 409 && clash.json?.error?.code === "client_message_conflict", { ok: ok.status, clash: [clash.status, clash.json?.error?.code] });
      rec.check("C4 same key, same content still replays", same.status === 200 && same.json?.outcome === "replayed", [same.status, same.json?.outcome]);
      await this.expectOneTurn("c4_conflict_after_run", conv);
    }
    { const conv = await this.conversation(); const keyA = randomUUID(); const keyB = randomUUID();
      const a = await chat.send(conv, productId, { key: keyA, content: "Count from 1 to 60, one number per line, slowly and without any other text." });
      const runId = a.json?.run_id ?? a.json?.run?.id;
      await until("the Run to be running", async () => (await chat.run(conv, productId, runId)).json?.run?.status === "running", { timeoutMs: 30_000, everyMs: 100 });
      const b = await chat.send(conv, productId, { key: keyB, content: "Then say the word: steered" });
      const clashA = await chat.send(conv, productId, { key: keyA, content: "a different first message" });
      const clashB = await chat.send(conv, productId, { key: keyB, content: "a different steered message" });
      const replayB = await chat.send(conv, productId, { key: keyB, content: "Then say the word: steered" });
      rec.measure("c4b_outcomes", { first: a.json?.outcome, steered: b.json?.outcome, replaySteered: replayB.json?.outcome });
      rec.check("C4b second message during the Run steers it", b.json?.outcome === "steered", [b.status, b.json]);
      rec.check("C4b other content on the first key during the Run: 409 client_message_conflict", clashA.status === 409 && clashA.json?.error?.code === "client_message_conflict", [clashA.status, clashA.json?.error?.code]);
      rec.check("C4b other content on the steered key: 409 client_message_conflict", clashB.status === 409 && clashB.json?.error?.code === "client_message_conflict", [clashB.status, clashB.json?.error?.code]);
      rec.check("C4b same content on the steered key replays", [200, 202].includes(replayB.status) && replayB.json?.outcome === "replayed", [replayB.status, replayB.json?.outcome]);
      await chat.cancel(conv, productId, runId);
      const id = await this.ev.idOf({ publicId: conv }); await this.ev.quiesce(id);
      const journal = await this.ev.journalUsers(id);
      rec.measure("c4b_journal_users", journal.map((j) => ({ key: j.key === keyA ? "A" : j.key === keyB ? "B" : "other", steered: j.steered })));
      rec.check("C4b the journal holds exactly the two accepted messages", journal.length === 2, journal);
      this.duplicateTurns += Math.max(0, journal.length - 2);
    }
    // C5: assets: the same bytes uploaded twice are two assets with one digest, so one key over either is the same message.
    { const conv = await this.conversation(); const bytes = Buffer.from("idempotency asset 0123456789\n".repeat(20));
      const [u1, u2, u3] = await Promise.all([chat.upload(conv, productId, "same.txt", bytes), chat.upload(conv, productId, "same-again.txt", bytes), chat.upload(conv, productId, "other.txt", Buffer.from("different bytes\n".repeat(20)))]);
      const ids = [u1, u2, u3].map((u) => u.json?.asset?.id ?? u.json?.asset_id ?? u.json?.id);
      rec.measure("c5_asset_uploads", { statuses: [u1.status, u2.status, u3.status], ids, shape: Object.keys(u1.json ?? {}) });
      if (ids.some((id) => !id)) rec.note(`C5 not exercised: this Runtime has no content moderation adapter (documented in openChatAssets: every upload ends failed as unavailable, 503), so no asset becomes ready; upload statuses ${[u1, u2, u3].map((u) => u.status).join(",")}. Asset-hash idempotency stays unmeasured.`);
      else {
        const key = randomUUID(); const parts = (id) => [{ type: "text", text: say("five") }, { type: "file", assetId: id }];
        await this.waitReady(conv, ids);
        const first = await chat.send(conv, productId, { key, parts: parts(ids[0]), wait: 90 });
        const sameBytes = await chat.send(conv, productId, { key, parts: parts(ids[1]), wait: 30 });
        const otherBytes = await chat.send(conv, productId, { key, parts: parts(ids[2]) });
        rec.measure("c5_asset_statuses", { first: [first.status, first.json?.error?.code], sameBytes: [sameBytes.status, sameBytes.json?.outcome, sameBytes.json?.error?.code], otherBytes: [otherBytes.status, otherBytes.json?.error?.code] });
        rec.check("C5 same key over an asset with the same bytes replays", first.status === 200 && sameBytes.status === 200 && sameBytes.json?.outcome === "replayed", { first: first.status, sameBytes: [sameBytes.status, sameBytes.json?.error?.code ?? sameBytes.json?.outcome] });
        rec.check("C5 same key over an asset with other bytes: 409 client_message_conflict", otherBytes.status === 409 && otherBytes.json?.error?.code === "client_message_conflict", [otherBytes.status, otherBytes.json?.error?.code]);
        await this.expectOneTurn("c5_asset_key", conv);
      }
    }
  }

  async waitReady(conv, ids) {
    await sleep(1500);   // uploads finish becoming ready; a send before that is refused with asset_not_ready
  }

  // ── (d) Desktop WebSocket ─────────────────────────────────────────────

  async desktopSocket() {
    const { stack, rec, productId } = this;
    const open = (conv) => ChatSocket.open(stack.url, { auth: Auth.bearer(this.owner.apiKey), firstMessage: true, productId, conversationId: conv });
    const failures = (socket) => socket.frames.filter((f) => f.type === "turn.failed").map((f) => f.error?.code);
    // The Chat WebSocket says API keys go "in the Authorization header or the first message": try the header.
    { const conv = await this.conversation();
      const viaHeader = await ChatSocket.open(stack.url, { auth: Auth.bearer(this.owner.apiKey), productId, conversationId: conv }).then((s) => { s.close(); return "ok"; }, (error) => error.message);
      rec.measure("d0_api_key_in_upgrade_authorization_header", viaHeader);
      rec.check("D0 an API key in the upgrade's Authorization header opens the Desktop socket", viaHeader === "ok", viaHeader);
      if (viaHeader !== "ok") rec.defect({ title: "Chat WebSocket ignores an API key sent in the Authorization header of the upgrade", severity: "low", expected: "Spec and the server's own error text: API keys go in the Authorization header or the first message.", actual: `client.hello without auth_token after an upgrade with Authorization: Bearer <api key> is refused: ${viaHeader}. Only the first message (auth_token) or a session cookie works.`, repro: "Open wss://<runtime>/v1/runtime with Authorization: Bearer <api key>, send client.hello without auth_token (src/index.ts withUpgradeToken only reads the hatch_session cookie)." });
    }
    // D1: five sends of one key on one socket, then five on a second socket, then one more over HTTP.
    { const conv = await this.conversation(); const key = randomUUID();
      const s1 = await open(conv); const s2 = await open(conv);
      for (let i = 0; i < 5; i++) s1.message(say("six"), { key });
      await s1.waitFor("the Run to complete", (f) => f.type === "turn.state" && f.status === "completed", 90_000);
      for (let i = 0; i < 5; i++) s2.message(say("six"), { key });
      await sleep(2500);
      const clash = s2.message("a different message under the same key", { key });
      await s2.waitFor("conflict", (f) => f.type === "turn.failed" && f.run_id === clash.runId, 15_000).catch(() => undefined);
      const http = await this.chat.send(conv, productId, { key, content: say("six"), wait: 20 });
      rec.measure("d1_ws_frames", { s1: tally(s1.frames, (f) => f.type), s2: tally(s2.frames, (f) => f.type), s1Failures: failures(s1), s2Failures: failures(s2), httpOutcome: http.json?.outcome });
      rec.check("D1 a second socket sending the same key is accepted as a replay", !failures(s2).filter((c) => c !== "client_message_conflict").length, failures(s2));
      rec.check("D1 same key, other content over the socket: turn.failed client_message_conflict", failures(s2).includes("client_message_conflict"), failures(s2));
      rec.check("D1 the same key over HTTP after the socket replays", http.status === 200 && http.json?.outcome === "replayed", [http.status, http.json?.outcome, http.json?.error?.code]);
      await this.expectOneTurn("d1_ws_same_and_second_socket", conv);
      s1.close(); s2.close();
    }
    // D2: both sockets send the same key at once, three times each, before any Run exists.
    { const conv = await this.conversation(); const key = randomUUID();
      const s1 = await open(conv); const s2 = await open(conv);
      for (let i = 0; i < 3; i++) { s1.message(say("seven"), { key }); s2.message(say("seven"), { key }); }
      await sleep(1000);
      rec.measure("d2_ws_concurrent_failures", { s1: failures(s1), s2: failures(s2) });
      rec.check("D2 concurrent same-key sends on two sockets never fail", failures(s1).length + failures(s2).length === 0, { s1: failures(s1), s2: failures(s2) });
      await this.expectOneTurn("d2_ws_two_sockets_concurrent", conv);
      s1.close(); s2.close();
    }
  }

  // ── (e) Studio: the Assistant and Product workers ─────────────────────

  async studio() {
    const { stack, rec } = this;
    const studio = new StudioApi(stack.url, Auth.bearer(this.owner.apiKey));
    const view = await studio.assistantView();
    rec.measure("e_assistant_view_status", view.status);
    const userLines = async (needle) => ((await studio.messagesAssistant()).json?.messages ?? []).filter((m) => m.role === "user" && m.text.includes(needle));
    const waitIdle = async () => until("the Assistant to be idle", async () => (await studio.messagesAssistant()).json?.status === "idle", { timeoutMs: 120_000, everyMs: 500 }).catch(() => undefined);
    // E1: same key, same content, five in a row.
    { const key = randomUUID(); const text = say("assistant-one");
      const sends = []; for (let i = 0; i < 5; i++) sends.push(await studio.sendAssistant({ content: text, key }));
      rec.measure("e1_assistant_sequential", sends.map((r) => [r.status, r.json?.message?.id?.slice(0, 8)]));
      await waitIdle();
      const lines = await userLines("assistant-one");
      this.duplicateTurns += Math.max(0, lines.length - 1);
      rec.check("E1 Assistant: five sends of one key leave one user message", lines.length === 1 && sends.every((r) => [200, 202].includes(r.status)) && new Set(sends.map((r) => r.json?.message?.id)).size === 1, { lines: lines.length, statuses: sends.map((r) => r.status) });
    }
    // E2: same key, ten at once.
    { const key = randomUUID(); const text = say("assistant-two");
      const sends = await Promise.all(Array.from({ length: 10 }, () => studio.sendAssistant({ content: text, key })));
      await waitIdle();
      const lines = await userLines("assistant-two");
      this.duplicateTurns += Math.max(0, lines.length - 1);
      rec.measure("e2_assistant_concurrent", { statuses: tally(sends, (r) => r.status), messageIds: new Set(sends.map((r) => r.json?.message?.id)).size, userLines: lines.length });
      rec.check("E2 Assistant: ten concurrent sends of one key leave one user message", lines.length === 1 && sends.every((r) => [200, 202].includes(r.status)), { lines: lines.length, statuses: sends.map((r) => r.status) });
    }
    // E3: same key, other content.
    { const key = randomUUID();
      const first = await studio.sendAssistant({ content: say("assistant-three"), key });
      const clash = await studio.sendAssistant({ content: say("assistant-THREE other"), key });
      await waitIdle();
      rec.check("E3 Assistant: same key, other content: 409 idempotency_conflict", [200, 202].includes(first.status) && clash.status === 409 && clash.json?.error?.code === "idempotency_conflict", { first: first.status, clash: [clash.status, clash.json?.error?.code] });
      rec.check("E3 Assistant: the refused message was not stored", (await userLines("assistant-THREE other")).length === 0);
    }
    // E4: a creator Product made through the real API (the Product the workers belong to), then its worker.
    { const key = randomUUID(); const create = (body) => studio.call("POST", "/v1/creator/products", { body, headers: { "idempotency-key": key } });
      const body = { name: "Idempotency product", promise: "Answers questions about idempotency." };
      const made = await Promise.all(Array.from({ length: 5 }, () => create(body)));
      const clash = await create({ name: "Another product", promise: "Something else." });
      const ids = new Set(made.map((r) => r.json?.product?.product_id).filter(Boolean));
      const products = ((await studio.call("GET", "/v1/creator/products")).json?.products ?? []).filter((p) => p.name === body.name).length;
      const failedCreates = made.filter((r) => r.status >= 500);
      rec.measure("e4_product_create_error_bodies", failedCreates.slice(0, 2).map((r) => r.text.slice(0, 300)));
      if (failedCreates.length) rec.defect({ title: "Concurrent POST /v1/creator/products with one Idempotency-Key fails with 500 instead of replaying", severity: "medium", expected: "Concurrent requests with one Idempotency-Key and one payload all return the same Product (201), as a sequential replay does.", actual: `${failedCreates.length} of 5 concurrent creates returned ${[...new Set(failedCreates.map((r) => r.status))].join("/")}: ${failedCreates[0].text.slice(0, 200)}. Exactly one Product was created.`, repro: "Send 5 POST /v1/creator/products at once with the same Idempotency-Key and body (scenario 4, part E4)." });
      rec.measure("e4_product_create", { statuses: tally(made, (r) => r.status), distinctProducts: ids.size, productsListed: products, clash: [clash.status, clash.json?.error?.code] });
      rec.check("E4 creating a Product with one Idempotency-Key five times at once makes one Product", made.every((r) => r.status === 201) && ids.size === 1 && products === 1, { statuses: made.map((r) => r.status), ids: ids.size, products });
      rec.check("E4 the same key with another payload: 409 idempotency_conflict", clash.status === 409 && clash.json?.error?.code === "idempotency_conflict", [clash.status, clash.json?.error?.code]);
      const creatorProduct = [...ids][0];
      const replay = await create(body);
      rec.check("E4 a later replay of the create returns the same Product", replay.status === 201 && replay.json?.product?.product_id === creatorProduct, [replay.status, replay.json?.product?.product_id === creatorProduct]);
      const listed = await studio.workers(creatorProduct);
      const worker = (listed.json?.workers ?? []).find((w) => w.availability === "available");
      rec.measure("e4_workers", (listed.json?.workers ?? []).map((w) => ({ id: w.id, availability: w.availability })));
      if (!worker) rec.note(`E4 worker idempotency not exercised: no worker is available (${listed.status}).`);
      else {
        const wkey = randomUUID(); const text = "Reply with exactly the word: worker-idem. Do not research anything.";
        const sends = await Promise.all(Array.from({ length: 5 }, () => studio.sendWorker(creatorProduct, worker.id, { content: text, key: wkey })));
        const again = await studio.sendWorker(creatorProduct, worker.id, { content: text, key: wkey });
        const other = await studio.sendWorker(creatorProduct, worker.id, { content: "A different request.", key: wkey });
        const failedSends = sends.filter((r) => r.status >= 500);
        rec.measure("e4_worker_error_bodies", failedSends.slice(0, 2).map((r) => r.text.slice(0, 300)));
        if (failedSends.length) rec.defect({ title: "Concurrent worker sends with one Idempotency-Key fail with 500 instead of replaying", severity: "medium", expected: "Concurrent sends with one Idempotency-Key and one content all return the one accepted message (202), as a sequential replay does.", actual: `${failedSends.length} of 5 concurrent sends returned ${[...new Set(failedSends.map((r) => r.status))].join("/")}: ${failedSends[0].text.slice(0, 200)}. Exactly one message was stored.`, repro: "POST /v1/creator/products/:id/workers/research/messages five times at once with one Idempotency-Key and one body (scenario 4, part E4)." });
        await sleep(1500);
        const lines = ((await studio.messagesWorker(creatorProduct, worker.id)).json?.messages ?? []).filter((m) => m.role === "user" && m.text.includes("worker-idem"));
        await studio.stopWorker(creatorProduct, worker.id);
        this.duplicateTurns += Math.max(0, lines.length - 1);
        rec.measure("e4_worker", { worker: worker.id, concurrent: tally(sends, (r) => r.status), messageIds: new Set(sends.map((r) => r.json?.message?.id)).size, replay: [again.status, again.json?.message?.id === sends[0].json?.message?.id], other: [other.status, other.json?.error?.code], userLines: lines.length });
        rec.check("E4 worker: five concurrent sends of one key leave one user message, and a replay returns the same message", sends.every((r) => r.status < 300) && lines.length === 1 && again.json?.message?.id === sends[0].json?.message?.id, { statuses: sends.map((r) => r.status), lines: lines.length, again: again.status });
        rec.check("E4 worker: same key, other content: 409 idempotency_conflict", other.status === 409 && other.json?.error?.code === "idempotency_conflict", [other.status, other.json?.error?.code]);
      }
    }
  }
}
export default new Idempotency();
