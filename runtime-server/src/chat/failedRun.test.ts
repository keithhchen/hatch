import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { UpstreamError } from "../errors/upstream.js";
import type { PublicFailure } from "../errors/failures.js";
import { failRun } from "./modelTurn.js";
import { publicRun } from "./publicRun.js";
import { RunEventHub } from "./runEventHub.js";
import { RunTerminator } from "./runTerminator.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"c".repeat(24)}:failed`;
const submission = (n: number) => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `message-${n}`, inputDigest: `digest-${n}`, corpusDigest: "corpus", executorId: "exec" },
  canonicalUser: { role: "user" as const, content: `question ${n}` }
});

test("a failed Run tells its observers one upstream failure, keeps the messages that joined it, and the REST Run carries the same failure", async () => {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id, publicId: "failed" });
  const first = await repository.acceptSubmission(submission(1));
  await repository.acceptSubmission(submission(2));
  await repository.acceptSubmission(submission(3));
  const hub = new RunEventHub();
  const heard: Array<Record<string, unknown>> = [];
  hub.subscribe(id, { push: (event) => { heard.push(event); } });
  const terminator = new RunTerminator(repository, hub);
  let failedWith: PublicFailure | undefined;

  await failRun({
    run: first.run, conversation: { id } as never, signal: new AbortController().signal,
    state: { fail: async (failure: PublicFailure) => { failedWith = failure; await terminator.end(first.run.id, { status: "failed", failure }); } } as never
  }, new UpstreamError("transient", "moonshot", undefined, "kimi-k3.1-pro stream timed out"));

  const failure = (heard.find((event) => event.type === "turn.failed") as { error: PublicFailure }).error;
  assert.equal(failure.code, "upstream_error");
  assert.match(failure.reference ?? "", /^err_/);
  assert.match(failedWith?.message ?? "", /Reference: err_/);
  const transcript = (await store.readConversation(id)).map((message) => message.content);
  assert.ok(transcript.includes("question 2") && transcript.includes("question 3"));
  const rest = publicRun((await repository.getRun(id, first.run.id))!);
  assert.deepEqual(rest.failure, failure);
  assert.equal(rest.status, "failed");
  await repository.close();
});
