import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { UpstreamError } from "../errors/upstream.js";
import { failRun } from "./modelTurn.js";
import type { OutboundMessage } from "../protocol.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"c".repeat(24)}:failed`;
const submission = (n: number) => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `message-${n}`, inputDigest: `digest-${n}`, corpusDigest: "corpus", executorId: "exec" },
  canonicalUser: { role: "user" as const, content: `question ${n}` }
});

test("a failed Run tells its observers one upstream failure and keeps the messages that joined it in the transcript", async () => {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id, publicId: "failed" });
  const first = await repository.acceptSubmission(submission(1));
  await repository.acceptSubmission(submission(2));
  await repository.acceptSubmission(submission(3));
  const published: OutboundMessage[] = [];
  let failedWith: string | undefined;

  await failRun({
    run: first.run, conversation: { id } as never, signal: new AbortController().signal,
    state: { fail: async (reason: string) => { failedWith = reason; } } as never,
    publish: (message) => { published.push(message); },
    claimSteered: async () => (await repository.claimSteeredMessages(first.run.id)).map(({ message }) => message)
  }, new UpstreamError("transient", "moonshot", undefined, "kimi-k2.6 stream timed out"));

  const failure = (published[0] as { error: { code: string; reference?: string } }).error;
  assert.equal(failure.code, "upstream_error");
  assert.match(failure.reference ?? "", /^err_/);
  assert.match(failedWith ?? "", /Reference: err_/);
  const transcript = (await store.readConversation(id)).map((message) => message.content);
  assert.ok(transcript.includes("question 2") && transcript.includes("question 3"));
  await repository.close();
});
