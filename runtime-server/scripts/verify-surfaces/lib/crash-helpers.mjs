import { TelegramWebhooks } from "./webhooks.mjs";
import { sleep } from "./util.mjs";

/**
 * VERIFICATION TOOL ONLY. Helpers for the crash scenario: a world of Telegram senders talking to one org Connection, the chaos
 * operations (kill -9 / rolling restart) and the evidence read back from the product's own tables.
 */

/** Chat paths that start a Run, as the Registry calls them through the edge. Used to tell which Runtime instance took the Runs. */
const RUN_START_PATH = "/v1/service/chat/messages";

export class ImWorld {
  static async create(stack, { audience = "org" } = {}) {
    const owner = await stack.account("owner");
    const productId = await stack.product(owner, { name: "Crash Expert", system: "You are the Crash Expert. Follow the user's instructions about tools and replies literally. Be brief." });
    const connection = await stack.connection({ owner, audience, productId });
    return new ImWorld(stack, owner, productId, connection);
  }
  constructor(stack, owner, productId, connection) {
    this.stack = stack; this.owner = owner; this.productId = productId; this.connection = connection;
    this.hooks = new TelegramWebhooks(stack.registryUrl);
    this.nextChat = 5000 + Math.floor(Math.random() * 1000) * 10;
  }
  /** A fresh admitted sender. */
  async sender(label) { const chatId = this.nextChat++; await this.stack.admit(this.connection, { senderId: String(chatId) }); return { chatId, tag: `${label}${chatId}` }; }
  prompt(tag) { return `Use the hatch.web_search tool exactly once to search for "crashprobe-${tag}". After you have its result, reply with exactly: DONE-${tag}`; }
  /** Posts a webhook for the sender. Returns { updateId, status } where status is undefined when the Registry could not be reached. */
  async post(sender, { updateId } = {}) {
    const update = this.hooks.message({ chatId: sender.chatId, text: this.prompt(sender.tag), ...(updateId ? { updateId } : {}) });
    const result = await this.hooks.post(update).catch((error) => ({ status: undefined, error: String(error.cause?.code ?? error.message) }));
    return { updateId: update.update_id, ...result };
  }
  sends(sender) { return this.stack.platform.calls.filter((call) => call.method === "sendMessage" && String(call.body.chat_id) === String(sender.chatId) && call.delivered); }
  searches(sender) { return this.stack.platform.search.calls.filter((call) => String(call.query).includes(`crashprobe-${sender.tag}`)); }
  /** Everything the product recorded about one sender's messages. */
  async evidence(sender) {
    const inbox = (await this.stack.registryPool.query("SELECT event_id, state, run_id, attempts, (extract(epoch from received_at)*1000)::bigint AS received_ms, (extract(epoch from replied_at)*1000)::bigint AS replied_ms FROM hatch_channel_inbox WHERE sender_id = $1 ORDER BY seq", [String(sender.chatId)])).rows;
    const runIds = inbox.map((row) => row.run_id).filter(Boolean);
    const runs = runIds.length ? (await this.stack.runtimePool.query("SELECT id, status, executor_id, failure->>'message' AS interrupted_reason, (extract(epoch from created_at)*1000)::bigint AS created_ms, (extract(epoch from completed_at)*1000)::bigint AS completed_ms FROM hatch_conversation_runs WHERE id = ANY($1)", [runIds])).rows : [];
    const outbox = runIds.length ? (await this.stack.registryPool.query("SELECT state, source_key, kind, sent_parts, attempts FROM hatch_channel_outbox WHERE source_key = ANY($1)", [runIds.map((id) => `run:${id}`)])).rows : [];
    const sends = this.sends(sender);
    // Calls the dead executor left unfinished that the model was told "did not run" (transcript tool results with that code).
    const notRun = runIds.length ? (await this.stack.runtimePool.query("SELECT count(*)::int AS n FROM hatch_conversation_events WHERE run_id = ANY($1) AND payload::text LIKE '%tool_not_completed%'", [runIds])).rows[0].n : 0;
    return { chatId: sender.chatId, inbox, runs, outbox, toldNotRun: notRun, sends: sends.map((s) => ({ at: s.at, text: String(s.body.text).slice(0, 120) })), searches: this.searches(sender).length };
  }
}

export class Chaos {
  constructor(stack) { this.stack = stack; this.log = []; }
  mark(what) { const entry = { what, at: Date.now() }; this.log.push(entry); return entry.at; }
  /** The live Runtime instance that served the most Run starts since `sinceIndex` of the edge's served log. */
  holder(sinceIndex = 0) {
    const counts = new Map();
    for (const hit of this.stack.edge.served.slice(sinceIndex)) if (hit.kind === "runtime" && hit.path === RUN_START_PATH) counts.set(hit.port, (counts.get(hit.port) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return { instance: this.stack.liveRuntimes().find((r) => r.port === best?.[0]), counts: Object.fromEntries(counts) };
  }
  async kill(instance) { const at = this.mark(`kill -9 ${instance.id}`); await this.stack.killRuntime(instance); return at; }
  /** Rolling restart: every live instance is replaced by a new one that is ready before the old one is killed. */
  async rollAll() {
    const old = this.stack.liveRuntimes();
    for (const instance of old) { const next = await this.stack.startRuntime(); this.mark(`started ${next.id}`); await this.kill(instance); }
  }
  async killRegistry() { const at = this.mark("kill -9 registry"); await this.stack.killRegistry(); return at; }
  async startRegistry() { await this.stack.startRegistry(); return this.mark("registry restarted"); }
  async ensureHealthy(minRuntimes = 2) {
    if (!this.stack.registry.alive) await this.startRegistry();
    while (this.stack.liveRuntimes().length < minRuntimes) await this.stack.startRuntime();
  }
}

/** Waits until every sender has at least one delivered send, or the timeout. Then waits `settleMs` more to catch duplicates. */
export async function waitForReplies(world, senders, { timeoutMs = 180_000, settleMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !senders.every((s) => world.sends(s).length >= 1)) await sleep(250);
  await sleep(settleMs);
}

/** Waits until the predicate (async) holds. Returns whether it did. */
export async function waitUntil(predicate, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(everyMs); }
  return false;
}
