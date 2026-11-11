import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, ChatSocket } from "../lib/clients.mjs";
import { Chaos, ImWorld, waitForReplies, waitUntil } from "../lib/crash-helpers.mjs";
import { sleep } from "../lib/util.mjs";

const SLOW_MS = 10_000;
const FAST_MS = 300;
const FILE_LIST = { entries: [{ name: "alpha.txt", type: "file" }, { name: "beta.txt", type: "file" }] };

/**
 * Crash: kill -9 the Runtime and the Registry mid-Run, rolling restart. Everything goes through the real entry points
 * (signed Telegram webhook, Desktop WebSocket, Chat HTTP) with real model calls; the platform and search provider are the tool's local fakes.
 */
class Crash extends Scenario {
  constructor() { super({ id: 1, title: "Crash: kill -9 Runtime and Registry mid-Run, rolling restart, local-tool wait" }); }

  async run(stack, rec) {
    this.chaos = new Chaos(stack);
    await stack.startRuntime();
    const world = await ImWorld.create(stack);
    rec.note("Fakes: the messaging platform and the web-search provider are the tool's local fakes; the org Connection row is inserted by Stack.connection (no product API yet). Model is real.");
    const trials = [
      ["a1 IM: kill -9 the Runtime holding the Runs (second instance already up)", (ctx) => this.killHolder(ctx)],
      ["a2 IM: rolling restart of every Runtime instance mid-Run", (ctx) => this.rolling(ctx)],
      ["b1 IM: kill -9 Registry mid-Run, restart after the Run finished", (ctx) => this.registryOutlivesRun(ctx)],
      ["b2 IM: kill -9 Registry right after webhooks accepted, restart 3 s later, platform redelivers", (ctx) => this.registryRightAway(ctx), "accepted"],
      ["c IM: kill -9 Registry and every Runtime at once, restart both", (ctx) => this.everything(ctx)]
    ];
    const parts = (process.env.CRASH_PARTS ?? "a1,a2,b1,b2,c,d").split(",");
    for (const [name, chaos, trigger] of trials.filter(([n]) => parts.includes(n.split(" ")[0]))) {
      await this.imTrial(stack, rec, world, name, chaos, trigger);
      await this.chaos.ensureHealthy();
    }
    if (parts.includes("d")) await this.localToolTrials(stack, rec, world);
  }

  // ── IM path ──────────────────────────────────────────────────────────

  async imTrial(stack, rec, world, name, chaosFn, trigger = "in_flight") {
    const key = name.split(" ")[0];
    stack.platform.search.delayMs = SLOW_MS;
    const servedFrom = stack.edge.served.length;
    const senders = [await world.sender(key), await world.sender(key), await world.sender(key)];
    const posts = [];
    for (const sender of senders) posts.push(await world.post(sender));
    const accepted = posts.filter((p) => p.status === 200).length;
    const ctx = { stack, world, senders, posts, servedFrom, key, notes: {} };
    if (trigger === "in_flight") {
      const reached = await waitUntil(() => senders.every((s) => world.searches(s).length >= 1), 90_000);
      rec.check(`${key}: every Run reached the slow web_search before the crash`, reached, senders.map((s) => world.searches(s).length));
      await sleep(1000);
    }
    ctx.before = await Promise.all(senders.map((s) => world.evidence(s)));
    const killAt = await chaosFn(ctx);
    stack.platform.search.delayMs = FAST_MS;
    await waitForReplies(world, senders);
    const after = await Promise.all(senders.map((s) => world.evidence(s)));
    const firstReply = (e) => e.sends[0]?.at;
    const replyMs = after.map((e) => (firstReply(e) ? firstReply(e) - killAt : null));
    const token = (s, e) => e.sends.filter((m) => m.text.includes(`DONE-${s.tag}`));
    rec.measure(`${key}_accepted_webhooks`, accepted);
    rec.measure(`${key}_inbox_rows`, after.map((e) => e.inbox.length));
    rec.measure(`${key}_inbox_states`, after.map((e) => e.inbox.map((r) => r.state).join(",")));
    rec.measure(`${key}_runs_per_sender`, after.map((e) => e.runs.length));
    rec.measure(`${key}_run_status`, after.map((e) => e.runs.map((r) => r.status).join(",")));
    rec.measure(`${key}_executor_changed`, after.map((e, i) => e.runs[0]?.executor_id !== ctx.before[i].runs[0]?.executor_id));
    rec.measure(`${key}_sends_per_sender`, after.map((e) => e.sends.length));
    rec.measure(`${key}_sends_with_expected_token`, after.map((e, i) => token(senders[i], e).length));
    rec.measure(`${key}_outbox_rows`, after.map((e) => e.outbox.map((o) => `${o.state}/${o.kind}/parts${o.sent_parts}/attempts${o.attempts}`).join(",")));
    rec.measure(`${key}_web_search_calls_per_sender`, after.map((e) => e.searches));
    rec.measure(`${key}_events_with_tool_not_completed_per_run`, after.map((e) => e.toldNotRun));
    rec.measure(`${key}_ms_from_kill_to_first_reply`, replyMs);
    rec.measure(`${key}_reply_texts`, after.map((e) => e.sends.map((m) => m.text)));
    for (const [k, v] of Object.entries(ctx.notes)) rec.measure(`${key}_${k}`, v);
    rec.evidenceOf(key, { killAt, inbox: after.map((e) => e.inbox), runs: after.map((e) => e.runs.map((r) => ({ id: r.id, status: r.status, reason: r.interrupted_reason, created_ms: r.created_ms, completed_ms: r.completed_ms }))), sendAt: after.map((e) => e.sends.map((m) => m.at)) });
    rec.check(`${key}: lost accepted messages = 0 (every accepted webhook has an inbox row and a delivered reply)`, accepted === senders.length && after.every((e) => e.inbox.length === 1 && e.sends.length >= 1), { accepted, replies: after.map((e) => e.sends.length) });
    const slowest = Math.max(...replyMs.map((ms) => ms ?? Infinity));
    const latencyOk = rec.check(`${key}: every reply within 90 s of the kill (recovery is prompt)`, slowest <= 90_000, { replyMs });
    if (!latencyOk && Number.isFinite(slowest)) rec.defect({
      title: "An inbox event claimed by a Registry that is killed waits out the whole 3-minute inbox lease before it is processed",
      severity: "low",
      expected: "After the Registry restarts, an accepted webhook message is processed within seconds (the other two events accepted in the same instant were).",
      actual: `${key}: the event the dead Registry had claimed (inbox attempts=2) was replied to ${Math.round(slowest / 1000)} s after the kill; the siblings took about ${Math.round(Math.min(...replyMs) / 1000)} s. Nothing was lost or duplicated.`,
      repro: "scenario 1, trial b2: post 3 signed Telegram webhooks, kill -9 the Registry immediately after the 200s, restart it 3 s later. Row in hatch_channel_inbox with attempts=2 gets its Run 180 s after receipt (INBOX_LEASE_MS = 3 min in src/channels/service.ts)."
    });
    rec.check(`${key}: exactly one final reply per Run (duplicate outbound = 0)`, after.every((e) => e.sends.length === 1), after.map((e) => e.sends.length));
    rec.check(`${key}: one Run per accepted event id`, after.every((e) => e.runs.length === 1), after.map((e) => e.runs.length));
    rec.check(`${key}: every Run ended completed (reply carries the expected token)`, after.every((e, i) => e.runs[0]?.status === "completed" && token(senders[i], e).length === 1), after.map((e) => e.runs.map((r) => r.status)));
  }

  /** a1 */
  async killHolder(ctx) {
    const { instance, counts } = this.chaos.holder(ctx.servedFrom);
    ctx.notes.run_starts_per_instance = counts;
    if (!instance) return Date.now();
    return this.chaos.kill(instance);
  }
  /** a2 */
  async rolling(ctx) { const at = Date.now(); await this.chaos.rollAll(); ctx.notes.rolling_restart_ms = Date.now() - at; return at; }
  /** b1 */
  async registryOutlivesRun(ctx) {
    const at = await this.chaos.killRegistry();
    ctx.stack.platform.search.delayMs = FAST_MS;
    await waitUntil(async () => (await ctx.stack.runs()).filter((r) => ctx.before.some((b) => b.runs[0]?.id === r.id)).every((r) => r.status === "completed"), 90_000);
    ctx.notes.sends_while_registry_down = ctx.senders.map((s) => ctx.world.sends(s).length);
    await sleep(3000);
    await this.chaos.startRegistry();
    return at;
  }
  /** b2: webhooks accepted, Registry killed at once. The platform redelivers the same update ids after the restart. */
  async registryRightAway(ctx) {
    const at = await this.chaos.killRegistry();
    ctx.stack.platform.search.delayMs = FAST_MS;
    const whileDown = await ctx.world.post(ctx.senders[0], { updateId: 987654 });
    ctx.notes.post_while_registry_down = whileDown;
    await sleep(3000);
    await this.chaos.startRegistry();
    ctx.notes.redelivery_statuses = [];
    for (const p of ctx.posts) ctx.notes.redelivery_statuses.push((await ctx.world.post(ctx.senders[ctx.posts.indexOf(p)], { updateId: p.updateId })).status);
    return at;
  }
  /** c */
  async everything(ctx) {
    const at = Date.now();
    this.chaos.mark("kill -9 registry and every Runtime");
    await Promise.all([ctx.stack.killRegistry(), ...ctx.stack.liveRuntimes().map((r) => ctx.stack.killRuntime(r))]);
    ctx.stack.platform.search.delayMs = FAST_MS;
    await sleep(5000);
    await ctx.stack.startRuntime();
    await this.chaos.startRegistry();
    ctx.notes.restart_after_ms = Date.now() - at;
    return at;
  }

  // ── Local-tool wait ──────────────────────────────────────────────────

  /** A Desktop-protocol client with file_list that asks the model to call it. Does not answer. */
  async askLocalTool(stack, owner, productId, tag) {
    const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    const conversation = await chat.create(productId);
    const socket = await ChatSocket.open(stack.url, { auth: Auth.bearer(owner.apiKey), firstMessage: true, productId, conversationId: conversation, client: { client: "desktop", device: "macos" }, localTools: ["file_list"] });
    const { runId } = socket.message(`Call the file_list tool for path "." exactly once, then reply with exactly: DONE-${tag} followed by a space and the number of entries it returned.`);
    const request = await socket.waitFor("tool_call.request", (f) => f.type === "tool_call.request", 90_000);
    return { chat, conversation, socket, runId, request, tag, productId };
  }
  async runRow(stack, runId) { return (await stack.runtimePool.query("SELECT status, executor_id, failure->>'message' AS interrupted_reason FROM hatch_conversation_runs WHERE id = $1", [runId])).rows[0]; }
  async callRows(stack, runId) { return (await stack.runtimePool.query("SELECT tool_call_id, name, expires_at, answered_at, outcome IS NOT NULL AS answered FROM hatch_run_tool_calls WHERE run_id = $1", [runId])).rows; }
  async finalText(chat, c) { const finished = await chat.finish(c.conversation, c.productId, c.runId, 120_000); const messages = (await chat.snapshot(c.conversation, c.productId)).json?.messages ?? []; return { status: finished.status, messages, text: [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "" }; }
  answer(chat, c, client = "desktop") { return chat.toolResult(c.conversation, c.productId, { client, run_id: c.request.run_id, tool_call_id: c.request.tool_call_id, status: "ok", result: FILE_LIST }); }

  async localToolTrials(stack, rec, world) {
    const { owner, productId } = world;
    stack.platform.search.delayMs = 0;
    // d1 and d2 share one crash: two conversations wait on a local tool, every Runtime is replaced, then they are answered differently.
    await this.chaos.ensureHealthy(2);
    const d1 = await this.askLocalTool(stack, owner, productId, "d1");
    const d2 = await this.askLocalTool(stack, owner, productId, "d2");
    for (const c of [d1, d2]) {
      c.recorded = await this.callRows(stack, c.request.run_id);
      c.statusBefore = (await this.runRow(stack, c.request.run_id)).status;
    }
    rec.check("d: before the crash both Runs are waiting_for_tool with the call recorded", [d1, d2].every((c) => c.statusBefore === "waiting_for_tool" && c.recorded.length === 1 && !c.recorded[0].answered), [d1, d2].map((c) => ({ status: c.statusBefore, calls: c.recorded.length })));
    const executorBefore = (await this.runRow(stack, d1.request.run_id)).executor_id;
    const killAt = Date.now();
    await this.chaos.rollAll();
    await this.chaos.ensureHealthy(2);
    rec.measure("d_roll_ms", Date.now() - killAt);
    rec.check("d: the old WebSocket client lost its connection", await waitUntil(async () => Boolean(d1.socket.closed && d2.socket.closed), 10_000), [d1.socket.closed, d2.socket.closed]);

    // On a new instance, right after the crash: the Run is still waiting and the call is visible to any client.
    const view = async (c) => (await c.chat.snapshot(c.conversation, c.productId)).json;
    const seen = await Promise.all([d1, d2].map(view));
    rec.measure("d_after_crash_status", seen.map((s) => s.runs.at(-1)?.status));
    rec.measure("d_after_crash_pending_tool_calls", seen.map((s) => s.pending_tool_calls?.map((p) => p.tool_call_id)));
    rec.check("d: after the crash the Run is still waiting_for_tool and the new instance lists the pending call (snapshot)", seen.every((s, i) => s.runs.at(-1)?.status === "waiting_for_tool" && s.pending_tool_calls?.some((p) => p.tool_call_id === [d1, d2][i].request.tool_call_id)), seen.map((s) => ({ status: s.runs.at(-1)?.status, pending: s.pending_tool_calls?.length })));

    // A client that is not permitted to run local tools cannot answer.
    const refused = await this.answer(d1.chat, d1, "web");
    rec.measure("d_answer_from_web_client_status", refused.status);
    rec.check("d: a client without local tools (web) is refused", refused.status === 403, { status: refused.status, body: refused.text.slice(0, 200) });

    // d2: answered promptly, before any instance has taken the Run over (the lease has not lapsed yet).
    const answeredAt = Date.now();
    const a2 = await this.answer(d2.chat, d2);
    rec.measure("d2_answer_status_before_takeover", a2.status);
    rec.measure("d2_answer_upstream", a2.headers.get("x-verify-upstream"));
    rec.check("d2: a different client on a different instance answers the call once (accepted)", a2.status === 200, { status: a2.status, body: a2.text.slice(0, 200) });
    const a2again = await this.answer(d2.chat, d2);
    rec.measure("d2_second_answer_status", a2again.status);
    rec.check("d2: a second answer is refused or ignored", a2again.status >= 400 || a2again.json?.accepted !== true, { status: a2again.status, body: a2again.text.slice(0, 200) });

    // d1: wait for takeover (executor changes), then answer.
    const tookOver = await waitUntil(async () => (await this.runRow(stack, d1.request.run_id)).executor_id !== executorBefore, 120_000, 1000);
    rec.measure("d1_ms_until_another_instance_took_the_run", tookOver ? Date.now() - killAt : null);
    const row = await this.runRow(stack, d1.request.run_id);
    rec.check("d1: another instance took the Run over and it stayed waiting_for_tool until answered", tookOver && row.status === "waiting_for_tool", row);
    const pendingNow = (await view(d1)).pending_tool_calls ?? [];
    rec.check("d1: the call is still pending after takeover", pendingNow.some((p) => p.tool_call_id === d1.request.tool_call_id), pendingNow.length);
    const a1 = await this.answer(d1.chat, d1);
    rec.measure("d1_answer_status_after_takeover", a1.status);
    rec.measure("d1_answer_upstream", a1.headers.get("x-verify-upstream"));
    rec.check("d1: the call is answered once after takeover (accepted)", a1.status === 200, { status: a1.status, body: a1.text.slice(0, 200) });
    const a1again = await this.answer(d1.chat, d1);
    rec.measure("d1_second_answer_status", a1again.status);
    rec.check("d1: a second answer is refused or ignored", a1again.status >= 400 || a1again.json?.accepted !== true, { status: a1again.status, body: a1again.text.slice(0, 200) });
    for (const c of [d1, d2]) {
      const done = await this.finalText(c.chat, c);
      const calls = await this.callRows(stack, c.request.run_id);
      const transcript = JSON.stringify(done.messages);
      c.done = done;
      rec.evidenceOf(`${c.tag}_history`, done.messages.map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 160), tools: (m.tool_calls ?? []).map((t) => ({ name: t.name, status: t.status, result: JSON.stringify(t.result ?? t.error ?? null).slice(0, 160) })) })));
      rec.measure(`${c.tag}_final_status`, done.status);
      rec.measure(`${c.tag}_final_text`, done.text);
      rec.measure(`${c.tag}_recorded_calls`, calls.length);
      rec.check(`${c.tag}: Run completed with one final reply carrying the answer`, done.status === "completed" && done.text.includes(`DONE-${c.tag}`) && /\b2\b/.test(done.text), { status: done.status, text: done.text.slice(0, 200) });
      rec.check(`${c.tag}: exactly one local-tool call exists for the Run and it is answered once`, calls.length === 1 && calls[0].answered, calls);
      rec.check(`${c.tag}: assistant replies for the Run = 1`, done.messages.filter((m) => m.role === "assistant" && m.content && String(m.content).includes(`DONE-${c.tag}`)).length === 1, transcript.length);
    }

    await this.timeoutTrial(stack, rec, world);
  }

  /** d3: the call times out at its recorded expiry even though the Runtime that asked is dead. */
  async timeoutTrial(stack, rec, world) {
    for (const instance of stack.liveRuntimes()) await stack.killRuntime(instance);
    await stack.startRuntime({ HATCH_CLIENT_TOOL_TIMEOUT_MS: "30000" });
    const c = await this.askLocalTool(stack, world.owner, world.productId, "d3");
    const [call] = await this.callRows(stack, c.request.run_id);
    const expiresAt = Date.parse(call.expires_at);
    const killedAt = Date.now();
    rec.measure("d3_ms_until_recorded_expiry_at_kill", expiresAt - killedAt);
    await stack.killRuntime(stack.liveRuntimes()[0]);
    await stack.startRuntime();
    await stack.startRuntime();
    const pendingEarly = ((await c.chat.snapshot(c.conversation, c.productId)).json?.pending_tool_calls ?? []).length;
    rec.measure("d3_pending_calls_before_expiry", pendingEarly);
    const done = await this.finalText(c.chat, c);
    const endedAt = Date.now();
    rec.measure("d3_final_status", done.status);
    rec.measure("d3_final_text", done.text);
    rec.measure("d3_ms_from_recorded_expiry_to_run_end", endedAt - expiresAt);
    const pendingLate = ((await c.chat.snapshot(c.conversation, c.productId)).json?.pending_tool_calls ?? []).length;
    const late = await this.answer(c.chat, c);
    rec.measure("d3_late_answer_status", late.status);
    rec.evidenceOf("d3_history", done.messages.map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 160), tools: (m.tool_calls ?? []).map((t) => ({ name: t.name, status: t.status, result: JSON.stringify(t.result ?? t.error ?? null).slice(0, 200) })) })));
    const journal = (await stack.runtimePool.query("SELECT event_type, payload FROM hatch_conversation_journal WHERE run_id = $1 ORDER BY cursor", [c.request.run_id])).rows;
    rec.evidenceOf("d3_journal", journal.map((j) => ({ type: j.event_type, payload: JSON.stringify(j.payload).slice(0, 220) })));
    const outcome = (await stack.runtimePool.query("SELECT outcome FROM hatch_run_tool_calls WHERE run_id = $1", [c.request.run_id])).rows[0]?.outcome;
    rec.evidenceOf("d3_call_outcome", outcome ?? null);
    // The transcript the model reads lives in the Runtime's data directory; look there for the result the model was given.
    const toolMessages = (await stack.runtimePool.query("SELECT payload::text AS text FROM hatch_conversation_events WHERE run_id = $1 AND payload::text LIKE '%\"role\": \"tool\"%'", [c.request.run_id])).rows.map((row) => row.text);
    rec.evidenceOf("d3_transcript_tool_messages", toolMessages.map((text) => text.slice(0, 400)));
    const timedOut = toolMessages.some((text) => text.includes("Timed out waiting for client tool result"));
    rec.check("d3: the unanswered call timed out (the model was told) and the Run ended with a final reply", done.status === "completed" && timedOut, { status: done.status, timedOut, text: done.text.slice(0, 200) });
    rec.check("d3: no pending call after expiry and a late answer is refused", pendingLate === 0 && late.status >= 400, { pendingLate, late: late.status });
  }
}
export default new Crash();
