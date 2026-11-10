import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { fenced, RunFenced } from "./runFence.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const conversationId = `scope:${"f".repeat(24)}:fence`;

async function setup() {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id: conversationId, publicId: "fence" });
  const { run } = await repository.acceptSubmission({
    binding, run: { id: "run-1", conversationId, clientMessageId: "m-1", inputDigest: "d", corpusDigest: "corpus", executorId: "a", executorLeaseExpiresAt: new Date(Date.now() - 1000).toISOString() },
    canonicalUser: { role: "user", content: "q" }
  });
  const fencedWrites = {
    fencedRepository: fenced(repository, "a", repository, { transitionRun: (runId: string) => runId, savePartialOutput: (runId: string) => runId }),
    fencedStore: fenced(store, "a", repository, { append: (event: { run_id?: string }) => event.run_id })
  };
  return { repository, store, run, ...fencedWrites };
}

const answer = { type: "conversation.model_message" as const, conversation_id: conversationId, run_id: "run-1", message: { role: "assistant" as const, content: "late" } };

test("the executor writes while it holds the Run", async () => {
  const { run, fencedRepository, fencedStore: store } = await setup();
  await fencedRepository.savePartialOutput(run.id, "hello");
  await store.append(answer);
  await fencedRepository.transitionRun(run.id, "running");
});

test("a stopped executor can write nothing more: not state, not partial output, not the transcript", async () => {
  const { run, repository, store, fencedRepository, fencedStore } = await setup();
  await repository.transitionRun(run.id, "cancelled", "stop");
  await assert.rejects(fencedRepository.savePartialOutput(run.id, "late"), RunFenced);
  await assert.rejects(fencedRepository.transitionRun(run.id, "completed"), RunFenced);
  await assert.rejects(fencedStore.append(answer), RunFenced);
  assert.deepEqual((await store.readConversation(conversationId)).map((message) => message.content), ["q"]);
  assert.equal((await repository.getRun(conversationId, run.id))!.status, "cancelled");
});

test("an executor whose Run another instance took over is fenced by its executor_id", async () => {
  const { run, repository, fencedStore } = await setup();
  await repository.claimOrphanedRuns("b", -1);
  assert.equal((await repository.getRun(conversationId, run.id))!.executorId, "b");
  await assert.rejects(fencedStore.append(answer), RunFenced);
});
