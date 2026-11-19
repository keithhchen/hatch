#!/usr/bin/env node
/**
 * Record a load-test replay file from ONE completed real Run of the website-audit Product, READ ONLY against prod Postgres.
 *
 *   node scripts/record-replay.mjs --list
 *   node scripts/record-replay.mjs [--run <run_id> | --conversation <conversation_id>] [--out replay.json]
 *
 * Prod is reached with `ssh hatch-prod` (override with HATCH_PROD_SSH): psql inside the Postgres container, SELECT only.
 * The bytes of the published page are read from the object store by a one-off `node` inside the runtime container, which
 * uses the container's own credentials; nothing is written anywhere and no secret is printed.
 *
 * Where the data comes from (hatch_conversation_events, ordered by id, filtered by run_id):
 *  - `conversation.model_message` role=assistant: one model turn. `payload.message` has text (content / model_content text blocks),
 *    thinking (model_content thinking blocks) and tool calls (model_content toolCall blocks carry the exact argument objects).
 *  - `conversation.model_message` role=tool: the result as the model saw it (`tool_content[].text`, JSON). Written when the
 *    tool results are handed back to the model, so its time is the "input ready" moment of the next turn.
 *  - `tool.call` status=requested / completed|failed: tool name as the runtime knows it (box.bash, site.page_speed ...), plus
 *    the result object. Their `payload.timestamp` has millisecond precision.
 *  - `turn.state` to=running: when the Run started working on the user message.
 *
 * Timestamps: `payload.timestamp` (ms, set where the event is created) is used instead of the row's `created_at` (insert time,
 * a few ms later and equal in spirit); both come from the same process so durations are the same up to ~10 ms.
 *  - turn.duration_ms = assistant message timestamp - input time, where input time is the `turn.state running` event for the
 *    first turn and the latest tool-role model_message before the assistant message for later turns (falling back to the
 *    latest tool.call completion). That is the wall-clock model latency, including time to first token and streaming.
 *  - tool_calls[].duration_ms = completed (or failed) tool.call timestamp - requested tool.call timestamp.
 *
 * Truncation: stored results are used as persisted. The model-visible result (tool-role message) is preferred over the
 * tool.call event result; when it is not JSON it is kept as a string. No offloading to another store was found in the events.
 * Secrets: redact() masks API keys, Bearer tokens, password/api_key values and signed ?t= link tokens in every string.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const SSH = process.env.HATCH_PROD_SSH || "hatch-prod";
const PRODUCT_ID = "159c0f12-6e23-4512-af7b-928833d199d7";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const out = flag("out") || "./replay.json";

function run(command, argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [], errors = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => errors.push(c));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command} exited ${code}: ${Buffer.concat(errors).toString().slice(0, 300)}`)));
    child.stdin.end(input);
  });
}

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Read-only: one SELECT yielding one JSON value. */
async function queryJson(sql) {
  const raw = await run("ssh", [SSH, "docker exec -i hatch-infra-postgres-1 psql -U hatch -d hatch -At -v ON_ERROR_STOP=1"], `BEGIN READ ONLY;\n${sql}\nROLLBACK;\n`);
  const line = raw.toString().split("\n").find((l) => l.startsWith("[") || l.startsWith("{") || l === "null");
  return line ? JSON.parse(line) : null;
}

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/g, "Bearer [redacted]"],
  [/((?:api[_-]?key|apikey|password|passwd|secret|access[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, "$1[redacted]"],
  [/([?&]t=)[A-Za-z0-9_-]{30,}/g, "$1[redacted]"]
];
const redactions = [];
function redact(value, where = "") {
  if (typeof value === "string") {
    let s = value;
    for (const [pattern, to] of SECRET_PATTERNS) s = s.replace(pattern, () => { redactions.push(`${where}: ${pattern.source.slice(0, 30)}`); return to; });
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, where));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, where)]));
  return value;
}

const CANDIDATES = `
WITH pub AS (SELECT DISTINCT run_id FROM hatch_conversation_events WHERE event_type = 'tool.call' AND payload->>'name' = 'box.publish_html' AND payload->>'status' = 'completed')
SELECT r.id AS run_id, r.conversation_id,
  (SELECT count(*) FROM hatch_conversation_events e WHERE e.run_id = r.id AND e.event_type = 'conversation.model_message' AND e.payload->'message'->>'role' = 'assistant') AS turns,
  (SELECT count(*) FROM hatch_conversation_events e WHERE e.run_id = r.id AND e.event_type = 'tool.call' AND e.payload->>'status' = 'requested') AS tool_calls,
  extract(epoch FROM r.completed_at - r.started_at)::int AS seconds,
  (SELECT count(*) FROM hatch_conversation_runs r2 WHERE r2.conversation_id = r.conversation_id) AS runs_in_conversation
FROM hatch_conversation_runs r JOIN hatch_conversations c ON c.id = r.conversation_id
WHERE c.product_id = ${literal(PRODUCT_ID)} AND r.status = 'completed' AND r.id IN (SELECT run_id FROM pub)`;

async function candidates() {
  return (await queryJson(`SELECT coalesce(jsonb_agg(t ORDER BY turns, tool_calls, run_id), '[]') FROM (${CANDIDATES}) t;`)) ?? [];
}

/** The median run (by turns, then tool calls) among conversations that hold exactly one Run. */
async function pickMedian() {
  const single = (await candidates()).filter((c) => c.runs_in_conversation === 1);
  if (!single.length) throw new Error("no completed single-run candidate found");
  return single[Math.floor(single.length / 2)];
}

async function resolveRun() {
  if (flag("run")) return (await queryJson(`SELECT to_jsonb(t) FROM (SELECT id AS run_id, conversation_id FROM hatch_conversation_runs WHERE id = ${literal(flag("run"))}) t;`));
  if (flag("conversation")) {
    const rows = (await candidates()).filter((c) => c.conversation_id === flag("conversation"));
    if (rows.length !== 1) throw new Error(`conversation has ${rows.length} completed publishing runs; pass --run`);
    return rows[0];
  }
  return pickMedian();
}

const ms = (event) => Date.parse(event.payload.timestamp);
const textOf = (blocks) => (blocks ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");

function parseResult(message, fallback) {
  const text = (message?.tool_content ?? []).map((b) => b.text ?? "").join("");
  if (!message) return fallback;
  try { return JSON.parse(text); } catch { return text; }
}

function build(events) {
  const requested = new Map(), finished = new Map(), toolMessages = new Map();
  for (const e of events) {
    if (e.event_type === "tool.call") (e.payload.status === "requested" ? requested : finished).set(e.payload.tool_call_id, e);
    if (e.event_type === "conversation.model_message" && e.payload.message.role === "tool") toolMessages.set(e.payload.message.tool_call_id, e);
  }
  const started = events.find((e) => e.event_type === "turn.state" && e.payload.to === "running") ?? events[0];
  const turns = [], toolCalls = [];
  let inputAt = ms(started), lastToolMessageAt;
  for (const e of events) {
    if (e.event_type !== "conversation.model_message") continue;
    const message = e.payload.message;
    if (message.role === "tool") { lastToolMessageAt = ms(e); continue; }
    if (message.role !== "assistant") continue;
    if (lastToolMessageAt) inputAt = lastToolMessageAt;
    const content = message.model_content ?? [];
    const thinking = content.filter((b) => b.type === "thinking" && b.thinking).map((b) => b.thinking).join("\n");
    const blocks = content.filter((b) => b.type === "toolCall");
    const calls = (message.tool_calls ?? []).map((call) => {
      const block = blocks.find((b) => b.id === call.id);
      const requestedEvent = requested.get(call.id), finishedEvent = finished.get(call.id), toolMessage = toolMessages.get(call.id);
      const name = requestedEvent?.payload.name ?? call.function.name;
      toolCalls.push({
        name,
        duration_ms: requestedEvent && finishedEvent ? ms(finishedEvent) - ms(requestedEvent) : 0,
        result: redact(parseResult(toolMessage?.payload.message, finishedEvent?.payload.result ?? finishedEvent?.payload.error ?? null), name),
        is_error: finishedEvent?.payload.status === "failed" || toolMessage?.payload.message.tool_is_error === true
      });
      return { id: call.id, name, arguments: redact(block?.arguments ?? JSON.parse(call.function.arguments || "{}"), name) };
    });
    turns.push({
      duration_ms: ms(e) - inputAt,
      ...(thinking ? { thinking: redact(thinking, "thinking") } : {}),
      text: redact(textOf(content) || (typeof message.content === "string" ? message.content : ""), "text"),
      tool_calls: calls
    });
    lastToolMessageAt = undefined;
    inputAt = ms(e);
  }
  return { turns, toolCalls };
}

/** The published page: the buyer file's bytes from the object store (key layout of runtime-server/src/agentBox/files.ts). */
async function publishedHtml(runId) {
  const call = await queryJson(`SELECT to_jsonb(t) FROM (SELECT payload->'arguments' AS arguments FROM hatch_conversation_events WHERE run_id = ${literal(runId)} AND event_type = 'tool.call' AND payload->>'name' = 'box.publish_html' AND payload->>'status' = 'completed' ORDER BY id DESC LIMIT 1) t;`);
  if (!call) throw new Error("the run has no completed box.publish_html");
  const { file_id: fileId, title } = call.arguments;
  const asset = await queryJson(`SELECT to_jsonb(t) FROM (SELECT scope_key, sha256 FROM hatch_assets WHERE id = ${literal(fileId)} AND state = 'ready') t;`);
  if (!asset) throw new Error(`asset ${fileId} not found`);
  const key = `${asset.scope_key}/${asset.sha256}/original`;
  if (!/^[A-Za-z0-9/%._-]+$/.test(key)) throw new Error("unexpected object key");
  const container = (await run("ssh", [SSH, "docker ps --filter name=hatch-app-runtime --format '{{.Names}}'"], "")).toString().trim().split("\n")[0];
  if (!/^[A-Za-z0-9_.-]+$/.test(container)) throw new Error("runtime container not found");
  const fetchScript = `import { objectStoreFromEnvironment } from "/app/runtime-server/dist/creatorLearning/objectStore.js";
process.stdout.write((await objectStoreFromEnvironment(process.env).get(process.argv[2])).toString("base64"));`;
  const base64 = await run("ssh", [SSH, `docker exec -i ${container} node --input-type=module - '${key}'`], fetchScript);
  const html = Buffer.from(base64.toString(), "base64").toString("utf8");
  if (!/<html[\s\S]*<\/html>/i.test(html)) throw new Error("the published file is not a whole HTML document");
  return { title, html: redact(html, "publish.html") };
}

if (args.includes("--list")) {
  for (const c of await candidates()) console.log(`${c.run_id}\t${c.conversation_id}\tturns=${c.turns}\ttools=${c.tool_calls}\t${c.seconds}s\truns_in_conversation=${c.runs_in_conversation}`);
  process.exit(0);
}

const chosen = await resolveRun();
if (!chosen) throw new Error("run not found");
const events = (await queryJson(`SELECT coalesce(jsonb_agg(jsonb_build_object('event_type', event_type, 'payload', payload) ORDER BY id), '[]') FROM hatch_conversation_events WHERE run_id = ${literal(chosen.run_id)} AND event_type IN ('conversation.model_message', 'tool.call', 'turn.state');`)) ?? [];
const { turns, toolCalls } = build(events);
const publish = await publishedHtml(chosen.run_id);
const replay = { version: 1, source: { run_id: chosen.run_id, conversation_id: chosen.conversation_id, recorded_at: new Date().toISOString() }, turns, tool_calls: toolCalls, publish };
await writeFile(out, JSON.stringify(replay));
const total = turns.reduce((sum, t) => sum + t.duration_ms, 0) + toolCalls.reduce((sum, t) => sum + t.duration_ms, 0);
if (redactions.length) console.error(`redacted ${redactions.length} value(s): ${[...new Set(redactions)].join("; ")}`);
console.error(`run ${chosen.run_id}: ${turns.length} turns, ${toolCalls.length} tool calls, ${total} ms recorded (turns+tools, tools may overlap), ${Buffer.byteLength(publish.html)} html bytes -> ${out}`);
