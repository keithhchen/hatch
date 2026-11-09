import { sleep } from "./util.mjs";

/**
 * VERIFICATION TOOL ONLY. Helpers for the compaction scenario.
 *
 * The compaction thresholds derive from the model's window (Kimi K2.6: 262,144 tokens; summarize at 262,144 - 16,384 - 10% = 219,546
 * estimated tokens, estimate = chars / 4) and no env var changes it, so a conversation must really be that large. `chunk()` makes
 * text that the product's estimator counts at chars / 4 while Kimi's tokenizer sees far fewer tokens (long runs of "="), which keeps
 * a real run affordable. It changes only how cheaply the trigger is reached, not the compaction logic.
 */
export const KIMI_WINDOW = 262_144;
export const TRIGGER = KIMI_WINDOW - 16_384 - Math.floor(KIMI_WINDOW * 0.1);
export const MAX_CHUNK = 62_500;
export const estimate = (text) => Math.ceil(text.length / 4);

/** Text of exactly `tokens` estimated tokens: distinct short lines, then a long rule each. */
export function chunk(tokens, tag) {
  const target = tokens * 4;
  let text = "";
  for (let i = 0; text.length < target; i++) text += `Ledger ${tag}-${i}: carrier checkpoint reviewed ${"=".repeat(300)}\n`;
  return text.slice(0, target);
}

const LONG_REPLY = "Then reply with only the whole numbers from 1 to 600 separated by single spaces, directly in this chat as plain text.";

/**
 * Knows how big the conversation is in the product's own estimate and grows it so that the history is still under the
 * summarize trigger when a message arrives, and over it only once the long reply is stored: the case that runs after the reply.
 * `send(content)` is the surface: it returns the reply text.
 */
export class Grower {
  constructor(send, { tokens = 0 } = {}) { this.send = send; this.tokens = tokens; this.turns = []; }

  async say(content, label) {
    const startedAt = Date.now();
    const reply = await this.send(content);
    const turn = { label, startedAt, doneAt: Date.now(), ms: Date.now() - startedAt, reply, tokens: estimate(content) + estimate(reply) };
    this.tokens += turn.tokens;
    this.turns.push(turn);
    return turn;
  }

  /** A small message that asks for a long reply: the control turn for reply latency. */
  longReplyTurn(label, tag, tokens = 500) { return this.say(`Carrier note ${tag}, reference only.\n${chunk(tokens, tag)}\n${LONG_REPLY}`, label); }

  /** Pads with short-reply turns until one more message sized to land just under the trigger fits, then sends it with a long reply. */
  async crossTrigger(tag, margin = 150) {
    for (;;) {
      const room = TRIGGER - margin - this.tokens;
      if (room <= MAX_CHUNK + 2_000) {
        const last = await this.say(`Carrier note ${tag}-final, reference only.\n${chunk(Math.max(room - 60, 100), `${tag}f`)}\n${LONG_REPLY}`, `${tag}-crossing`);
        return last;
      }
      const t = await this.say(`Carrier log ${tag}-${this.turns.length}, reference only; reply with exactly: logged\n${chunk(MAX_CHUNK, `${tag}${this.turns.length}`)}`, `${tag}-pad`);
      if (!/logged/i.test(t.reply)) throw new Error(`padding turn was not answered as asked: ${t.reply.slice(0, 80)}`);
    }
  }
}

const EPOCH = (column) => `(extract(epoch from ${column}) * 1000)::bigint`;

/** Reads the Runtime's durable compaction evidence straight from its database. */
export class CompactionProbe {
  constructor(runtimePool) { this.pool = runtimePool; }

  async conversationIds() { return (await this.pool.query("SELECT id, public_id, owner_account_id FROM hatch_conversations ORDER BY created_at")).rows; }

  /** compaction.started / compaction.completed in the journal, oldest first. */
  async journal(conversationId) {
    const rows = (await this.pool.query(
      `SELECT cursor, conversation_id, run_id, event_type, payload, ${EPOCH("created_at")} AS at FROM hatch_conversation_journal
       WHERE event_type LIKE 'compaction.%' ${conversationId ? "AND conversation_id = $1" : ""} ORDER BY cursor`, conversationId ? [conversationId] : [])).rows;
    return rows.map((r) => ({ cursor: Number(r.cursor), conversationId: r.conversation_id, runId: r.run_id, type: r.event_type, payload: r.payload, at: Number(r.at) }));
  }

  /** The claim rows: one per background compaction, with how it ended. */
  async claims(conversationId) {
    const rows = (await this.pool.query(
      `SELECT id, conversation_id, preempted, ${EPOCH("created_at")} AS created, ${EPOCH("ended_at")} AS ended FROM hatch_conversation_compactions
       ${conversationId ? "WHERE conversation_id = $1" : ""} ORDER BY created_at`, conversationId ? [conversationId] : [])).rows;
    return rows.map((r) => ({ id: r.id, conversationId: r.conversation_id, preempted: r.preempted, created: Number(r.created), ended: r.ended === null ? null : Number(r.ended) }));
  }

  /** The conversation.compacted history checkpoints, with the summary text (the first replacement message). */
  async checkpoints(conversationId) {
    const rows = (await this.pool.query(
      `SELECT id, run_id, payload, ${EPOCH("created_at")} AS at FROM hatch_conversation_events
       WHERE event_type = 'conversation.compacted' ${conversationId ? "AND conversation_id = $1" : ""} ORDER BY id`, conversationId ? [conversationId] : [])).rows;
    return rows.map((r) => {
      const history = r.payload.replacement_history ?? [];
      const first = history[0];
      return { id: r.id, runId: r.run_id, at: Number(r.at), compactionId: r.payload.compaction_id, stage: r.payload.stage, phase: r.payload.phase, degraded: r.payload.degraded ?? false, dropped: r.payload.dropped_messages,
        summary: typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? ""), messages: history.length };
    });
  }

  async runStatus(runId) { return (await this.pool.query(`SELECT status, ${EPOCH("completed_at")} AS completed FROM hatch_conversation_runs WHERE id = $1`, [runId])).rows[0]; }
  async runsOf(conversationId) { return (await this.pool.query(`SELECT id, status, ${EPOCH("created_at")} AS created, ${EPOCH("completed_at")} AS completed FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at`, [conversationId])).rows; }

  /** Waits for the next `compaction.started` after `afterCursor`; polls fast so a caller can react inside the compaction. */
  async nextStarted(conversationId, afterCursor, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await this.journal(conversationId)).find((e) => e.type === "compaction.started" && e.cursor > afterCursor);
      if (found) return found;
      if (Date.now() > deadline) return undefined;
      await sleep(25);
    }
  }
}

/** Polls a Run's status in the database and remembers every distinct status with the time it was first seen. */
export class StatusWatcher {
  constructor(probe, runId) { this.probe = probe; this.runId = runId; this.seen = []; this.stopped = false; this.done = this.loop(); }
  async loop() {
    while (!this.stopped) {
      const row = await this.probe.runStatus(this.runId).catch(() => undefined);
      if (row && this.seen.at(-1)?.status !== row.status) this.seen.push({ status: row.status, at: Date.now() });
      await sleep(40);
    }
  }
  async stop() { this.stopped = true; await this.done; return this.seen; }
}
