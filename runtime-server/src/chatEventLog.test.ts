import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { InMemoryConversationRepository, PostgresConversationRepository, type AcceptSubmissionInput, type ConversationRepository } from "./conversationRepository.js";
import { boundToolValue, publicLogEvents, runText, type LogRow } from "./chat/publicLog.js";
import { PostgresStore } from "./postgresStore.js";
import { RunFenced } from "./runHold.js";
import { LocalRuntimeAuthority, RuntimeStore, type StoreEvent } from "./store.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"c".repeat(24)}:log`;
const accept = (n: number, executorId = "exec-a"): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `message-${n}`, inputDigest: `digest-${n}`, corpusDigest: "corpus", executorId },
  canonicalUser: { role: "user", content: `question ${n}` }
});

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; pool?: Pool };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "file" | "postgres", body: (harness: Harness) => Promise<void>): Promise<void> {
  if (name !== "postgres") {
    const root = name === "file" ? await mkdtemp(path.join(os.tmpdir(), "hatch-log-")) : undefined;
    const authority = new LocalRuntimeAuthority(root);
    const repository = new InMemoryConversationRepository(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "log" });
      await body({ repository, store: new RuntimeStore(authority) });
    } finally {
      await repository.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
    return;
  }
  const schema = `log_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "log" });
    await body({ repository, store, pool });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

const text = (run_id: string, content: string, run_seq?: number, conversation_id = id) =>
  ({ type: "assistant.text", conversation_id, run_id, content, ...(run_seq ? { run_seq } : {}) }) as const;

for (const backend of ["memory", "file", "postgres"] as const) {
  const options = { skip: backend === "postgres" && !databaseUrl };

  test(`${backend}: a repeated (run_id, run_seq) is the same event: one row, the same position`, options, async () => withBackend(backend, async ({ store }) => {
    const first = await store.append(text("run-a", "one", 1));
    const second = await store.append(text("run-a", "two", 2));
    assert.ok(second > first);
    assert.equal(await store.append(text("run-a", "one, again", 1)), first);
    assert.equal(await store.maxRunSeq("run-a"), 2);
    assert.equal(await store.maxRunSeq("run-none"), 0);
    // Another Run's seq 1 is its own event; an event without a seq is never a duplicate.
    const other = await store.append(text("run-b", "other", 1));
    assert.ok(other > second);
    const plainA = await store.append(text("run-a", "plain"));
    const plainB = await store.append(text("run-a", "plain"));
    assert.ok(plainB > plainA);
    const page = await store.readLogPage(id, { after: 0, limit: 50 });
    assert.deepEqual(page.events.filter((event) => event.run_id === "run-a").map((event) => event.content), ["one", "two", "plain", "plain"]);
    assert.equal(page.head, plainB);
  }));

  test(`${backend}: concurrent appenders get distinct increasing positions, and a repeated seq among them writes once`, options, async () => withBackend(backend, async ({ store }) => {
    const positions = await Promise.all(Array.from({ length: 30 }, (_, n) => store.append(text("run-c", `t${n}`, (n % 20) + 1))));
    assert.equal(new Set(positions).size, 20, "30 writes of 20 distinct seqs are 20 events");
    const page = await store.readLogPage(id, { after: 0, limit: 100 });
    assert.deepEqual(page.events.map((event) => event.position), [...page.events.map((event) => event.position)].sort((a, b) => a - b));
    assert.equal(page.events.length, 20);
  }));

  test(`${backend}: a fenced append writes nothing and no position is taken`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(accept(1));
    await assert.rejects(store.append(text(run.id, "late", 1), { heldBy: "someone-else" }), RunFenced);
    assert.equal(await store.maxRunSeq(run.id), 0);
    await store.append(text(run.id, "mine", 1), { heldBy: "exec-a" });
    assert.equal(await store.maxRunSeq(run.id), 1);
  }));

  test(`${backend}: the log pages by position and by turns`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const first: number[] = [];
    for (let n = 1; n <= 4; n++) {
      const { run } = await repository.acceptSubmission(accept(n));
      await store.append(text(run.id, `answer ${n}`, 1));
      await repository.endRun(run.id, { status: "completed", reply: { message: { role: "assistant", content: `answer ${n}` }, finishReason: "stop" } });
      first.push((await store.readLogPage(id, { after: 0, limit: 500 })).events.find((event) => event.run_id === run.id)!.position);
    }
    const all = await store.readLogPage(id, { after: 0, limit: 500 });
    assert.equal(all.has_more, false);
    assert.ok(all.events.length > 12);

    // Pages follow each other without a gap or a repeat, and end at the head.
    const walked: number[] = [];
    for (let after = 0, more = true; more;) {
      const page = await store.readLogPage(id, { after, limit: 5 });
      assert.ok(page.events.length <= 5);
      walked.push(...page.events.map((event) => event.position));
      more = page.has_more;
      after = page.events.at(-1)?.position ?? page.head;
    }
    assert.deepEqual(walked, all.events.map((event) => event.position));
    assert.equal((await store.readLogPage(id, { after: all.head, limit: 5 })).events.length, 0);

    // Turns: the newest two, then the two before them; the reply row of an ended Run is the model's, not the log's.
    const newest = await store.readLogTurns(id, { turns: 2 });
    assert.deepEqual([...new Set(newest.events.map((event) => event.run_id))], ["run-3", "run-4"]);
    assert.equal(newest.start, first[2]);
    assert.equal(newest.has_more_before, true);
    assert.equal(newest.head, all.head);
    const older = await store.readLogTurns(id, { turns: 2, before: newest.start });
    assert.deepEqual([...new Set(older.events.map((event) => event.run_id))], ["run-1", "run-2"]);
    assert.equal(older.has_more_before, false);
    assert.ok(older.events.every((event) => event.position < newest.start));
    assert.deepEqual([...older.events, ...newest.events].map((event) => event.position), all.events.map((event) => event.position));
    assert.deepEqual((await store.readLogTurns(id, { turns: 10 })).events.map((event) => event.position), all.events.map((event) => event.position));
  }));

  test(`${backend}: every Run status change is one run.state row, a retry supersedes, a lapsed compaction is swept`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(accept(1));
    await repository.transitionRun(run.id, "running", undefined, { heldBy: "exec-a" });
    await repository.transitionRun(run.id, "running");
    await repository.transitionRun(run.id, "waiting_for_tool", "tool", { heldBy: "exec-a" });
    await repository.endRun(run.id, { status: "failed", failure: { code: "run_failed", message: "boom" } });
    const retried = await repository.acceptRetry({ binding, run: { id: "run-retry", conversationId: id, clientMessageId: "retry-1", corpusDigest: "corpus", executorId: "exec-a" } });
    assert.equal(retried.created, true);
    const states = (await store.readLogPage(id, { after: 0, limit: 100 })).events.filter((event) => event.type === "run.state" || event.type === "run.superseded");
    assert.deepEqual(states.map((event) => [event.type, event.run_id, event.status ?? event.by]), [
      ["run.state", "run-1", "queued"], ["run.state", "run-1", "running"], ["run.state", "run-1", "waiting_for_tool"], ["run.state", "run-1", "failed"],
      ["run.state", "run-retry", "queued"], ["run.superseded", "run-1", "run-retry"]
    ] as never);
    assert.deepEqual(states.find((event) => event.status === "failed")?.failure, { code: "run_failed", message: "boom" });
    assert.equal(states.find((event) => event.status === "waiting_for_tool")?.reason, "tool");
    await repository.endRun("run-retry", { status: "cancelled", failure: { code: "run_cancelled", message: "stopped" } });

    const swept = await repository.beginCompaction({ id: "cmp-1", conversationId: id, executorId: "a", leaseMs: -1000 });
    assert.equal(swept.claimed, true);
    const second = await repository.beginCompaction({ id: "cmp-2", conversationId: id, executorId: "b", leaseMs: 60_000 });
    assert.equal(second.claimed, true);
    const ended = (await store.readLogPage(id, { after: 0, limit: 100 })).events.filter((event) => event.type === "compaction.ended");
    assert.deepEqual(ended.map((event) => [event.compaction_id, event.aborted]), [["cmp-1", true]]);
  }));

  test(`${backend}: a steered message is queued, then claimed in place: [A, steps, M, B], never at the top`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(accept(1));
    await repository.transitionRun(run.id, "running", undefined, { heldBy: "exec-a" });
    await store.append(text(run.id, "A", 1));
    await store.append({ type: "tool.call", conversation_id: id, run_id: run.id, tool_call_id: "t1", name: "file_read", arguments: { path: "x" }, status: "completed", locality: "server", approval: "none", run_seq: 2 });
    const steer = await repository.acceptSubmission({ ...accept(2), run: { ...accept(2).run, id: "run-2" } });
    assert.equal(steer.steered, true);
    const beforeClaim = (await store.readLogPage(id, { after: 0, limit: 100 })).events;
    assert.deepEqual(beforeClaim.filter((event) => event.type === "message.queued").map((event) => [event.id, event.content]), [["message-2", "question 2"]]);
    assert.equal(beforeClaim.some((event) => event.type === "user.message" && event.id === "message-2"), false, "not a message of the Run until the Run claims it");

    await repository.claimSteeredMessages(run.id, { heldBy: "exec-a" });
    await store.append(text(run.id, "B", 3));
    const events = (await store.readLogPage(id, { after: 0, limit: 100 })).events;
    const shape = events.filter((event) => ["user.message", "assistant.text", "tool.call", "message.queued"].includes(event.type))
      .map((event) => `${event.type}:${event.id ?? event.content ?? event.tool_call_id}`);
    assert.deepEqual(shape, ["user.message:message-1", "assistant.text:A", "tool.call:t1", "message.queued:message-2", "user.message:message-2", "assistant.text:B"]);
  }));

  test(`${backend}: a conversation written before the log reads as before: one assistant.reply per Run, its steps inside it`, options, async () => withBackend(backend, async ({ store }) => {
    const at = "2026-11-01T00:00:00.000Z";
    const legacy = async (event: object) => store.append({ conversation_id: id, timestamp: at, ...event } as never);
    await legacy({ type: "conversation.model_message", run_id: "old-1", client_message_id: "m-old", message: { role: "user", content: "read it" } });
    await legacy({ type: "turn.state", run_id: "old-1", to: "queued" });
    await legacy({ type: "tool.call", run_id: "old-1", tool_call_id: "t1", name: "file_read", arguments: { path: "a" }, status: "requested", locality: "server" });
    await legacy({ type: "tool.call", run_id: "old-1", tool_call_id: "t1", name: "file_read", arguments: { path: "a" }, status: "completed", locality: "server", result: { big: "x".repeat(5000) } });
    await legacy({ type: "conversation.model_message", run_id: "old-1", message: { role: "assistant", content: "Before.After." }, finish_reason: "stop",
      visible_parts: [{ type: "text", start: 0, end: 7 }, { type: "tool_call", tool_call_id: "t1" }, { type: "text", start: 7, end: 13 }] });
    // A Run that died with nothing to show keeps showing its steps as they were.
    await legacy({ type: "conversation.model_message", run_id: "old-2", client_message_id: "m-old-2", message: { role: "user", content: "again" } });
    await legacy({ type: "tool.call", run_id: "old-2", tool_call_id: "t9", name: "web_search", arguments: {}, status: "requested", locality: "server" });
    await legacy({ type: "conversation.compacted", run_id: "old-2", trigger: "auto", phase: "pre_turn", reason: "context_limit", message: "m", replacement_history: [] });

    const { events, head } = await store.readLogPage(id, { after: 0, limit: 100 });
    assert.equal(head, 8);
    assert.deepEqual(events.map((event) => [event.position, event.type]), [
      [1, "user.message"], [2, "run.state"], [5, "assistant.reply"], [6, "user.message"], [7, "tool.call"]
    ]);
    assert.equal(events[0]!.id, "m-old");
    const reply = events[2]!;
    assert.equal(reply.id, "old-1:1");
    assert.equal(reply.finish_reason, "stop");
    const entries = reply.entries as Array<{ kind: string; content?: string; tool?: { tool_call_id: string; status: string; result: unknown; detail_ref: unknown } }>;
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.content ?? entry.tool?.tool_call_id]), [["text", "Before."], ["tool", "t1"], ["text", "After."]]);
    assert.equal(entries[1]!.tool?.status, "completed");
    assert.deepEqual(entries[1]!.tool?.detail_ref, { run_id: "old-1", tool_call_id: "t1" });
    assert.equal((entries[1]!.tool?.result as { truncated?: boolean }).truncated, true, "a result of an old Run is bounded as it is read");

    // A window that starts after the steps still shows them inside the reply, and shows none of them twice.
    const tail = await store.readLogPage(id, { after: 4, limit: 100 });
    assert.deepEqual(tail.events.map((event) => event.type), ["assistant.reply", "user.message", "tool.call"]);
    assert.equal((tail.events[0]!.entries as unknown[]).length, 3);
    const turns = await store.readLogTurns(id, { turns: 1 });
    assert.deepEqual(turns.events.map((event) => event.type), ["user.message", "tool.call"]);
    assert.equal(turns.has_more_before, true);
  }));
}

test("publicLogEvents: an old Run's status is the one the Runs table has, a new Run's own rows are never read as old", () => {
  const row = (position: number, event: object): LogRow => ({ position, event: { conversation_id: "c", timestamp: "t", ...event } as StoreEvent });
  const rows = [
    row(1, { type: "turn.state", run_id: "old", to: "queued" }),
    row(2, { type: "turn.state", run_id: "new", to: "queued" }),
    row(3, { type: "assistant.text", run_id: "new", content: "hi", run_seq: 1 }),
    row(4, { type: "conversation.model_message", run_id: "new", message: { role: "assistant", content: "hi" }, finish_reason: "stop" })
  ];
  const events = publicLogEvents(rows, { runStates: new Map([["old", { status: "failed", failure: { code: "run_failed", message: "x" } }]]) });
  assert.deepEqual(events.map((event) => [event.position, event.type, event.status]), [[1, "run.state", "failed"], [2, "run.state", "queued"], [3, "assistant.text", undefined]]);
  assert.deepEqual(events[0]!.failure, { code: "run_failed", message: "x" });
});

test("runText keeps the words a Run streamed, a paragraph apart where a step stood between, and nothing when the guard blocked it", () => {
  const e = (event: object) => ({ conversation_id: "c", run_id: "r", timestamp: "t", ...event }) as StoreEvent;
  const rows = [e({ type: "assistant.text", content: "One. " }), e({ type: "assistant.text", content: "Two." }), e({ type: "tool.call", tool_call_id: "t", name: "n", arguments: {}, status: "completed" }), e({ type: "assistant.text", content: "Three." })];
  assert.equal(runText(rows, "r"), "One. Two.\n\nThree.");
  assert.equal(runText([...rows, e({ type: "reply.blocked" })], "r"), "");
  assert.equal(runText(rows, "other"), "");
});

test("boundToolValue keeps a small value whole and cuts a large one to its first 2 KB", () => {
  assert.deepEqual(boundToolValue({ a: 1 }), { a: 1 });
  const cut = boundToolValue({ data: "x".repeat(5000) }) as { truncated: boolean; text: string };
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 2048);
});

test("postgres: appends of one conversation commit in the order they take positions", { skip: !databaseUrl }, async () => withBackend("postgres", async ({ pool, store }) => {
  const first = store as PostgresStore;
  const second = new PostgresStore(pool!);
  await first.ensureSchema();
  await second.ensureSchema();
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const held = await first.appendOn(client, { type: "assistant.text", conversation_id: id, run_id: "run-p", content: "in a transaction", timestamp: "t" });
    // Another writer of the same conversation waits for that transaction instead of committing a higher position first.
    let done = false;
    const other = second.append(text("run-q", "autocommit", 1)).then((position) => { done = true; return position; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(done, false, "the later position cannot commit before the earlier one");
    await client.query("COMMIT");
    assert.ok(await other > held);
  } finally {
    client.release();
  }
  const page = await first.readLogPage(id, { after: 0, limit: 10 });
  assert.deepEqual(page.events.map((event) => event.content), ["in a transaction", "autocommit"]);
}));

test("postgres: a store of an existing deployment gains run_seq and its unique index without losing a row", { skip: !databaseUrl }, async () => {
  const schema = `log_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE hatch_conversation_events (id BIGSERIAL PRIMARY KEY, conversation_id TEXT, run_id TEXT, event_type TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`INSERT INTO hatch_conversation_events (conversation_id, run_id, event_type, payload) VALUES ('c', 'r', 'assistant.text', '{"type":"assistant.text","conversation_id":"c","run_id":"r","content":"old","timestamp":"t"}')`);
    const store = await PostgresStore.open({ pool });
    assert.equal(await store.maxRunSeq("r"), 0);
    assert.equal(await store.append(text("r", "new", 1, "c")), 2);
    assert.equal(await store.append(text("r", "new again", 1, "c")), 2);
    assert.deepEqual((await store.readLogPage("c", { after: 0, limit: 10 })).events.map((event) => event.content), ["old", "new"]);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
