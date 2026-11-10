import { Scenario } from "../lib/scenario.mjs";
import { ChatApi, Auth } from "../lib/clients.mjs";
import { TelegramWebhooks } from "../lib/webhooks.mjs";
import { CompactionProbe, StatusWatcher, Grower, MAX_CHUNK, TRIGGER, chunk, estimate } from "../lib/compaction-helpers.mjs";
import { sleep, until } from "../lib/util.mjs";

const SYSTEM = "You are the Order Support Expert for a parcel business. Follow the user's reply-format instructions exactly. Otherwise answer in at most three short sentences. Never use tools or files: always answer directly in the chat.";
const FACTS = { order: "ORD-48213", person: "Marta Kowalczyk", email: "priya.raman@example.com", path: "/srv/exports/q3/refunds-2026-10.csv", tracking: "1Z999AA10123456784", shipment: "SHP-77190", ticket: "TCK-5521" };
const ITEMS = [["order", FACTS.order], ["person", FACTS.person], ["email", FACTS.email], ["path", FACTS.path], ["tracking", FACTS.tracking], ["shipment", FACTS.shipment], ["ticket", FACTS.ticket]];
const FIRST = `Hi, I'm ${FACTS.person}, support lead. Order ${FACTS.order} for customer Priya Raman (${FACTS.email}) is stuck; its shipment is ${FACTS.shipment}, tracking ${FACTS.tracking}, ticket ${FACTS.ticket}. The refund export lives at ${FACTS.path}. `
  + "Next, after I send you the refund table, I want you to compute the total refund amount and the number of rows per region. Do not do that yet. Reply with exactly: noted";
const RECALL = `Compaction check. Using only this conversation, list verbatim: the order number, the customer email, the tracking number, the export file path, my name, the shipment and ticket ids. Then here is the refund table I promised:\nregion,amount\nNorth,120\nSouth,80\nNorth,50\nEast,30\nNow carry out the request I told you about earlier and give the result as one line: TOTAL=<n> ROWS North=<n> South=<n> East=<n>`;
const NOTICE = /正在整理对话/;

const present = (text, items) => Object.fromEntries(items.map(([name, value]) => [name, text.toLowerCase().includes(value.toLowerCase())]));
const countTrue = (flags) => Object.values(flags).filter(Boolean).length;
const lastCompleted = async (probe, conversationId) => (await probe.journal(conversationId)).filter((e) => e.type === "compaction.completed").at(-1);

class Compaction extends Scenario {
  constructor() { super({ id: 10, title: "Compaction: long real conversation, survival, background cost, preemption, one IM notice", stackOptions: { llmProfile: "kimi-k2.6-no-thinking", registryEnv: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" } } }); }

  async run(stack, rec) {
    if (!process.env.LLM_API_KEY) rec.block("LLM_API_KEY (Kimi) is not set: compaction and this profile need it");
    rec.note(`The summarize trigger derives from Kimi K2.6's 262,144-token window (${TRIGGER} estimated tokens, chars/4) and no env var overrides it, so the conversation really is that large. Padding text is long runs of '=' (the product counts chars/4, Kimi far fewer real tokens) to keep the run affordable; this changes only how cheaply the trigger is reached. Stack option: registryEnv HATCH_FACTORY_LLM_PROFILE=kimi-k2.6, because the Registry rejects the Runtime-only profile name kimi-k2.6-no-thinking.`);
    rec.note("Observed while building this (not reproduced by the final steps): asking Kimi for a 450-word text on Chat HTTP failed the Run with reason \"file_write is not available on mcp. Available on: desktop, cli.\"; the Run ended `failed` after streaming the text instead of the model getting a tool error. The numbered-list reply used here avoids it.");
    rec.note("Prune stage (old tool results after the provider cache expires) and the failure/timeout (degraded) path are NOT exercised: no tool is called here, and the summarizer shares the chat model's provider config, so no env fails only the compaction call.");
    const probe = new CompactionProbe(stack.runtimePool);
    const parts = (process.env.VERIFY_PARTS ?? "A,B,C").split(",");
    const owner = await stack.account("owner");
    const productId = await stack.product(owner, { name: "Order Support Expert", system: SYSTEM });
    const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    const conversation = await chat.create(productId);
    const send = async (content) => {
      const response = await chat.send(conversation, productId, { content, wait: 240 });
      if (response.status !== 200) throw new Error(`send failed: ${response.status} ${response.text.slice(0, 200)}`);
      if (!response.json?.reply) {
        const id = response.json?.run?.id;
        const journal = (await stack.runtimePool.query("SELECT event_type, left(payload::text, 400) AS p FROM hatch_conversation_journal WHERE run_id = $1 ORDER BY cursor", [id])).rows;
        const events = (await stack.runtimePool.query("SELECT event_type, left(payload::text, 600) AS p FROM hatch_conversation_events WHERE run_id = $1 AND event_type NOT IN ('message.created') ORDER BY id", [id])).rows;
        const run = (await stack.runtimePool.query("SELECT status, interrupted_reason FROM hatch_conversation_runs WHERE id = $1", [id])).rows;
        rec.evidenceOf("failed_run_debug", { run, journal, events });
      }
      if (!response.json?.reply) throw new Error(`empty reply: ${JSON.stringify({ ...response.json, run: { ...response.json?.run, partial_output: String(response.json?.run?.partial_output ?? "").length } }).slice(0, 900)}`);
      return response.json.reply;
    };
    const state = { conversation, productId, chat, grower: new Grower(send) };
    if (parts.includes("A")) await this.survival(rec, probe, state);
    if (parts.includes("B")) await this.preemption(rec, probe, state);
    if (parts.includes("C")) await this.imNotice(stack, rec, probe, owner, productId);
  }

  async conversationId(probe, publicId) { return (await probe.conversationIds()).find((c) => c.public_id === publicId || c.id === publicId)?.id; }

  // ── (1) identifiers and the unfinished request survive; (2) background compaction adds no reply wait ──
  async survival(rec, probe, state) {
    const { grower, chat, conversation, productId } = state;
    const first = await grower.say(FIRST, "first");
    rec.check("first turn answered", /noted/i.test(first.reply), first.reply.slice(0, 200));
    for (let i = 1; i <= 2; i++) await grower.say(`Carrier log A${i}, reference only; reply with exactly: logged\n${chunk(MAX_CHUNK, `A${i}`)}`, `pad-${i}`);
    const control = await grower.longReplyTurn("control-long-reply", "A-control");
    const crossing = await grower.crossTrigger("A");
    const internalId = await this.conversationId(probe, conversation);
    const started = await probe.nextStarted(internalId, 0, 3_000);
    const run = (await probe.runsOf(internalId)).at(-1);
    rec.measure("tracked_tokens_at_crossing_end", grower.tokens);
    rec.evidenceOf("turns_label_tokens_ms_replychars", grower.turns.map((t) => [t.label, t.tokens, t.ms, t.reply.length]));
    rec.measure("reply_ms", { pad_short_reply_at_125k: grower.turns.filter((t) => t.label === "pad-2").map((t) => t.ms)[0], control_long_reply_at_126k: control.ms, crossing_long_reply_at_219k: crossing.ms });
    if (!rec.check("a compaction started once the conversation went over the limit", Boolean(started), { tracked: grower.tokens, trigger: TRIGGER })) return;
    rec.check("it ran after the reply (phase background), started after the Run completed", started.payload.phase === "background" && started.at >= Number(run.completed), { phase: started.payload.phase, startedMinusRunCompletedMs: started.at - Number(run.completed), startedMinusHttpReturnMs: started.at - crossing.doneAt });
    rec.check("the reply that crossed the limit was not slower than a control turn asking the same long reply on a smaller context (no compaction wait)", crossing.ms <= control.ms * 1.6 + 2_000, { crossing: crossing.ms, control: control.ms });
    const done = await until("compaction.completed", async () => (await probe.journal(internalId)).find((e) => e.type === "compaction.completed" && e.cursor > started.cursor), { timeoutMs: 240_000, everyMs: 200 });
    rec.measure("background_compaction_ms", done.at - started.at);
    rec.measure("tokens_before_after_estimated", [done.payload.tokens_before, done.payload.tokens_after]);
    rec.measure("tracker_drift_tokens", done.payload.tokens_before - grower.tokens);
    rec.check("compaction.completed carries the started id and stage summary", done.payload.compaction_id === started.payload.compaction_id && done.payload.stage === "summary", done.payload);
    const [checkpoint] = (await probe.checkpoints(internalId)).filter((c) => c.compactionId === started.payload.compaction_id);
    rec.check("a durable history checkpoint with the same id exists", Boolean(checkpoint), checkpoint && { stage: checkpoint.stage, phase: checkpoint.phase, messages: checkpoint.messages });
    const inSummary = present(checkpoint?.summary ?? "", ITEMS);
    rec.measure("identifiers_in_summary", `${countTrue(inSummary)}/${ITEMS.length}`);
    rec.evidenceOf("summary_excerpt", (checkpoint?.summary ?? "").slice(0, 3500));
    rec.check("every identifier survived into the summary", countTrue(inSummary) === ITEMS.length, inSummary);
    rec.check("the unfinished request (compute total and rows per region once the refund table comes) is named in the summary", /total/i.test(checkpoint?.summary ?? "") && /region/i.test(checkpoint?.summary ?? ""));
    grower.tokens = done.payload.tokens_after;
    const recall = await grower.say(RECALL, "recall");
    const inReply = present(recall.reply, ITEMS);
    rec.measure("identifiers_in_recall_reply", `${countTrue(inReply)}/${ITEMS.length}`);
    rec.evidenceOf("recall_reply", recall.reply);
    rec.check("after compaction the model recalls every identifier", countTrue(inReply) === ITEMS.length, inReply);
    rec.check("after compaction the model carries out the unfinished request (TOTAL=280, North 2, South 1, East 1)", /TOTAL\s*=\s*280/i.test(recall.reply) && /North\s*=\s*2/i.test(recall.reply) && /South\s*=\s*1/i.test(recall.reply) && /East\s*=\s*1/i.test(recall.reply), recall.reply);
  }

  // ── (3) a new message arriving while compaction runs ──
  async preemption(rec, probe, state) {
    const { grower, chat, conversation, productId } = state;
    const internalId = await this.conversationId(probe, conversation);
    const trials = Number(process.env.VERIFY_TRIALS ?? 3);
    const results = [];
    for (let n = 1; n <= trials; n++) {
      const before = (await probe.journal()).at(-1)?.cursor ?? 0;
      const claimsBefore = (await probe.claims()).length;
      await grower.crossTrigger(`P${n}`);
      const started = await probe.nextStarted(internalId, before, 3_000);
      if (!rec.check(`trial ${n}: the background compaction was running`, Boolean(started), { tracked: grower.tokens })) { grower.tokens = TRIGGER; continue; }
      const content = `Trial ${n}: reply with exactly: ack-${n}`;
      const sentAt = Date.now();
      const sent = await chat.send(conversation, productId, { content });
      const acceptedMs = Date.now() - sentAt;
      const runId = sent.json?.run_id ?? sent.json?.run?.id;
      if (!runId) throw new Error(`trial ${n}: message not accepted after ${acceptedMs} ms: ${sent.status} ${sent.text.slice(0, 400)}`);
      const watcher = new StatusWatcher(probe, runId);
      const final = await chat.finish(conversation, productId, runId, 240_000);
      const seen = await watcher.stop();
      const totalMs = Date.now() - sentAt;
      const journal = (await probe.journal(internalId)).filter((e) => e.cursor > before);
      const claim = (await probe.claims(internalId)).slice(claimsBefore).find((c) => c.id === started.payload.compaction_id);
      // Only a compaction that blocks the Run counts: the background one the new Run schedules after its own reply carries that Run's id too (phase "background").
      const inRunStarts = journal.filter((e) => e.runId === runId && e.type === "compaction.started" && e.payload.phase !== "background");
      const completedFor = (id) => journal.find((e) => e.type === "compaction.completed" && e.payload.compaction_id === id);
      const endedFor = (id) => journal.find((e) => (e.type === "compaction.completed" || e.type === "compaction.aborted") && e.payload.compaction_id === id);
      const inRun = inRunStarts.map((e) => ({ id: e.payload.compaction_id, phase: e.payload.phase, completed: Boolean(completedFor(e.payload.compaction_id)), ms: completedFor(e.payload.compaction_id) ? completedFor(e.payload.compaction_id).at - e.at : null }));
      const bgCheckpoint = (await probe.checkpoints(internalId)).some((c) => c.compactionId === started.payload.compaction_id);
      results.push({ n, acceptedMs, totalMs, runStatuses: seen.map((s) => `${s.status}@+${s.at - sentAt}ms`), final: final.status, bgEndedAfterSendMs: claim?.ended ? claim.ended - sentAt : null, bgPreemptedFlag: claim?.preempted,
        bgCommitted: bgCheckpoint, bgTerminalInJournal: Boolean(endedFor(started.payload.compaction_id)), bgAborted: endedFor(started.payload.compaction_id)?.type === "compaction.aborted", inRun, inRunCompactionMs: inRun[0]?.ms ?? null });
      // The new Run answered without waiting; the compaction runs again after its reply.
      const rerun = await until("the compaction after the reply completed", async () => {
        const later = (await probe.journal(internalId)).filter((e) => e.cursor > before && e.payload.compaction_id !== started.payload.compaction_id);
        const next = later.find((e) => e.type === "compaction.started" && e.payload.phase === "background");
        return next && later.find((e) => e.type === "compaction.completed" && e.payload.compaction_id === next.payload.compaction_id);
      }, { timeoutMs: 240_000, everyMs: 200 });
      grower.tokens = rerun.payload.tokens_after;
    }
    rec.evidenceOf("preemption_trials", results);
    rec.measure("preempt_accept_ms", results.map((r) => r.acceptedMs));
    rec.measure("message_total_ms_after_preempt", results.map((r) => r.totalMs));
    rec.measure("in_run_compaction_ms_after_preempt", results.map((r) => r.inRunCompactionMs));
    rec.check("each trial's new message was accepted and its Run completed", results.length === trials && results.every((r) => r.final === "completed"), results.map((r) => r.final));
    rec.check("each new message ended the running compaction at once, without committing it (claim ended within 3 s of the send, no checkpoint for its id)", results.length === trials && results.every((r) => r.bgEndedAfterSendMs !== null && r.bgEndedAfterSendMs < 3_000 && !r.bgCommitted), results.map((r) => ({ endedAfterSendMs: r.bgEndedAfterSendMs, committed: r.bgCommitted, preemptedFlag: r.bgPreemptedFlag })));
    rec.check("a preempted compaction was left within 3 s of the message (it does not hold the message back)", results.every((r) => r.acceptedMs < 3_000), results.map((r) => r.acceptedMs));
    rec.check("each preempted compaction id ends with compaction.aborted in the journal", results.length === trials && results.every((r) => r.bgTerminalInJournal && r.bgAborted), results.map((r) => r.bgTerminalInJournal));
    const unmatched = results.filter((r) => !r.bgTerminalInJournal).length;
    if (unmatched) rec.defect({ title: "A preempted background compaction leaves compaction.started in the journal with no terminal event", severity: "low",
      expected: "Spec: compaction is visible; every compaction has a durable id with compaction.started and a completed marker. A compaction aborted by a new message should leave an observable end for observers of the journal, so a `compacting` indicator can clear.",
      actual: `${unmatched}/${results.length} preempted compactions had no compaction.completed (or any aborted marker) for their id; only the hatch_conversation_compactions claim row (ended_at) records the end.`,
      repro: "Grow a Chat conversation past the trigger with a long final reply so the compaction runs after the reply, send a message while it runs, then read hatch_conversation_journal for compaction.% events: started with no matching end." });
    rec.check("after a preemption the history is over the trigger but under the hard limit, so the new Run answers without compacting first (no compaction inside that Run, a short total time)", results.length === trials && results.every((r) => r.inRun.length === 0 && r.totalMs < 20_000), results.map((r) => ({ inRun: r.inRun.length, totalMs: r.totalMs })));
  }

  // ── (4) the IM notice ──
  async imNotice(stack, rec, probe, owner, productId) {
    const connection = await stack.connection({ owner, audience: "org", productId });
    const sender = "5150";
    await stack.admit(connection, { senderId: sender });
    const hooks = new TelegramWebhooks(stack.registryUrl);
    const replyRows = async () => (await stack.outboxRows()).filter((r) => r.kind === "reply" && r.state === "sent");
    const nonNotice = () => stack.platform.sends().filter((s) => !NOTICE.test(s.body.text));
    const noticeCount = () => stack.platform.sends().filter((s) => NOTICE.test(s.body.text)).length;
    const speak = async (text) => {
      const have = (await replyRows()).length;
      const sendsBefore = nonNotice().length;
      const post = await hooks.post(hooks.message({ chatId: Number(sender), text }));
      if (post.status !== 200) throw new Error(`webhook refused: ${post.status}`);
      await until("IM reply sent", async () => (await replyRows()).length > have, { timeoutMs: 300_000, everyMs: 150 });
      const answer = nonNotice().slice(sendsBefore).map((s) => s.body.text).join("\n");
      if (/出了点问题/.test(answer)) {
        const failed = (await stack.runtimePool.query("SELECT r.id, r.status, j.payload->>'reason' AS reason FROM hatch_conversation_runs r LEFT JOIN hatch_conversation_journal j ON j.run_id = r.id AND j.event_type = 'run.state' AND j.payload->>'status' = 'failed' WHERE r.status = 'failed' ORDER BY r.created_at DESC LIMIT 1")).rows;
        rec.evidenceOf("im_failed_run", failed);
        throw new Error(`IM run failed: ${JSON.stringify(failed)}`);
      }
      return answer;
    };
    rec.note("IM: org Connection, one admitted Telegram sender (contact principal). A contact has no Chat HTTP door, so the long history is sent as webhook text of up to ~250k chars per message; a real Telegram message cannot exceed 4096 chars, so these messages are a tool-made oversize that the Registry and Runtime accept.");
    const grower = new Grower(speak);
    await grower.say(FIRST.replace("Hi, ", "Hi (IM), "), "im-first");
    const convo = (await probe.conversationIds()).at(-1).id;
    const cross = async (tag) => {
      const cursor = (await probe.journal(convo)).at(-1)?.cursor ?? 0;
      await grower.crossTrigger(tag);
      return probe.nextStarted(convo, cursor, 3_000);
    };
    // Round 1: nobody is waiting while the background compaction runs.
    const one = await cross("I");
    if (!rec.check("IM round 1: a background compaction started after the reply", Boolean(one) && one.payload.phase === "background", one?.payload)) return;
    const done = await until("IM round 1 compaction.completed", async () => (await probe.journal(convo)).find((e) => e.type === "compaction.completed" && e.cursor > one.cursor), { timeoutMs: 240_000, everyMs: 200 });
    await sleep(6_000);
    rec.measure("im_notices_when_nobody_waits", noticeCount());
    rec.check("no notice when the compaction runs after the reply and nobody is waiting", noticeCount() === 0, stack.platform.sends().map((s) => s.body.text.slice(0, 50)));
    grower.tokens = done.payload.tokens_after;
    // Round 2: the user's next message arrives while the next background compaction runs; it ends that one and waits through the compaction in its own Run.
    const two = await cross("II");
    if (!rec.check("IM round 2: a background compaction started after the reply", Boolean(two), { tracked: grower.tokens })) return;
    const noticesBefore = noticeCount();
    const sentAt = Date.now();
    // The waiting message itself carries the history over the hard limit (about 232.6k), the one case where a turn waits for a summary.
    const answer = await speak(`Carrier note W, reference only.\n${chunk(15_000, "W")}\nPlease confirm you are still there: reply with exactly: here-now`);
    rec.measure("im_waiting_message_reply_ms", Date.now() - sentAt);
    await sleep(6_000);
    const journal = (await probe.journal(convo)).filter((e) => e.cursor > two.cursor);
    const inRun = journal.filter((e) => e.type === "compaction.started" && e.payload.phase !== "background");
    const notices = nonNoticeFree(stack.platform.sends()).length - noticesBefore;
    const rows = (await stack.outboxRows()).filter((r) => String(r.source_key).startsWith("compaction:"));
    rec.measure("im_notices_for_the_waiting_user", notices);
    rec.measure("im_compactions_in_the_waiting_users_run", inRun.length);
    rec.evidenceOf("im_compaction_outbox_rows", rows.map((r) => ({ key: r.source_key, state: r.state, kind: r.kind })));
    rec.evidenceOf("im_waiting_user_events", journal.map((e) => `${e.type}/${e.payload.phase ?? ""}/${e.payload.compaction_id ?? ""}`));
    rec.check("a compaction ran inside the waiting user's Run", inRun.length >= 1, journal.map((e) => `${e.type}:${e.payload.phase ?? ""}`));
    rec.check("exactly one notice for each compaction the waiting user sat through", notices === inRun.length && inRun.length >= 1 && new Set(rows.map((r) => r.source_key)).size === rows.length, { notices, compactions: inRun.length, rows: rows.length });
    const startedIds = journal.filter((e) => e.type === "compaction.started").map((e) => e.payload.compaction_id);
    const keyed = rows.length > 0 && rows.every((r) => startedIds.some((id) => String(r.source_key).startsWith(`compaction:${id}:`)));
    rec.check("the notice is keyed by the compaction's durable id (compaction:<cmp_id>:...)", keyed, { keys: rows.map((r) => r.source_key), compactionIds: startedIds });
    if (!keyed) rec.defect({ title: "The IM notice's dedupe key is Run id + journal cursor, not the compaction's durable id", severity: "low",
      expected: "Spec: every compaction has a durable id (cmp_...) which the channel layer uses for one notice per compaction.",
      actual: `Outbox source_key is ${rows.map((r) => r.source_key).join(", ")} while the journal's compaction.started carried ${startedIds.join(", ")}. ChatGateway.progress derives the id as <runId>:<latest run.state cursor>. Exactly one notice was still sent, so this is a contract mismatch, not a duplicate.`,
      repro: "Org Connection + Telegram sender; grow the conversation past the trigger; send a message while a background compaction runs; compare hatch_channel_outbox.source_key (kind notice) with the compaction.started payload." });
    const leaked = (await stack.runtimePool.query("SELECT count(*)::int AS n FROM hatch_conversation_events WHERE conversation_id = $1 AND payload::text LIKE '%正在整理%'", [convo])).rows[0].n;
    rec.check("the notice is not part of the conversation transcript", leaked === 0, { eventsContainingNotice: leaked });
    rec.check("the waiting user's real reply still arrived", /here-now/i.test(answer), answer.slice(0, 200));
  }
}

const nonNoticeFree = (sends) => sends.filter((s) => NOTICE.test(s.body.text));

/** Cold provider cache: a conversation between the prune and summarize thresholds that holds no tool results has nothing to prune. */
class ColdCache extends Scenario {
  constructor() { super({ id: "10b", title: "Compaction: cold cache with nothing to prune must not announce a compaction", stackOptions: { llmProfile: "kimi-k2.6-no-thinking", registryEnv: { HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" }, runtimeEnv: { HATCH_PROVIDER_CACHE_TTL_MS: "2000" } } }); }
  async run(stack, rec) {
    if (!process.env.LLM_API_KEY) rec.block("LLM_API_KEY (Kimi) is not set");
    rec.note("Tool setting: HATCH_PROVIDER_CACHE_TTL_MS=2000 (default 5 minutes) so the cache goes cold within seconds. The conversation is about 190k estimated tokens (prune threshold 131k, summarize trigger 219.5k) and has no tool calls.");
    const probe = new CompactionProbe(stack.runtimePool);
    const owner = await stack.account("owner");
    const productId = await stack.product(owner, { name: "Order Support Expert", system: SYSTEM });
    const chat = new ChatApi(stack.url, Auth.bearer(owner.apiKey));
    const conversation = await chat.create(productId);
    const grower = new Grower(async (content) => (await chat.send(conversation, productId, { content, wait: 240 })).json?.reply ?? "");
    await grower.say("Hello. Reply with exactly: ready", "first");
    for (let i = 1; i <= 3; i++) await grower.say(`Carrier log C${i}, reference only; reply with exactly: logged\n${chunk(MAX_CHUNK, `C${i}`)}`, `pad-${i}`);
    rec.measure("tracked_tokens", grower.tokens);
    await sleep(12_000);
    const internalId = (await probe.conversationIds())[0].id;
    // A compaction still running is not a missing end: wait (bounded) for every started id to end before judging.
    const ids = (events) => new Set(events.filter((e) => e.type === "compaction.started").map((e) => e.payload.compaction_id));
    const endedIds = (events) => new Set(events.filter((e) => e.type !== "compaction.started").map((e) => e.payload.compaction_id));
    const unended = (events) => [...ids(events)].filter((id) => !endedIds(events).has(id));
    await until("every started compaction ended", async () => !unended(await probe.journal(internalId)).length, { timeoutMs: 180_000, everyMs: 500 }).catch(() => undefined);
    const journal = await probe.journal(internalId);
    rec.evidenceOf("claims", await probe.claims(internalId));
    const started = journal.filter((e) => e.type === "compaction.started");
    const ended = journal.filter((e) => e.type === "compaction.completed" || e.type === "compaction.aborted");
    const checkpoints = await probe.checkpoints(internalId);
    rec.measure("compaction_started_events", started.length);
    rec.measure("compaction_terminal_events", ended.length);
    rec.measure("history_checkpoints", checkpoints.length);
    rec.evidenceOf("journal", journal.map((e) => `${e.type}/${e.payload.phase ?? ""}/${e.payload.compaction_id}`));
    rec.check("nothing was summarized or pruned (no tool results, below the trigger)", checkpoints.length === 0, checkpoints.length);
    rec.check("so no compaction was announced either (every compaction.started ends in completed or aborted)", started.length === ended.length && started.length === 0, { started: started.length, completed: ended.length });
    if (started.length > ended.length) rec.defect({ title: "A cold cache with nothing to prune announces a compaction that never happens", severity: "low",
      expected: "compaction.started only for a compaction that runs to a result; a conversation of 131k-219k tokens with no tool results has nothing to prune and below the trigger nothing to summarize.",
      actual: `${started.length} compaction.started and ${ended.length} compaction.completed, with no history checkpoint. ChatCompaction.inBackground re-schedules itself after the cache TTL when tokens >= prune; ChatCompaction/CompactionStrategy.wants() then says yes for a cold cache, the job announces compaction.started, and strategy.compact finds nothing to prune and returns none.`,
      repro: "HATCH_PROVIDER_CACHE_TTL_MS=2000; a Chat conversation of about 190k estimated tokens made of plain text turns; after the last reply wait a few seconds and read hatch_conversation_journal for compaction.% events." });
  }
}

export default [new Compaction(), new ColdCache()];
