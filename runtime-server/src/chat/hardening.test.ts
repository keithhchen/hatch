import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository, type AcceptSubmissionInput, type ConversationRunRecord } from "../conversationRepository.js";
import type { ConversationMessage } from "../protocol.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { ChatRuntime } from "./chatRuntime.js";
import { closeDanglingCalls } from "./toolRecovery.js";
import type { Turn, TurnRunner } from "./turnExecutor.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const conversationId = `scope:${"e".repeat(24)}:restart`;
const submission = (executorId: string): AcceptSubmissionInput => ({
  binding,
  run: { id: "run-1", conversationId, clientMessageId: "m-1", inputDigest: "d-1", corpusDigest: "corpus", executorId,
    // The first instance is gone: its lease has lapsed.
    executorLeaseExpiresAt: new Date(Date.now() - 1_000).toISOString() },
  canonicalUser: { role: "user", content: "read a.md and summarize it" }
});

const settled = async (condition: () => boolean | Promise<boolean>, what = "condition") => {
  for (let i = 0; i < 400; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`${what} not reached`);
};

const callMessage = (id: string, name: string): ConversationMessage => ({
  role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }]
});

/** Two Runtime instances over one durable authority: what one leaves behind, the other finds. */
async function cluster() {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id: conversationId, publicId: "restart" });
  const instance = (runner: TurnRunner<object>) => new ChatRuntime<object>({
    repository, store, runner, scopes: { resolve: async () => ({}) }, admission: { reserve: () => () => undefined },
    toolTimeoutMs: 60_000, leaseMs: 60_000, sweepMs: 60_000, toolPollMs: 15,
    // The compaction strategy is irrelevant here: nothing is large.
    compactionStrategy: () => ({ wants: () => false, tokensOf: () => 0, policy: { prune: 1e9, cacheTtlMs: 1, maxOverflowRetries: 2, timeoutMs: 1000 } }) as never
  });
  return { repository, store, instance };
}

/** The first instance asks a local tool and then "crashes": it is never stopped, its lease is simply taken over. */
const asker = (store: RuntimeStore, name: string, toolCallId: string, args: Record<string, unknown>): TurnRunner<object> => ({
  async run(turn) {
    await turn.state.start();
    await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: turn.run.id, message: callMessage(toolCallId, name) });
    // This promise never settles: the process is gone.
    await turn.broker.execute(turn.run.id, name, args, turn.state, toolCallId).catch(() => undefined);
    await new Promise(() => undefined);
  }
});

const finishing = (seen: Array<{ input: Turn<object>["input"]; tail: ConversationMessage[] }>, store: RuntimeStore): TurnRunner<object> => ({
  async run(turn) {
    await turn.state.start();
    seen.push({ input: turn.input, tail: (await store.readConversation(conversationId)).slice(-2) });
    await turn.state.complete({ message: { role: "assistant", content: "done" }, finishReason: "stop", visibleParts: [] });
  }
});

const startFirst = async (repository: InMemoryConversationRepository, first: ChatRuntime<object>): Promise<ConversationRunRecord> => {
  const { run } = await repository.acceptSubmission(submission(first.supervisor.executorId));
  first.supervisor.adopt(run);
  return run;
};

test("a Run whose instance is lost is interrupted, keeps its partial reply, and the next message starts a fresh Run", async () => {
  const { repository, store, instance } = await cluster();
  const first = instance(asker(store, "file_read", "call_1", { path: "a.md" }));
  const run = await startFirst(repository, first);
  await settled(async () => (await repository.getRun(conversationId, run.id))!.status === "waiting_for_tool" && (await repository.listToolCalls(run.id)).length === 1, "first instance waits");
  await repository.savePartialOutput(run.id, "Let me read a.md");

  const seen: Array<{ input: Turn<object>["input"]; tail: ConversationMessage[] }> = [];
  const second = instance(finishing(seen, store));
  await second.supervisor.sweep();
  const ended = (await repository.getRun(conversationId, run.id))!;
  assert.deepEqual([ended.status, ended.failure?.code], ["interrupted", "run_interrupted"]);
  assert.equal(seen.length, 0, "the Run was not executed again");
  // No spinner: the tool call is closed and nothing waits for it.
  assert.deepEqual(await second.pendingToolRequests(conversationId), []);
  const history = await store.readConversation(conversationId);
  assert.deepEqual(history.slice(-2).map((message) => [message.role, message.tool_call_id ?? message.content]), [["tool", "call_1"], ["assistant", "Let me read a.md"]]);
  assert.equal(history.at(-2)!.tool_is_error, true);

  const next = await repository.acceptSubmission({ ...submission(second.supervisor.executorId), run: { ...submission(second.supervisor.executorId).run, id: "run-2", clientMessageId: "m-2", inputDigest: "d-2", executorLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }, canonicalUser: { role: "user", content: "try again" } });
  assert.equal(next.created, true);
  second.supervisor.adopt(next.run);
  await settled(async () => (await repository.getRun(conversationId, "run-2"))!.status === "completed", "next run completes");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.input.message.content, "try again");
  await second.stop();
});

test("closing dangling calls answers only calls without a result", async () => {
  const { store } = await cluster();
  const run = { id: "run-1", conversationId };
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: run.id, message: callMessage("a", "api.request") });
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: run.id, message: { role: "tool", content: null, tool_call_id: "a", tool_name: "api.request", tool_content: [{ type: "text", text: "{}" }] } });
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: run.id, message: callMessage("b", "hatch.web_search") });
  await closeDanglingCalls(store, run);
  const tools = (await store.readConversation(conversationId)).filter((message) => message.role === "tool");
  assert.deepEqual(tools.map((message) => message.tool_call_id), ["a", "b"]);
  assert.match(JSON.stringify(tools[1]!.tool_content), /may or may not have had an effect/);
  await closeDanglingCalls(store, run);
  assert.equal((await store.readConversation(conversationId)).filter((message) => message.role === "tool").length, 2);
});
