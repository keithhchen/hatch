import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { follow, resumePoint } from "../conversations/follow.js";
import type { LoggedEvent } from "../conversations/eventLog.js";
import { RoutedEventLog } from "../conversations/routedEventLog.js";
import { MemoryEventLog } from "../conversations/eventLog.js";
import {
  InMemoryConversationRepository, PostgresConversationRepository,
  type AcceptSubmissionInput, type ConversationRepository
} from "../conversationRepository.js";
import { RunEventHub } from "../chat/runEventHub.js";
import { RunTerminator } from "../chat/runTerminator.js";
import { PostgresStore } from "../postgresStore.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { JournalFeed } from "./journalFeed.js";
import { assistantConversationId, assistantFeedKey, studioVocabulary } from "./studioVocabulary.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const id = assistantConversationId(ACCOUNT);
const key = assistantFeedKey(ACCOUNT);
const binding = { ownerAccountId: ACCOUNT, creatorId: ACCOUNT, agentId: "assistant", productId: "assistant", corpusDigest: "assistant" };
const message = (n: number): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "assistant", executorId: "exec" },
  canonicalUser: { role: "user", content: `question ${n}` }
});
const reply = (content: string) => ({ status: "completed" as const, reply: { message: { role: "assistant" as const, content }, finishReason: "stop" as const, visibleParts: [] } });

type Harness = { repository: ConversationRepository; hub: RunEventHub; feed: JournalFeed; terminator: RunTerminator };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "postgres", body: (harness: Harness) => Promise<void>): Promise<void> {
  const make = (repository: ConversationRepository): Harness => {
    const hub = new RunEventHub();
    return { repository, hub, feed: new JournalFeed({ repository, hub }), terminator: new RunTerminator(repository, hub) };
  };
  if (name === "memory") {
    const repository = new InMemoryConversationRepository(new LocalRuntimeAuthority());
    try { await repository.createConversation({ ...binding, id, publicId: "assistant" }); await body(make(repository)); } finally { await repository.close(); }
    return;
  }
  const schema = `feed_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "assistant" });
    await body(make(repository));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

test("the vocabulary names every event's Run and message, and carries a failure whole", () => {
  const at = (cursor: number, type: never, payload: Record<string, unknown>) => ({ cursor, conversationId: id, runId: "run-9", type, payload, createdAt: "t" });
  assert.deepEqual(studioVocabulary({ journal: at(1, "message.created" as never, { role: "user", client_message_id: "m-1" }) }), [{ type: "message", run_id: "run-9", message_id: "m-1" }]);
  assert.deepEqual(studioVocabulary({ journal: at(2, "message.created" as never, { role: "assistant", message_id: "run-9:1" }) }), [{ type: "message_end", run_id: "run-9", message_id: "run-9:1" }]);
  const failure = { code: "upstream_error", message: "An upstream service failed. Reference: err_1.", reference: "err_1" };
  assert.deepEqual(studioVocabulary({ journal: at(3, "run.state" as never, { status: "failed", failure }) }), [{ type: "run_end", status: "failed", error: failure, run_id: "run-9" }]);
  assert.deepEqual(studioVocabulary({ journal: at(4, "run.state" as never, { status: "compacting" }) }).map(event => event.type), ["compacting"]);
  // A Run that answers again has no message to announce it: its creation tells observers to look again.
  assert.deepEqual(studioVocabulary({ journal: at(5, "run.created" as never, {}) }), [{ type: "state", run_id: "run-9" }]);
});

test("a step is Chat's own words for it, never its arguments or result, and reasoning is carried in order", () => {
  const call = { run_id: "run-1", tool_call_id: "call-1", name: "list_tasks", activity_message: "看看有什么事项", arguments: { secret: "internal" } };
  const shown = [
    ...studioVocabulary({ hub: { type: "tool_call.delta", ...call, status: "requested" } }),
    ...studioVocabulary({ hub: { type: "tool_call.delta", ...call, status: "completed", result: { secret: "internal" } } }),
    ...[{ kind: "thinking_start", contentIndex: 0 }, { kind: "thinking_delta", contentIndex: 0, delta: "想" }, { kind: "thinking_end", contentIndex: 0, content: "想" }]
      .flatMap(delta => studioVocabulary({ hub: { type: "assistant.delta", run_id: "run-1", delta } }))
  ];
  assert.deepEqual(shown, [
    { type: "tool", name: "list_tasks", id: "call-1", activity: "看看有什么事项", run_id: "run-1" },
    { type: "tool_end", name: "list_tasks", id: "call-1", activity: "看看有什么事项", isError: false, run_id: "run-1" },
    { type: "thinking", contentIndex: 0, run_id: "run-1" },
    { type: "thinking_delta", contentIndex: 0, delta: "想", run_id: "run-1" },
    { type: "thinking_end", contentIndex: 0, content: "想", run_id: "run-1" }
  ]);
  assert.ok(!JSON.stringify(shown).includes("internal"));
  assert.deepEqual(studioVocabulary({ hub: { type: "tool_call.delta", ...call, status: "cancelled" } }), [{ type: "tool_end", name: "list_tasks", id: "call-1", activity: "看看有什么事项", isError: false, cancelled: true, run_id: "run-1" }]);
  assert.deepEqual(studioVocabulary({ hub: { type: "assistant.delta", run_id: "run-1", delta: { kind: "text", content: "你好", offset: 3 } } }), [{ type: "delta", text: "你好", offset: 3, run_id: "run-1" }]);
  assert.deepEqual(studioVocabulary({ hub: { type: "turn.state", run_id: "run-1", status: "completed" } }), [], "what the journal records is not said twice");
});

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? { skip: !databaseUrl, timeout: 30_000 } : {};

  test(`${backend}: a reader that reconnects mid-stream by cursor finds every event once, with no gap and no repeat`, options, async () => withBackend(backend, async ({ repository, hub, feed, terminator }) => {
    const routed = new RoutedEventLog(new MemoryEventLog());
    routed.bind("assistant:", feed);
    const first = await repository.acceptSubmission(message(0));
    const seen: LoggedEvent[] = [];
    const stopFirst = new AbortController();
    // The first connection hears some of it, then breaks.
    void follow(routed, key, "0", entry => { seen.push(entry); if (seen.length === 3) stopFirst.abort(); }, { signal: stopFirst.signal, pollMs: 10 });
    await repository.acceptSubmission(message(1));
    await repository.transitionRun(first.run.id, "running");
    for (let i = 0; i < 100 && seen.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(seen.length, 3);
    // More happens while nobody listens.
    await repository.claimSteeredMessages(first.run.id);
    await terminator.end(first.run.id, reply("answer"));
    const resumed: LoggedEvent[] = [];
    const stopSecond = new AbortController();
    const resumeFrom = await resumePoint(routed, key, seen.at(-1)!.cursor);
    void follow(routed, key, resumeFrom, entry => { resumed.push(entry); }, { signal: stopSecond.signal, pollMs: 10 });
    for (let i = 0; i < 100 && !resumed.some(entry => entry.event.type === "run_end"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    stopSecond.abort();
    const everything = await feed.after(key, "0");
    // One Studio event for each journal event: the cursor names one position, so the two connections together hear exactly the record.
    assert.deepEqual([...seen, ...resumed], everything);
    assert.equal(new Set(everything.map(entry => entry.cursor)).size, everything.length, "no two events share a cursor");
    assert.ok([...seen, ...resumed].every(entry => typeof entry.event.run_id === "string"), "every event names its Run");
    assert.deepEqual([...seen, ...resumed].filter(entry => entry.event.type === "message_end").map(entry => entry.event.message_id), ["run-0:1"]);
    assert.ok(hub);
  }));

  test(`${backend}: what a Run says live reaches a follower before the recorded event it led to, and is never recorded`, options, async () => withBackend(backend, async ({ repository, hub, feed, terminator }) => {
    const first = await repository.acceptSubmission(message(0));
    const heard: string[] = [];
    const stop = new AbortController();
    void follow(feed, key, await feed.head(key), entry => { heard.push(`${entry.event.type}${entry.event.type === "delta" ? `:${entry.event.text}` : ""}`); }, { signal: stop.signal, pollMs: 10 });
    await new Promise(resolve => setTimeout(resolve, 30));
    hub.publish(id, { type: "assistant.delta", run_id: first.run.id, delta: { kind: "text", content: "你", offset: 0 } });
    hub.publish(id, { type: "assistant.delta", run_id: first.run.id, delta: { kind: "text", content: "好", offset: 1 } });
    await terminator.end(first.run.id, reply("你好"));
    for (let i = 0; i < 100 && !heard.includes("run_end"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    stop.abort();
    assert.deepEqual(heard, ["delta:你", "delta:好", "message_end", "run_end"]);
    assert.ok(!(await feed.after(key, "0")).some(entry => entry.event.type === "delta"), "deltas are not in the record");
    // A reader that joins mid-turn is given what was said so far, with its offset.
    const late: Array<Record<string, unknown>> = [];
    const second = await repository.acceptSubmission(message(1));
    hub.publish(id, { type: "assistant.delta", run_id: second.run.id, delta: { kind: "text", content: "再", offset: 0 } });
    feed.live(key, event => { late.push(event); })();
    assert.deepEqual(late, [{ type: "delta", text: "再", offset: 0, run_id: "run-1" }]);
  }));
}

test("a feed refuses to append: the Run's journal is the record", async () => {
  const feed = new JournalFeed({ repository: new InMemoryConversationRepository(new LocalRuntimeAuthority()), hub: new RunEventHub() });
  await assert.rejects(feed.append(), /nothing appends/);
  await assert.rejects(feed.head("research:1"), /not a feed of the Assistant/);
  assert.ok(new RuntimeStore(new LocalRuntimeAuthority()));
});
