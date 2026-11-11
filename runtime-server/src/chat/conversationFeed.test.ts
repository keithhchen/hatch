import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { ConversationFeed } from "./conversationFeed.js";
import { RunEventHub } from "./runEventHub.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"d".repeat(24)}:feed`;

const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition());
};

async function fixture() {
  const repository = new InMemoryConversationRepository();
  await repository.createConversation({ ...binding, id, publicId: "feed" });
  const hub = new RunEventHub();
  return { repository, hub, feed: new ConversationFeed(repository, hub, 5) };
}

test("a slow or broken sink is dropped without delaying the publisher or the other sinks", () => {
  const hub = new RunEventHub();
  const received: unknown[] = [];
  hub.subscribe(id, { push: () => { throw new Error("socket buffer full"); } });
  hub.subscribe(id, { push: (event) => received.push(event) });
  hub.publish(id, { type: "assistant.delta" });
  hub.publish(id, { type: "assistant.delta" });
  assert.equal(received.length, 2);
});

test("non-streaming sees only durable events, streaming also sees live deltas, same cursors", async () => {
  const { repository, hub, feed } = await fixture();
  const quiet: Record<string, unknown>[] = [];
  const loud: Record<string, unknown>[] = [];
  const stops = [
    feed.attach(id, { afterCursor: 0, stream: false }, { push: (event) => quiet.push(event) }),
    feed.attach(id, { afterCursor: 0, stream: true }, { push: (event) => loud.push(event) })
  ];
  await repository.acceptSubmission({ binding, run: { id: "r", conversationId: id, clientMessageId: "m", inputDigest: "d", corpusDigest: "corpus" }, canonicalUser: { role: "user", content: "hi" } });
  hub.publish(id, { type: "assistant.delta", run_id: "r", delta: { kind: "text", content: "he" } });
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

const textDelta = (run: string, content: string, offset: number) => ({ type: "assistant.delta", run_id: run, delta: { kind: "text", content, offset } });

test("an observer attaching mid-Run is caught up with the Run's text, joined to what it holds by offset", async () => {
  const { hub, feed } = await fixture();
  hub.publish(id, textDelta("r", "Hello ", 0));
  hub.publish(id, textDelta("r", "wor", 6));
  const seen: Record<string, unknown>[] = [];
  const stop = feed.attach(id, { afterCursor: 0, stream: true }, { push: (event) => seen.push(event) });
  hub.publish(id, textDelta("r", "ld", 9));
  stop();
  assert.deepEqual(seen.filter((event) => event.type === "assistant.delta").map((event) => event.delta), [
    { kind: "text", content: "Hello wor", offset: 0 },
    { kind: "text", content: "ld", offset: 9 }
  ]);
  const quiet: Record<string, unknown>[] = [];
  feed.attach(id, { afterCursor: 0, stream: false }, { push: (event) => quiet.push(event) })();
  assert.equal(quiet.some((event) => event.type === "assistant.delta"), false);
});

test("the caught-up text covers the live part only, and ends with the Run", () => {
  const hub = new RunEventHub();
  hub.publish(id, textDelta("r", "ab", 0));
  hub.publish(id, textDelta("r", "ef", 4));
  assert.deepEqual(hub.catchUp(id)?.delta, { kind: "text", content: "ef", offset: 4 });
  hub.publish(id, { type: "turn.state", run_id: "r", status: "completed" });
  assert.equal(hub.catchUp(id), undefined);
});
