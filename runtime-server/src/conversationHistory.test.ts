import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { RuntimeStore } from "./store.js";
import { PostgresStore } from "./postgresStore.js";
import { HistoryCursorError, historyBoundary, historyCursor } from "./conversationHistory.js";

test("history cursors bind conversation and preserve bigint boundaries", () => {
  const cursor = historyCursor("conversation-a", "9007199254740993");
  assert.equal(historyBoundary("conversation-a", cursor), "9007199254740993");
  for (const invalid of ["", "broken", cursor + "=", historyCursor("conversation-a", "0"), historyCursor("conversation-a", "9223372036854775808")]) {
    assert.throws(() => historyBoundary("conversation-a", invalid), HistoryCursorError);
  }
  assert.throws(() => historyBoundary("conversation-b", cursor), (error: unknown) => error instanceof HistoryCursorError && error.code === "history_cursor_invalid");
});

const attachment = {
  kind: "asset" as const, attachment_id: "attachment_old", asset_id: "asset_old",
  display_name: "original.png", media_type: "image/png", source_bytes: 123,
  sha256: "a".repeat(64), storage_ref: "oss://private/unchanged-original"
};

async function verifyHistory(store: RuntimeStore): Promise<void> {
  const timestamp = "2026-09-08T00:00:00.000Z";
  for (let i = 0; i < 31; i++) {
    const run_id = `run-${i}`;
    await store.append({ type: "conversation.model_message", conversation_id: "history", run_id,
      message: { role: "user", content: `question-${i}`, ...(i === 0 ? { attachments: [attachment] } : {}) }, timestamp });
    // A legacy projection must not double either the count or the rendered user message.
    await store.append({ type: "message.created", conversation_id: "history", run_id, role: "user", content: `question-${i}`, timestamp });
    await store.append({ type: "conversation.model_message", conversation_id: "history", run_id,
      message: { role: "assistant", content: "" }, timestamp });
    if (i === 30) {
      await store.append({ type: "tool.call", conversation_id: "history", run_id, tool_call_id: "large-tool", name: "file_read",
        arguments: { path: "/actual-path" }, status: "requested", timestamp });
      await store.append({ type: "tool.call", conversation_id: "history", run_id, tool_call_id: "large-tool", name: "file_read",
        arguments: { path: "/actual-path" }, status: "completed", result: { data_base64: "x".repeat(9 * 1024 * 1024) }, timestamp });
      await store.append({ type: "skill.run", conversation_id: "history", run_id, skill_run_id: "skill-1", skill_id: "skill", name: "Research", status: "completed", timestamp });
    }
    await store.append({ type: "conversation.model_message", conversation_id: "history", run_id,
      message: { role: "assistant", content: `answer-${i}` }, finish_reason: "stop",
      visible_parts: [{ type: "text", start: 0, end: `answer-${i}`.length }], timestamp });
  }
  await store.append({ type: "turn.state", conversation_id: "history", run_id: "invisible-run", to: "running", timestamp });
  await store.append({ type: "conversation.model_message", conversation_id: "history", run_id: "task-only",
    message: { role: "user", kind: "task_start", content: "Start task" }, timestamp });
  await store.append({ type: "conversation.compacted", conversation_id: "history", run_id: "compaction-only",
    trigger: "auto", phase: "pre_turn", reason: "context_limit", message: "compacted",
    replacement_history: [{ role: "user", content: "summary without the original attachment" }], timestamp });
  const page = await store.readVisibleConversationPage("history");
  assert.equal(page.messages.length, 50);
  assert.equal(page.run_ids.length, 25);
  assert.equal(page.has_more, true);
  assert.equal(page.messages[0]?.content, "question-6");
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50_000);
  const last = page.messages.at(-1)!;
  assert.equal(last.content, "answer-30");
  assert.deepEqual(last.parts, [{ type: "text", start: 0, end: 9 }]);
  assert.equal(last.skill_runs?.[0]?.name, "Research");
  assert.deepEqual(last.tool_calls?.[0]?.detail_ref, { run_id: "run-30", tool_call_id: "large-tool" });
  assert.equal(last.tool_calls?.[0]?.result, undefined);
  const small = await store.readVisibleConversationPage("history", { limit: 1 });
  assert.equal(small.messages.length, 2, "whole turn survives an odd message budget");
  assert.equal(small.messages.at(-1)?.id, last.id);
  assert.equal(new Set(page.messages.map((message) => message.id)).size, 50, "identical timestamps cannot collide");
  // Later events on an old run and new runs must not move old turns across the cursor.
  await store.append({ type: "turn.state", conversation_id: "history", run_id: "run-0", to: "completed", timestamp });
  await store.append({ type: "message.created", conversation_id: "history", run_id: "new-run", role: "user", content: "new", timestamp });
  const older = await store.readVisibleConversationPage("history", { beforeCursor: page.before_cursor });
  assert.equal(older.messages.length, 12);
  assert.deepEqual(older.run_ids, Array.from({ length: 6 }, (_, i) => `run-${i}`));
  assert.equal(older.has_more, false);
  assert.equal(older.before_cursor, undefined);
  assert.deepEqual(older.messages[0]?.attachments, [attachment]);
  const detail = await store.readConversationToolDetail("history", "run-30", "large-tool");
  assert.equal((detail?.result as { data_base64: string }).data_base64.length, 9 * 1024 * 1024);
  assert.equal(detail?.arguments.path, "/actual-path");
  assert.equal(await store.readConversationToolDetail("other", "run-30", "large-tool"), undefined);
  assert.equal(await store.readConversationToolDetail("history", "run-0", "large-tool"), undefined);
  assert.deepEqual(await store.readConversationAssetReference("history", "asset_old"), attachment);
  assert.equal(await store.readConversationAssetReference("other", "asset_old"), undefined);
  assert.equal(await store.readConversationAssetReference("history", "missing"), undefined);
  assert.deepEqual(await store.readVisibleConversationPage("empty"), { messages: [], run_ids: [], has_more: false });
  await assert.rejects(store.readVisibleConversationPage("other", { beforeCursor: page.before_cursor }), HistoryCursorError);
  await assert.rejects(store.readVisibleConversationPage("history", { limit: 0 }));
}

test("file history pages complete turns, bounded tool projections and durable assets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-history-test-"));
  const store = new RuntimeStore(directory);
  try { await verifyHistory(store); }
  finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("real PostgreSQL history pages without replay caps or full-history payload queries", {
  skip: !process.env.HATCH_HISTORY_TEST_DATABASE_URL
}, async () => {
  const connectionString = process.env.HATCH_HISTORY_TEST_DATABASE_URL;
  const admin = new Pool({ connectionString });
  const schema = `history_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const store = new PostgresStore({ pool, maxReplayEvents: 1, maxReplayBytes: 1024 });
  // Any accidental fallback to the file adapter or unbounded events API fails this test.
  store.readEvents = async () => { throw new Error("Paged PostgreSQL must not read full history"); };
  try {
    await verifyHistory(store);
    await assert.rejects(store.readConversation("history"), /bounded history/);
    const indexes = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1", [schema]);
    assert.ok(indexes.rows.some((row) => /gin.*payload jsonb_path_ops/.test(row.indexdef)));
  } finally {
    await store.close(); await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
  }
});
