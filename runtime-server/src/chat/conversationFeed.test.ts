import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { ConversationFeed } from "./conversationFeed.js";
import { RunEventHub } from "./runEventHub.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"d".repeat(24)}:feed`;

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition());
};

async function fixture() {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id, publicId: "feed" });
  const hub = new RunEventHub(undefined, (conversationId) => store.logHead(conversationId));
  return { repository, hub, store, feed: new ConversationFeed(repository, hub, 5, store) };
}

test("a slow or broken listener is dropped without delaying the appender or the other listeners", () => {
  const hub = new RunEventHub(undefined, async () => 0);
  const received: number[] = [];
  hub.subscribe(id, () => { throw new Error("socket buffer full"); });
  hub.subscribe(id, (position) => received.push(position));
  hub.advanced(id, 1);
  hub.advanced(id, 2);
  assert.deepEqual(received, [1, 2]);
});

test("non-streaming sees only durable events, streaming also sees the Run's text from the log, same cursors", async () => {
  const { repository, hub, feed, store } = await fixture();
  const quiet: Record<string, unknown>[] = [];
  const loud: Record<string, unknown>[] = [];
  const stops = [
    feed.attach(id, { afterCursor: 0, stream: false }, { push: (event) => quiet.push(event) }),
    feed.attach(id, { afterCursor: 0, stream: true }, { push: (event) => loud.push(event) })
  ];
  await repository.acceptSubmission({ binding, run: { id: "r", conversationId: id, clientMessageId: "m", inputDigest: "d", corpusDigest: "corpus" }, canonicalUser: { role: "user", content: "hi" } });
  hub.advanced(id, await store.append({ type: "assistant.text", conversation_id: id, run_id: "r", run_seq: 1, content: "he" }));
  await waitFor(() => quiet.some((event) => event.journal_type === "message.created") && loud.some((event) => event.type === "assistant.delta"));
  assert.equal(quiet.some((event) => event.type === "assistant.delta"), false);
  const cursors = (events: Record<string, unknown>[]) => events.filter((event) => event.type === "journal.event").map((event) => event.cursor);
  await waitFor(() => cursors(quiet).length === cursors(loud).length);
  assert.deepEqual(cursors(quiet), cursors(loud));
  stops.forEach((stop) => stop());
});

test("resuming after a cursor replays only what the client has not seen", async () => {
  const { repository, feed } = await fixture();
  await repository.acceptSubmission({ binding, run: { id: "r", conversationId: id, clientMessageId: "m", inputDigest: "d", corpusDigest: "corpus" }, canonicalUser: { role: "user", content: "hi" } });
  const snapshot = await repository.snapshot(id);
  await repository.transitionRun("r", "running");
  const seen: Record<string, unknown>[] = [];
  const stop = feed.attach(id, { afterCursor: snapshot.cursor, stream: false }, { push: (event) => seen.push(event) });
  await waitFor(() => seen.length > 0);
  assert.deepEqual(seen.map((event) => event.journal_type), ["run.state"]);
  assert.ok((seen[0]!.cursor as number) > snapshot.cursor);
  stop();
});

test("an observer attaching mid-Run is caught up with the Run's text so far, then follows it, with offsets that join", async () => {
  const { hub, feed, store } = await fixture();
  const write = async (seq: number, content: string) => hub.advanced(id, await store.append({ type: "assistant.text", conversation_id: id, run_id: "r", run_seq: seq, content }));
  await write(1, "Hello ");
  await write(2, "wor");
  const seen: Record<string, unknown>[] = [];
  const stop = feed.attach(id, { afterCursor: 0, stream: true }, { push: (event) => seen.push(event) });
  await waitFor(() => seen.filter((event) => event.type === "assistant.delta").length === 2);
  await write(3, "ld");
  await waitFor(() => seen.filter((event) => event.type === "assistant.delta").length === 3);
  stop();
  assert.deepEqual(seen.filter((event) => event.type === "assistant.delta").map((event) => event.delta), [
    { kind: "text", content: "Hello ", offset: 0 },
    { kind: "text", content: "wor", offset: 6 },
    { kind: "text", content: "ld", offset: 9 }
  ]);
});
