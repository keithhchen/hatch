import http from "node:http";
import { sleep, until } from "./util.mjs";

const ACTIVE = ["queued", "running", "waiting_for_tool", "compacting"];
const TERMINAL = ["completed", "failed", "cancelled", "interrupted"];
export { ACTIVE, TERMINAL };

/** Counts what Chat durably holds for one conversation, from the Runtime database: Runs, user messages, model-visible turns, model replies. */
export class ConversationEvidence {
  constructor(runtimePool) { this.pool = runtimePool; }

  /** The internal id of a conversation, from its public id (or the Run that belongs to it). */
  async idOf({ publicId, runId }) {
    if (runId) return (await this.pool.query("SELECT conversation_id FROM hatch_conversation_runs WHERE id = $1", [runId])).rows[0]?.conversation_id;
    return (await this.pool.query("SELECT id FROM hatch_conversations WHERE public_id = $1 OR id = $1", [publicId])).rows[0]?.id;
  }
  async runs(id) { return (await this.pool.query("SELECT id, status, client_message_id, steered_count, consumed_count, created_at, started_at, completed_at, interrupted_reason FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at, id", [id])).rows; }
  /** One row per user message the journal accepted (a key appears at most once by the database's own unique index). */
  async journalUsers(id) { return (await this.pool.query("SELECT cursor, run_id, payload->>'client_message_id' AS key, payload->>'steered' AS steered FROM hatch_conversation_journal WHERE conversation_id = $1 AND event_type = 'message.created' AND payload->>'role' = 'user' ORDER BY cursor", [id])).rows; }
  async consumed(id) { return (await this.pool.query("SELECT run_id, payload->>'client_message_id' AS key FROM hatch_conversation_journal WHERE conversation_id = $1 AND event_type = 'message.consumed' ORDER BY cursor", [id])).rows; }
  /** What the model was given: user messages in the transcript, in order. */
  async modelUsers(id) { return (await this.pool.query("SELECT id::bigint AS id, run_id, payload->'message'->>'content' AS content, payload->>'client_message_id' AS key FROM hatch_conversation_events WHERE conversation_id = $1 AND event_type = 'conversation.model_message' AND payload->'message'->>'role' = 'user' ORDER BY id::bigint", [id])).rows; }
  /** One assistant message is one model call that produced output. */
  async modelReplies(id) { return (await this.pool.query("SELECT id::bigint AS id, run_id, created_at, payload->'message'->>'content' AS content, payload->>'finish_reason' AS finish FROM hatch_conversation_events WHERE conversation_id = $1 AND event_type = 'conversation.model_message' AND payload->'message'->>'role' = 'assistant' ORDER BY id::bigint", [id])).rows; }

  /** Everything durable about one conversation, in order, trimmed: the evidence behind an anomaly. */
  async dump(id) {
    const journal = (await this.pool.query("SELECT cursor, event_type, run_id, created_at, left(payload::text, 160) AS payload FROM hatch_conversation_journal WHERE conversation_id = $1 ORDER BY cursor", [id])).rows;
    const events = (await this.pool.query("SELECT id::bigint AS id, event_type, run_id, created_at, payload->'message'->>'role' AS role, left(coalesce(payload->'message'->>'content', payload->>'to', ''), 60) AS content FROM hatch_conversation_events WHERE conversation_id = $1 ORDER BY id::bigint", [id])).rows;
    const runs = await this.runs(id);
    return { runs, journal: journal.map((j) => `${j.cursor} ${j.created_at.toISOString().slice(17, 23)} ${j.event_type} ${j.run_id?.slice(4, 10) ?? "-"} ${j.payload}`), events: events.map((e) => `${e.id} ${e.created_at.toISOString().slice(17, 23)} ${e.event_type} ${e.run_id?.slice(4, 10) ?? "-"} ${e.role ?? ""} ${e.content}`) };
  }

  async counts(id) {
    const [runs, users, journal, replies] = await Promise.all([this.runs(id), this.modelUsers(id), this.journalUsers(id), this.modelReplies(id)]);
    return { runs: runs.length, modelUsers: users.length, journalUsers: journal.length, modelReplies: replies.length };
  }

  /** Waits until every Run of the conversation is terminal. */
  async quiesce(id, timeoutMs = 120_000) {
    return until(`conversation ${id} to have no active Run`, async () => { const runs = await this.runs(id); return runs.every((r) => TERMINAL.includes(r.status)) ? runs : undefined; }, { timeoutMs, everyMs: 200 });
  }
}

/** A Telegram webhook post that can be cut off client-side right after the request is written, like a platform that gave up waiting. */
export function postWebhook(hooks, update, { abortAfterMs } = {}) {
  const url = new URL(hooks.url);
  const body = JSON.stringify(update);
  return new Promise((resolve) => {
    const started = Date.now();
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-telegram-bot-api-secret-token": hooks.secret } }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, ms: Date.now() - started }));
    });
    request.on("error", () => resolve({ status: undefined, aborted: true, ms: Date.now() - started }));
    // abortAfterMs 0: the connection is cut the moment the body has been handed to the network, before any answer can come back.
    request.end(body, () => { if (abortAfterMs === 0) request.destroy(); });
    if (abortAfterMs) setTimeout(() => request.destroy(), abortAfterMs);
  });
}

/** Polls a SQL probe on a short interval and keeps the largest value it saw. */
export class Maxima {
  constructor(probe, everyMs = 25) { this.probe = probe; this.everyMs = everyMs; this.max = 0; this.samples = 0; this.running = true; this.loop = this.run(); }
  async run() { while (this.running) { const value = await this.probe().catch(() => 0); this.samples += 1; if (value > this.max) this.max = value; await sleep(this.everyMs); } }
  async stop() { this.running = false; await this.loop; return { max: this.max, samples: this.samples }; }
}

export const tally = (items, keyOf) => { const out = {}; for (const item of items) { const key = keyOf(item); out[key] = (out[key] ?? 0) + 1; } return out; };
export const outboxStates = async (stack) => tally(await stack.outboxRows(), (row) => row.state);
