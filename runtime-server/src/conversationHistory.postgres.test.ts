import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresStore, type PostgresQueryExecutor } from "./postgresStore.js";
import { PostgresConversationRepository } from "./conversationRepository.js";
import type { PersistedAssetAttachment } from "./protocol.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };
async function isolated<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `hatch_history_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // Exclude public: an absent test table must never resolve to a shared table.
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000 });
    return await body(pool);
  } finally {
    await pool?.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
}

test("real PostgreSQL history cursors survive new inserts with stable IDs and conversation scope", options, async () => isolated(async (pool) => {
  const store = new PostgresStore(pool);
  async function turn(conversation: string, run: string) {
    await store.append({ type: "message.created", conversation_id: conversation, run_id: run, role: "user", content: `${run} question` });
    await store.append({ type: "conversation.model_message", conversation_id: conversation, run_id: run,
      message: { role: "assistant", content: `${run} answer` }, finish_reason: "stop" });
  }
  for (let i = 0; i < 6; i++) await turn("history", `run_${i}`);
  await turn("foreign", "run_5");
  const baseline = await store.readVisibleConversationPage("history", { limit: 200 });
  const first = await store.readVisibleConversationPage("history", { limit: 3 });
  assert.equal(first.has_more, true);
  assert.ok(first.before_cursor);
  await turn("history", "new_insert");
  const collected = [...first.messages];
  let page = first;
  for (let guard = 0; page.has_more; guard++) {
    assert.ok(guard < 10, "cursor must make progress");
    page = await store.readVisibleConversationPage("history", { limit: 3, beforeCursor: page.before_cursor });
    collected.unshift(...page.messages);
  }
  assert.deepEqual(collected, baseline.messages);
  assert.equal(new Set(collected.map((message) => message.id)).size, 12);
  assert.deepEqual((await store.readVisibleConversationPage("history", { limit: 200 })).messages.slice(0, 12), baseline.messages);
  await assert.rejects(store.readVisibleConversationPage("foreign", { beforeCursor: first.before_cursor }), { code: "history_cursor_invalid" });
  await assert.rejects(store.readVisibleConversationPage("history", { beforeCursor: "invalid" }), { code: "history_cursor_invalid" });
  assert.deepEqual((await store.readVisibleConversationPage("missing")).messages, []);
}));

test("real PostgreSQL strips heavy fields before transport, scopes tool details and finds pre-compaction assets", options, async () => isolated(async (pool) => {
  const responses: unknown[] = [];
  const executor: PostgresQueryExecutor = {
    async query(text, values) {
      const result = await pool.query(text, values);
      responses.push(result.rows);
      return result;
    }
  };
  const store = new PostgresStore(executor);
  const huge = "PRIVATE_LARGE_BODY_".repeat(70_000);
  const asset: PersistedAssetAttachment = { kind: "asset", attachment_id: "attachment_old", asset_id: "asset_old",
    display_name: "old.png", media_type: "image/png", source_bytes: 42, sha256: "a".repeat(64), storage_ref: "private/old.png" };
  await store.append({ type: "message.created", conversation_id: "history", run_id: "old", role: "user", content: "old attachment", attachments: [asset] });
  await store.append({ type: "conversation.model_message", conversation_id: "history", run_id: "current",
    message: { role: "user", content: "current question", attachments: [asset] } });
  // Persist historical optional byte fields directly to exercise the SQL projection,
  // including old records predating the current attachment persistence contract.
  await pool.query(`UPDATE hatch_conversation_events SET payload = jsonb_set(payload,
    '{message,attachments,0}', (payload #> '{message,attachments,0}') || jsonb_build_object('text', $1::text, 'data_base64', $1::text))
    WHERE run_id = 'current'`, [huge]);
  for (const conversation of ["history", "foreign"]) {
    await store.append({ type: "tool.call", conversation_id: conversation, run_id: "current", tool_call_id: "same_tool",
      name: "file_read", arguments: { path: huge }, status: "requested", approval: "ask" });
    await store.append({ type: "tool.call", conversation_id: conversation, run_id: "current", tool_call_id: "same_tool",
      name: "file_read", arguments: { path: huge }, status: "completed", result: { content: conversation === "history" ? huge : "FOREIGN_SECRET" } });
  }
  await store.append({ type: "skill.activated", conversation_id: "history", run_id: "current", name: "reader", path: "/reader/SKILL.md", directory: "/reader", content: huge });
  await store.append({ type: "conversation.model_message", conversation_id: "history", run_id: "current",
    message: { role: "assistant", content: "done" }, finish_reason: "stop" });
  await store.append({ type: "conversation.compacted", conversation_id: "history", run_id: "compact", trigger: "auto", phase: "pre_turn",
    reason: "context_limit", message: "summary", replacement_history: [{ role: "user", content: "summary" }],
    window_number: 1, first_window_id: "window_0", window_id: "window_1" });
  responses.length = 0;
  const page = await store.readVisibleConversationPage("history", { limit: 200 });
  assert.ok(JSON.stringify(responses).length < 20_000, "SQL must strip heavy bytes before returning rows to Node");
  assert.ok(JSON.stringify(page).length < 20_000);
  assert.equal(JSON.stringify(page).includes("PRIVATE_LARGE_BODY_"), false);
  assert.deepEqual(page.messages.map((message) => message.content), ["old attachment", "current question", "done"]);
  const tool = page.messages.find((message) => message.role === "assistant")?.tool_calls?.[0];
  assert.equal(tool?.status, "completed");
  assert.deepEqual(tool?.detail_ref, { run_id: "current", tool_call_id: "same_tool" });
  const detail = await store.readConversationToolDetail("history", "current", "same_tool");
  assert.deepEqual(detail?.result, { content: huge });
  assert.equal(detail?.approval, "ask");
  assert.equal(await store.readConversationToolDetail("history", "wrong_run", "same_tool"), undefined);
  assert.equal(await store.readConversationToolDetail("missing", "current", "same_tool"), undefined);
  assert.equal(await store.readConversationToolDetail("history", "current", "missing"), undefined);
  assert.deepEqual(await store.readConversationAssetReference("history", "asset_old"), asset);
  assert.equal(await store.readConversationAssetReference("foreign", "asset_old"), undefined);
  assert.equal(await store.readConversationAssetReference("history", "missing"), undefined);
}));

test("real PostgreSQL recovery is bounded and journal pages retain a fixed watermark", options, async () => isolated(async (pool) => {
  const repository = new PostgresConversationRepository(pool);
  const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: `sha256:${"a".repeat(64)}` };
  for (const id of ["history", "foreign"]) await repository.createConversation({ ...binding, id, publicId: id });
  for (const [id, status] of [["r1", "completed"], ["r2", "interrupted"], ["r3", "interrupted"], ["r4", "queued"]] as const) {
    await repository.createRun({ id, conversationId: "history", clientMessageId: id, inputDigest: binding.corpusDigest, corpusDigest: binding.corpusDigest });
    await repository.transitionRun(id, status);
  }
  await repository.createRun({ id: "foreign_run", conversationId: "foreign", clientMessageId: "foreign", inputDigest: binding.corpusDigest, corpusDigest: binding.corpusDigest });
  const baseline = await repository.snapshot("history");
  const recovery = await repository.recoverySnapshot("history", ["r1", "r1", "foreign_run", "missing"]);
  assert.deepEqual(recovery.runs.map((run) => run.id), ["r1", "r4"]);
  assert.deepEqual(recovery.events, []);
  assert.equal(recovery.cursor, baseline.cursor);
  const first = await repository.journalPage("history", 0, undefined, 2);
  assert.equal(first.events.length, 2);
  assert.equal(first.has_more, true);
  const later = await repository.appendEvent({ conversationId: "history", runId: "r4", type: "message.created", payload: { content: "new insert" } });
  const delivered = [...first.events];
  let page = first;
  for (let guard = 0; page.has_more; guard++) {
    assert.ok(guard < 30, "journal cursor must make progress");
    const previous = page.cursor;
    page = await repository.journalPage("history", previous, first.through_cursor, 2);
    assert.ok(page.cursor > previous);
    assert.equal(page.through_cursor, first.through_cursor);
    assert.ok(page.events.length <= 2);
    assert.deepEqual(new Set(page.runs.map((run) => run.id)), new Set(page.events.flatMap((event) => event.runId ? [event.runId] : [])));
    delivered.push(...page.events);
  }
  assert.deepEqual(delivered, baseline.events);
  assert.deepEqual((await repository.journalPage("history", page.cursor)).events, [later]);
  assert.deepEqual((await repository.recoverySnapshot("history", [])).runs.map((run) => run.id), ["r4"]);
  const empty = await repository.journalPage("history", first.through_cursor, first.through_cursor, 2);
  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.runs, []);
  assert.equal(empty.cursor, first.through_cursor);
  assert.equal(empty.has_more, false);
  await assert.rejects(repository.journalPage("history", later.cursor + 100, first.through_cursor, 2), RangeError);
  await assert.rejects(repository.journalPage("history", 0, later.cursor + 100, 2), RangeError);
  await repository.transitionRun("r4", "interrupted", "executor lost");
  const interrupted = await repository.recoverySnapshot("history", []);
  assert.deepEqual(interrupted.runs.map((run) => [run.id, run.status]), [["r4", "interrupted"]]);
  assert.deepEqual(interrupted.events, []);
  await assert.rejects(repository.journalPage("missing", 0), { code: "conversation_not_found" });
  await assert.rejects(repository.recoverySnapshot("missing", []), { code: "conversation_not_found" });
}));
