import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { LocalRuntimeAuthority, RuntimeStore, type PublicLogEvent } from "../store.js";
import { LogTail } from "./logTail.js";
import { RunEventHub } from "./runEventHub.js";
import { RunLog } from "./runLog.js";

const id = `scope:${"e".repeat(24)}:log`;
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 300 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition());
};

async function fixture(flushMs = 20) {
  const authority = new LocalRuntimeAuthority();
  const store = new RuntimeStore(authority);
  await new InMemoryConversationRepository(authority).createConversation({ ownerAccountId: "o", creatorId: "c", agentId: "a", productId: "p", corpusDigest: "d", id, publicId: "log" });
  const hub = new RunEventHub(undefined, (conversationId) => store.logHead(conversationId));
  const told: number[] = [];
  hub.subscribe(id, (position) => told.push(position));
  const open = (runId = "r", flushBytes?: number) => RunLog.open({ store, hub, conversationId: id, runId, flushMs, flushBytes });
  return { store, hub, told, open, authority };
}
const texts = (events: PublicLogEvent[]) => events.filter((event) => event.type === "assistant.text").map((event) => (event as unknown as { content: string }).content);

test("text deltas are joined into few rows, kept in order with other events, and observers are told after the append", async () => {
  const { store, told, open } = await fixture();
  const log = await open();
  for (const piece of ["Hel", "lo ", "wor", "ld"]) log.text(piece);
  assert.equal((await store.readLogPage(id, { after: 0, limit: 50 })).events.length, 0, "nothing is written until the interval, the size or another event");
  await log.append({ type: "tool.call", conversation_id: id, run_id: "r", tool_call_id: "t1", name: "ls", arguments: {}, status: "requested", locality: "server", approval: "none" });
  log.text("after the tool");
  await log.flush();
  const events = (await store.readLogPage(id, { after: 0, limit: 50 })).events;
  assert.deepEqual(events.map((event) => event.type), ["assistant.text", "tool.call", "assistant.text"], "the text before the tool call is written before it");
  assert.deepEqual(texts(events), ["Hello world", "after the tool"]);
  assert.equal(told.length, 3);
  assert.equal(told.at(-1), (await store.logHead(id)), "told the position that was committed");
});

test("text is written by itself after the interval, and a large piece goes at once", async () => {
  const { store, open } = await fixture(30);
  const log = await open("r", 10);
  log.text("short");
  await waitFor(() => false || true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(texts((await store.readLogPage(id, { after: 0, limit: 50 })).events), ["short"]);
  log.text("0123456789ABCDEF");
  await log.flush();
  assert.deepEqual(texts((await store.readLogPage(id, { after: 0, limit: 50 })).events), ["short", "0123456789ABCDEF"]);
});

test("a retried write lands once: a failure after the commit is retried with the same run_seq, and a taken-over Run continues the sequence", async () => {
  const { store, hub, open } = await fixture();
  let failNext = true;
  const flaky = new Proxy(store, { get: (target, key) => key === "append"
    ? async (event: Parameters<RuntimeStore["append"]>[0]) => { const position = await target.append(event); if (failNext) { failNext = false; throw new Error("connection lost after commit"); } return position; }
    : (Reflect.get(target, key, target) as unknown) instanceof Function ? (Reflect.get(target, key, target) as (...a: unknown[]) => unknown).bind(target) : Reflect.get(target, key, target) });
  const log = await RunLog.open({ store: flaky, hub, conversationId: id, runId: "r" });
  await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: "once" });
  assert.deepEqual(texts((await store.readLogPage(id, { after: 0, limit: 50 })).events), ["once"]);
  assert.equal(await store.maxRunSeq("r"), 1);
  // The same (run_id, run_seq) written again is the same event.
  const first = await store.append({ type: "assistant.text", conversation_id: id, run_id: "r", run_seq: 1, content: "once" });
  assert.equal(first, await store.append({ type: "assistant.text", conversation_id: id, run_id: "r", run_seq: 1, content: "once" }));
  const takenOver = await open("r");
  await takenOver.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: "next" });
  assert.equal(await store.maxRunSeq("r"), 2);
  assert.deepEqual(texts((await store.readLogPage(id, { after: 0, limit: 50 })).events), ["once", "next"]);
});

test("a tail replays what follows `after`, then streams, with no gap and no duplicate while appends race the subscription", async () => {
  const { store, hub, open } = await fixture(5);
  const log = await open("r", 1);
  for (let n = 0; n < 5; n++) await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: `m${n}` });
  const got: number[] = [];
  const contents: string[] = [];
  const tail = new LogTail({ source: store, hub, pollMs: 40 });
  const stop = tail.attach(id, 2, { push: (event) => { got.push(event.position as number); contents.push(event.content as string); } });
  for (let n = 5; n < 40; n++) { await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: `m${n}` }); if (n % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 3)); }
  await waitFor(() => contents.length === 38);
  stop();
  assert.deepEqual(contents, Array.from({ length: 38 }, (_, n) => `m${n + 2}`), "from position 3 on, in order, once each");
  assert.deepEqual(got, [...got].sort((a, b) => a - b));
  assert.equal(new Set(got).size, got.length);
});

test("a tail without a position starts from where the log stands, and a missed notification is made up by the safety poll", async () => {
  const { store, open } = await fixture(5);
  const log = await open("r", 1);
  await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: "old" });
  const silentHub = new RunEventHub(undefined, async () => 0);
  const seen: string[] = [];
  const stop = new LogTail({ source: store, hub: silentHub, pollMs: 20 }).attach(id, undefined, { push: (event) => { seen.push(event.content as string); } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: "new" });
  await waitFor(() => seen.length === 1);
  stop();
  assert.deepEqual(seen, ["new"]);
});

test("a consumer that throws is let go and the tail stops", async () => {
  const { store, hub, open } = await fixture(5);
  const log = await open("r", 1);
  let calls = 0;
  const stop = new LogTail({ source: store, hub, pollMs: 20 }).attach(id, 0, { push: () => { calls++; const error = new Error("slow"); error.name = "SlowConsumerError"; throw error; } });
  await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: "a" });
  await waitFor(() => calls >= 1);
  await log.append({ type: "assistant.text", conversation_id: id, run_id: "r", content: "b" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1);
  stop();
});
