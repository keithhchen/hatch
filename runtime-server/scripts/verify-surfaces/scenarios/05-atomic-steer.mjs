import { randomUUID } from "node:crypto";
import { Scenario } from "../lib/scenario.mjs";
import { Auth, ChatApi, ChatSocket, StudioApi } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";
import { ACTIVE, ConversationEvidence, Maxima, postWebhook, tally } from "../lib/idem-helpers.mjs";
import { percentile, sleep, until } from "../lib/util.mjs";

const SYSTEM = "You are a terse test responder. Answer each message with as few words as possible. When several messages are waiting, answer every one of them.";
const TRIALS = Number(process.env.STEER_TRIALS ?? 36);
const PARALLEL = 4;
const IM_BURSTS = Number(process.env.STEER_IM_BURSTS ?? 6);
/** Offsets from the trigger, in ms. In `delta` mode the trigger is the first answer text of the first Run (its end follows within milliseconds); in `timed` mode it is the median Run length measured at the start, so offsets are relative to the expected end. */
const DELTA_OFFSETS = [0, 5, 15, 30, 60, 120];
const TIMED_OFFSETS = [-400, -200, -100, -40, 0, 40, 100, 200];
const BUCKETS = [[-Infinity, -500], [-500, -100], [-100, -20], [-20, 0], [0, 20], [20, 100], [100, 500], [500, Infinity]];
const bucketOf = (ms) => { const b = BUCKETS.find(([lo, hi]) => ms >= lo && ms < hi); return `${b[0] === -Infinity ? "<" : b[0]}..${b[1] === Infinity ? ">" : b[1]}ms`; };

/** One message of a burst and everything the client saw of it. */
class Sent {
  constructor(via, key, text) { this.via = via; this.key = key; this.text = text; this.firedAt = undefined; this.signal = undefined; this.code = undefined; this.outcome = undefined; }
  get accepted() { return this.signal === "accepted"; }
}

class AtomicSteer extends Scenario {
  constructor() { super({ id: 5, title: "Atomic steer: messages raced at the moment a Run ends; IM bursts" }); }

  async run(stack, rec) {
    this.stack = stack; this.rec = rec;
    this.ev = new ConversationEvidence(stack.runtimePool);
    this.owner = await stack.account("owner");
    this.productId = await stack.product(this.owner, { system: SYSTEM });
    this.chat = new ChatApi(stack.url, Auth.bearer(this.owner.apiKey));
    this.medianRunMs = await this.calibrate();
    rec.measure("calibration_median_run_ms", this.medianRunMs);
    const plans = Array.from({ length: TRIALS }, (_, i) => i % 2 === 0
      ? { mode: "delta", offset: DELTA_OFFSETS[(i / 2) % DELTA_OFFSETS.length | 0] }
      : { mode: "timed", offset: TIMED_OFFSETS[((i - 1) / 2) % TIMED_OFFSETS.length | 0] });
    const results = [];
    for (let i = 0; i < plans.length; i += PARALLEL) results.push(...await Promise.all(plans.slice(i, i + PARALLEL).map((plan, j) => this.trial(i + j, plan))));
    this.summarize(results);
    const logLines = stack.runtimes.flatMap((r) => r.proc.output.split("\n")).filter((line) => /error|fail|steer|unhandled/i.test(line)).map((line) => line.slice(0, 300));
    rec.evidenceOf("runtime_log_error_lines", { count: logLines.length, first: logLines.slice(0, 25), last: logLines.slice(-10) });
    await this.imBursts();
    await this.assistantSteer();
  }

  /** The Assistant is a conversation on Chat's runtime: a message sent while its Run goes joins that Run, and nothing is lost. */
  async assistantSteer() {
    const { stack, rec } = this;
    const account = await stack.account("steer-assistant");
    const studio = new StudioApi(stack.url, Auth.bearer(account.session));
    const one = `ASTEER-${randomUUID().slice(0, 6)}`, two = `BSTEER-${randomUUID().slice(0, 6)}`;
    const first = await studio.sendAssistant({ content: `Write the word ${one}, then the integers 1 to 40, one per line. Nothing else.` });
    await until("the Assistant's Run is running", async () => (await studio.messagesAssistant()).json?.status === "running" || undefined, { timeoutMs: 30_000, everyMs: 50 }).catch(() => undefined);
    const second = await studio.sendAssistant({ content: `Also write the word ${two} at the very end.` });
    await until("the Assistant is idle", async () => { const { json } = await studio.messagesAssistant(); return json?.status === "idle" && json.messages?.some((m) => m.role === "assistant") || undefined; }, { timeoutMs: 180_000, everyMs: 500 });
    await sleep(2_000);
    const { json } = await studio.messagesAssistant();
    const users = (json?.messages ?? []).filter((m) => m.role === "user");
    const replies = (json?.messages ?? []).filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
    const runs = (await stack.registryPool.query("SELECT status, steered_count, consumed_count FROM hatch_conversation_runs WHERE conversation_id = $1", [`conversation:assistant:${account.id}`])).rows;
    rec.measure("assistant_steer_runs", runs);
    rec.measure("assistant_steer_second_joined_first", second.json?.run_id === first.json?.run_id);
    rec.check("Assistant: both messages are stored once, in order", users.length === 2 && users[0].text.includes(one) && users[1].text.includes(two), users.map((m) => m.text.slice(0, 40)));
    rec.check("Assistant: the second message was accepted as sent while the first Run went (joined it, or started the next Run), never rejected", [200, 202].includes(second.status), second.status);
    rec.check("Assistant: every Run ended completed, with no message left unclaimed", runs.length > 0 && runs.every((r) => r.status === "completed" && r.consumed_count === r.steered_count), runs);
    rec.check("Assistant: the second message was answered", replies.includes(two), replies.slice(-200));
  }

  /** Three single-message Runs, to learn how long a short answer takes. */
  async calibrate() {
    const durations = [];
    for (let i = 0; i < 3; i++) {
      const conv = await this.chat.create(this.productId);
      const sent = await this.chat.send(conv, this.productId, { content: `Reply with exactly the word: cal${i}`, wait: 90 });
      const run = sent.json?.run; if (run?.started_at && run?.completed_at) durations.push(Date.parse(run.completed_at) - Date.parse(run.started_at));
    }
    return percentile(durations, 50) ?? 2500;
  }

  // ── one trial ─────────────────────────────────────────────────────────

  async trial(index, plan) {
    const { stack, chat, productId } = this;
    const conv = await chat.create(productId);
    const id = await this.ev.idOf({ publicId: conv });
    const active = new Maxima(async () => Number((await stack.runtimePool.query("SELECT count(*) AS n FROM hatch_conversation_runs WHERE conversation_id = $1 AND status = ANY($2)", [id, ACTIVE])).rows[0].n));
    const ws = await ChatSocket.open(stack.url, { auth: Auth.bearer(this.owner.apiKey), firstMessage: true, productId, conversationId: conv });
    const first = new Sent("http", randomUUID(), `Reply with exactly the word: t${index}m0`);
    const startedAt = Date.now();
    const firstAnswer = await chat.send(conv, productId, { key: first.key, content: first.text });
    first.firedAt = startedAt; first.signal = [200, 202].includes(firstAnswer.status) ? "accepted" : "rejected"; first.outcome = firstAnswer.json?.outcome;
    const firstRun = firstAnswer.json?.run_id ?? firstAnswer.json?.run?.id;
    // The trigger.
    if (plan.mode === "delta") {
      await ws.waitFor("first answer text", (f) => f.type === "assistant.delta" && f.delta?.kind === "text" && f.run_id === firstRun, 60_000).catch(() => undefined);
      if (plan.offset > 0) await sleep(plan.offset);
    } else {
      const wait = startedAt + this.medianRunMs + plan.offset - Date.now();
      if (wait > 0) await sleep(wait);
    }
    // The burst: two over HTTP and one over the socket, in the same tick.
    const burst = [new Sent("http", randomUUID(), `Reply with exactly the word: t${index}m1`), new Sent("ws", randomUUID(), `Reply with exactly the word: t${index}m2`), new Sent("http", randomUUID(), `Reply with exactly the word: t${index}m3`)];
    const fire = burst.map((message) => async () => {
      message.firedAt = Date.now();
      if (message.via === "ws") { message.runId = ws.message(message.text, { key: message.key }).runId; return; }
      const answer = await chat.send(conv, productId, { key: message.key, content: message.text });
      message.httpStatus = answer.status; message.outcome = answer.json?.outcome; message.code = answer.json?.error?.code; message.errorMessage = answer.json?.error?.message;
      message.signal = [200, 202].includes(answer.status) ? "accepted" : "rejected";
    });
    await Promise.all(fire.map((go) => go()));
    await sleep(300);
    for (const message of burst.filter((m) => m.via === "ws")) {
      const accepted = ws.frames.find((f) => f.type === "message.accepted" && f.client_message_id === message.key);
      const failed = ws.frames.find((f) => f.type === "turn.failed" && f.run_id === message.runId);
      message.signal = accepted ? "accepted" : failed ? "rejected" : undefined; message.code = failed?.error?.code;
    }
    let runs;
    try { runs = await this.ev.quiesce(id, 120_000); } catch (error) { runs = await this.ev.runs(id); }
    const maxActive = await active.stop();
    ws.close();
    return this.inspect(index, plan, id, [first, ...burst], runs, maxActive, ws);
  }

  /** What the database holds, against what each client was told. */
  async inspect(index, plan, id, messages, runs, maxActive, ws) {
    const journal = await this.ev.journalUsers(id);
    const users = await this.ev.modelUsers(id);
    const replies = await this.ev.modelReplies(id);
    const consumed = await this.ev.consumed(id);
    /** The moment the race is about: the first Run's first answer is complete. Before it the model has not looked at the next message; after it the Run is ending or ended. */
    const endedAt = replies[0]?.created_at ? Date.parse(replies[0].created_at) : undefined;
    const acceptedAt = async (key) => (await this.stack.runtimePool.query("SELECT created_at FROM hatch_conversation_journal WHERE conversation_id = $1 AND event_type = 'message.created' AND payload->>'client_message_id' = $2 AND payload->>'role' = 'user'", [id, key])).rows[0]?.created_at;
    const rows = [];
    for (const message of messages) {
      const inJournal = journal.filter((j) => j.key === message.key);
      const inModel = users.filter((u) => u.content === message.text);
      const model = inModel[0];
      const answeredAfter = model ? replies.filter((r) => r.run_id === model.run_id && Number(r.id) > Number(model.id)) : [];
      const run = model ? runs.find((r) => r.id === model.run_id) : undefined;
      const token = message.text.split(": ").at(-1);
      const at = await acceptedAt(message.key);
      rows.push({
        message, journal: inJournal.length, model: inModel.length, steered: inJournal[0]?.steered === "true", run: model?.run_id, runStatus: run?.status,
        addressed: Boolean(model && run?.status === "completed" && answeredAfter.length), tokenInReply: answeredAfter.some((r) => (r.content ?? "").includes(token)),
        acceptDeltaMs: at && endedAt ? Date.parse(at) - endedAt : undefined, fireDeltaMs: endedAt && message.firedAt ? message.firedAt - endedAt : undefined
      });
    }
    const overlaps = []; for (let i = 1; i < runs.length; i++) { const prev = runs[i - 1], cur = runs[i]; if (prev.completed_at && Date.parse(cur.created_at) < Date.parse(prev.completed_at)) overlaps.push(Date.parse(prev.completed_at) - Date.parse(cur.created_at)); }
    const anomalous = rows.some((r) => (r.message.accepted && (r.journal !== 1 || r.model !== 1 || !r.addressed)) || r.message.code === "conversation_request_failed") || runs.some((r) => ["failed", "interrupted"].includes(r.status) || r.consumed_count < r.steered_count);
    const dump = anomalous ? await this.ev.dump(id) : undefined;
    const deadlockRun = Boolean(dump?.journal.some((line) => /deadlock/i.test(line)));
    const sendErrors = rows.filter((r) => r.message.errorMessage).map((r) => ({ text: r.message.text.split(": ").at(-1), http: r.message.httpStatus, code: r.message.code, error: r.message.errorMessage }));
    return { index, plan, id, dump, deadlockRun, sendErrors, runs, rows, maxActive, overlaps, consumed: consumed.length, steeredRuns: runs.filter((r) => r.steered_count > 0).length, unconsumed: runs.filter((r) => r.consumed_count < r.steered_count).length, replies: replies.length };
  }

  // ── what the trials say ───────────────────────────────────────────────

  summarize(trials) {
    const { rec } = this;
    const rows = trials.flatMap((t) => t.rows.map((r) => ({ ...r, trial: t.index })));
    const acked = rows.filter((r) => r.message.accepted);
    const lost = acked.filter((r) => r.journal !== 1 || r.model !== 1 || !r.addressed);
    const silent = rows.filter((r) => r.message.via === "ws" && !r.message.signal && !(r.journal === 1));
    const doubled = rows.filter((r) => r.journal > 1 || r.model > 1);
    const rejections = tally(rows.filter((r) => r.message.signal === "rejected"), (r) => r.message.code ?? "unknown");
    const burstRows = rows.filter((r) => r.message.firedAt && !r.message.text.endsWith("m0"));
    const busy = burstRows.filter((r) => r.message.code === "conversation_busy").length;
    const runsPerTrial = tally(trials, (t) => t.runs.length);
    const outcomes = tally(burstRows.filter((r) => r.journal === 1), (r) => (r.steered ? "steered" : r.message.outcome ?? "started"));
    const byBucket = {};
    for (const r of burstRows.filter((row) => row.acceptDeltaMs !== undefined)) { const key = bucketOf(r.acceptDeltaMs); (byBucket[key] ??= { steered: 0, started: 0 }); byBucket[key][r.steered ? "steered" : "started"] += 1; }
    const maxActive = Math.max(...trials.map((t) => t.maxActive.max));
    const failedRuns = trials.flatMap((t) => t.runs.filter((r) => ["failed", "interrupted", "cancelled"].includes(r.status)).map((r) => ({ trial: t.index, run: r.id, status: r.status, reason: r.interrupted_reason })));
    const stuck = trials.flatMap((t) => t.runs.filter((r) => !["completed", "failed", "cancelled", "interrupted"].includes(r.status)).map((r) => ({ trial: t.index, run: r.id, status: r.status })));
    const overlapTrials = trials.filter((t) => t.overlaps.length);
    const tokenMissing = burstRows.filter((r) => r.addressed && !r.tokenInReply).length;
    rec.measure("trials", trials.length);
    rec.measure("trial_modes", tally(trials, (t) => t.plan.mode));
    rec.measure("messages_total", rows.length);
    rec.measure("burst_messages", burstRows.length);
    rec.measure("accepted_by_client_signal", acked.length);
    rec.measure("lost", lost.length);
    rec.measure("silent_ws_messages_without_ack_or_row", silent.length);
    rec.measure("stored_more_than_once", doubled.length);
    rec.measure("rejections_by_code", rejections);
    rec.measure("conversation_busy_rate", { busy, of: burstRows.length, rate: Number((busy / Math.max(1, burstRows.length)).toFixed(3)) });
    rec.measure("burst_outcomes_by_database", outcomes);
    rec.measure("burst_accept_time_relative_to_first_run_end", byBucket);
    rec.measure("runs_per_trial_distribution", runsPerTrial);
    rec.measure("max_active_runs_polled_per_conversation", maxActive);
    rec.measure("poll_samples_total", trials.reduce((s, t) => s + t.maxActive.samples, 0));
    rec.measure("run_overlap_trials", overlapTrials.map((t) => ({ trial: t.index, overlapsMs: t.overlaps })));
    rec.measure("steered_runs", trials.reduce((s, t) => s + t.steeredRuns, 0));
    rec.measure("runs_with_unclaimed_steer_at_end", trials.reduce((s, t) => s + t.unconsumed, 0));
    rec.measure("burst_messages_whose_reply_lacks_their_token_soft", tokenMissing);
    rec.measure("failed_or_interrupted_runs", failedRuns);
    rec.measure("trial_conversations", trials.slice(0, 40).map((t) => ({ trial: t.index, mode: t.plan.mode, offset: t.plan.offset, conversation: t.id, runs: t.runs.map((r) => r.id) })));
    for (const t of trials.filter((x) => x.dump)) rec.evidenceOf(`anomaly_trial_${t.index}`, { plan: t.plan, conversation: t.id, messages: t.rows.map((r) => ({ text: r.message.text.split(": ").at(-1), via: r.message.via, signal: r.message.signal, http: r.message.httpStatus, code: r.message.code, error: r.message.errorMessage, journal: r.journal, model: r.model, run: r.run?.slice(4, 10), runStatus: r.runStatus, steered: r.steered, addressed: r.addressed, acceptDeltaMs: r.acceptDeltaMs })), ...t.dump });
    rec.evidenceOf("lost_messages", lost.map((r) => ({ trial: r.trial, text: r.message.text, journal: r.journal, model: r.model, run: r.run, runStatus: r.runStatus, addressed: r.addressed })));
    rec.check("lost = 0: every accepted message is stored once, reached the model once, and was answered inside a completed Run", lost.length === 0, lost.slice(0, 5).map((r) => ({ trial: r.trial, text: r.message.text, journal: r.journal, model: r.model, status: r.runStatus, addressed: r.addressed })));
    rec.check("no client was left without an answer: a message is accepted, rejected with a code, or at least stored", silent.length === 0, silent.slice(0, 5).map((r) => r.message.text));
    rec.check("no message was stored twice", doubled.length === 0, doubled.slice(0, 5).map((r) => r.message.text));
    rec.check("active Runs per conversation never above 1 (polled every 25 ms)", maxActive <= 1, { maxActive });
    rec.check("no Runs overlap in time within a conversation (created before the previous one completed)", overlapTrials.length === 0, overlapTrials.map((t) => t.overlaps));
    rec.check("every Run reached a terminal state", stuck.length === 0, stuck);
    rec.check("no Run ended failed or interrupted", failedRuns.length === 0, failedRuns);
    rec.check("no Run ended with a steered message unclaimed", trials.every((t) => t.unconsumed === 0), trials.filter((t) => t.unconsumed).map((t) => t.index));
    rec.check("only documented rejections (conversation_busy) occurred", Object.keys(rejections).every((code) => code === "conversation_busy"), rejections);
    if (busy) rec.note(`conversation_busy refused ${busy} of ${burstRows.length} burst messages. It is documented (a stopping Run), but each is a user-visible refusal at the moment a Run ends.`);
    const deadlockRuns = trials.filter((t) => t.deadlockRun);
    const sendErrors = trials.flatMap((t) => t.sendErrors.map((e) => ({ trial: t.index, ...e })));
    rec.measure("runs_failed_by_deadlock", deadlockRuns.map((t) => ({ trial: t.index, conversation: t.id, unclaimedMessages: t.runs.reduce((s, r) => s + (r.steered_count - r.consumed_count), 0) })));
    rec.measure("send_errors", sendErrors);
    if (deadlockRuns.length) rec.defect({ title: "Steering a message at the end of a Run deadlocks the database: the Run fails and the accepted messages are never answered", severity: "high", expected: "Claiming a steered message and appending it to the transcript is one transaction that cannot deadlock with a steer (spec: the steer-or-start decision is atomic; no accepted message is lost).", actual: `${deadlockRuns.length} of ${trials.length} trials: the Run was failed with "deadlock detected" while ${deadlockRuns.reduce((s, t) => s + t.runs.reduce((n, r) => n + (r.steered_count - r.consumed_count), 0), 0)} messages that had been accepted as steered (HTTP 200/202, journaled) were still unclaimed; they never reached the model. Likely cause by lock order: steerOrReplay locks the conversation row (FOR UPDATE) then updates the Run row; claimSteeredMessages locks the Run row (FOR UPDATE) then inserts a journal row, which takes a FOR KEY SHARE lock on the conversation row.`, repro: "Scenario 5: send a first short message, then 3 messages (two HTTP, one WebSocket) at the moment its answer completes; about 1 trial in 36 deadlocks. Evidence ids: anomaly_trial_* in results/scenario-05.json." });
    if (sendErrors.some((e) => e.http >= 500)) rec.defect({ title: "A message sent at the end of a Run is refused with HTTP 500 \"deadlock detected\" (internal database error shown to the client)", severity: "medium", expected: "A 2xx acceptance, or a documented 4xx such as conversation_busy; never an internal 500.", actual: JSON.stringify(sendErrors.slice(0, 3)), repro: "Same as the deadlock above: the steering transaction is the deadlock victim." });
    if (lost.length) rec.defect({ title: "A message accepted around the end of a Run was lost", severity: "high", expected: "Every accepted message is in the transcript once and answered (spec: steer-or-start is atomic).", actual: `${lost.length} of ${acked.length} accepted messages: ${JSON.stringify(lost.slice(0, 3).map((r) => ({ trial: r.trial, text: r.message.text, journal: r.journal, model: r.model, status: r.runStatus })))}`, repro: "scenario 5, STEER_TRIALS=36" });
    if (maxActive > 1 || overlapTrials.length) rec.defect({ title: "More than one active Run in a conversation", severity: "high", expected: "At most one active Run per conversation.", actual: `max active ${maxActive}; overlapping Run intervals in ${overlapTrials.length} trials`, repro: "scenario 5" });
  }

  // ── IM burst ──────────────────────────────────────────────────────────

  async imBursts() {
    const { stack, rec } = this;
    const connection = await stack.connection({ owner: this.owner, audience: "org", productId: this.productId });
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const bursts = [];
    for (let n = 0; n < IM_BURSTS; n++) {
      const chat = 8100 + n; await stack.admit(connection, { senderId: String(chat) });
      const tokens = Array.from({ length: 5 }, (_, k) => `im${n}x${k}`);
      const started = Date.now();
      await Promise.all(tokens.map(async (token, k) => { await sleep(k * 70); return postWebhook(hooks, hooks.message({ chatId: chat, text: `Reply with exactly the word: ${token}` })); }));
      const posted = Date.now() - started;
      await until(`burst ${n} answered`, async () => { const inbox = (await stack.registryPool.query("SELECT state, replied_at FROM hatch_channel_inbox WHERE thread_id = $1", [String(chat)])).rows; return inbox.length === 5 && inbox.every((r) => r.state === "done") && inbox.every((r) => r.replied_at); }, { timeoutMs: 150_000, everyMs: 500 }).catch(() => undefined);
      await sleep(7000);
      bursts.push(await this.imBurstResult(n, chat, tokens, posted));
    }
    const dist = tally(bursts, (b) => b.finalReplies);
    rec.measure("im_bursts", bursts);
    rec.measure("im_final_replies_per_burst_distribution", dist);
    rec.measure("im_runs_per_burst_distribution", tally(bursts, (b) => b.runs));
    rec.check("IM: every message of every burst was stored once (5 inbox rows)", bursts.every((b) => b.inboxRows === 5), bursts.map((b) => b.inboxRows));
    rec.check("IM: every message was marked answered and sits in a Run that ended", bursts.every((b) => b.unanswered === 0), bursts.map((b) => b.unanswered));
    rec.check("IM: no Run got more than one final reply", bursts.every((b) => b.maxRepliesPerRun <= 1), bursts.map((b) => b.maxRepliesPerRun));
    rec.check("IM: replies sent never exceed Runs, and every Run is answered", bursts.every((b) => b.finalReplies === b.runs), bursts.map((b) => [b.runs, b.finalReplies]));
    rec.check("IM: every message token is answered by some reply (soft: model dependent)", bursts.every((b) => b.tokensMissingFromReplies.length === 0), bursts.map((b) => b.tokensMissingFromReplies));
    rec.note(`IM: ${IM_BURSTS} bursts of 5 messages from one sender 70 ms apart (about 280 ms in all). Final replies per burst: ${JSON.stringify(dist)}.`);
  }

  async imBurstResult(n, chat, tokens, postedMs) {
    const { stack } = this;
    const inbox = (await stack.registryPool.query("SELECT event_id, state, run_id, replied_at FROM hatch_channel_inbox WHERE thread_id = $1 ORDER BY seq", [String(chat)])).rows;
    const outbox = (await stack.registryPool.query("SELECT state, source_key, attempts FROM hatch_channel_outbox WHERE thread_id = $1 ORDER BY seq", [String(chat)])).rows;
    const runIds = [...new Set(inbox.map((r) => r.run_id).filter(Boolean))];
    const conversation = runIds[0] ? await this.ev.idOf({ runId: runIds[0] }) : undefined;
    const runs = conversation ? await this.ev.runs(conversation) : [];
    const users = conversation ? await this.ev.modelUsers(conversation) : [];
    const sent = stack.platform.calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chat && c.delivered);
    const perRun = tally(outbox.filter((o) => o.source_key?.startsWith("run:")), (o) => o.source_key);
    const texts = sent.map((c) => c.body.text);
    return {
      burst: n, postedMs, inboxRows: inbox.length, inboxStates: tally(inbox, (r) => r.state), runs: runs.length, runStatuses: tally(runs, (r) => r.status), runsFromInbox: runIds.length,
      messagesPerRun: tally(inbox, (r) => r.run_id ?? "none"), userTurnsSeenByModel: users.length, finalReplies: sent.length, outboxStates: tally(outbox, (o) => o.state), maxRepliesPerRun: Math.max(0, ...Object.values(perRun)),
      unanswered: inbox.filter((r) => !r.replied_at).length + runs.filter((r) => r.status !== "completed").length,
      tokensMissingFromReplies: tokens.filter((token) => !texts.some((text) => text.includes(token))), replies: texts.map((t) => t.slice(0, 80)), runIds
    };
  }
}
export default new AtomicSteer();
