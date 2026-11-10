import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository, type AcceptSubmissionInput, type ConversationRunRecord } from "../conversationRepository.js";
import type { ConversationMessage } from "../protocol.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { ChatRuntime } from "./chatRuntime.js";
import { ToolRecovery } from "./toolRecovery.js";
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
async function cluster(options: { toolTimeoutMs?: number } = {}) {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id: conversationId, publicId: "restart" });
  const instance = (runner: TurnRunner<object>) => new ChatRuntime<object>({
    repository, store, runner, scopes: { resolve: async () => ({}) }, admission: { reserve: () => () => undefined },
    toolTimeoutMs: options.toolTimeoutMs ?? 60_000, leaseMs: 60_000, sweepMs: 60_000, toolPollMs: 15,
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

test("a Run waiting for a local tool survives a restart, takes the answer from any instance, and continues from the transcript", async () => {
  const { repository, store, instance } = await cluster();
  const first = instance(asker(store, "file_read", "call_1", { path: "a.md" }));
  const run = await startFirst(repository, first);
  await settled(async () => (await repository.getRun(conversationId, run.id))!.status === "waiting_for_tool" && (await repository.listToolCalls(run.id)).length === 1, "first instance waits");

  const seen: Array<{ input: Turn<object>["input"]; tail: ConversationMessage[] }> = [];
  const second = instance(finishing(seen, store));
  const third = instance(finishing(seen, store));
  await second.supervisor.sweep();
  // Taken over: still waiting for the tool, neither interrupted nor failed, and the request is visible from any instance.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await repository.getRun(conversationId, run.id))!.status, "waiting_for_tool");
  assert.deepEqual((await third.pendingToolRequests(conversationId)).map((request) => [request.tool_call_id, request.name]), [["call_1", "file_read"]]);

  const answer = { type: "tool_call.result" as const, run_id: run.id, tool_call_id: "call_1", status: "ok" as const, result: { content: "hello from a.md" } };
  assert.equal(await third.supervisor.deliverToolResult(conversationId, run.id, answer), true);
  assert.equal(await third.supervisor.deliverToolResult(conversationId, run.id, answer), false, "the first answer wins");
  await settled(async () => (await repository.getRun(conversationId, run.id))!.status === "completed", "run completes");

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.input.task_start, true, "continued from the transcript, not prompted again");
  assert.equal(seen[0]!.tail.at(-1)!.role, "tool");
  assert.match(seen[0]!.tail.at(-1)!.tool_content![0]!.type === "text" ? (seen[0]!.tail.at(-1)!.tool_content![0] as { text: string }).text : "", /hello from a\.md/);
  assert.deepEqual(await third.pendingToolRequests(conversationId), []);
  await Promise.all([second.stop(), third.stop()]);
});

test("a local tool nobody answers times out durably and the Run resumes with an error result", async () => {
  const { repository, store, instance } = await cluster({ toolTimeoutMs: 60 });
  const first = instance(asker(store, "file_read", "call_1", { path: "a.md" }));
  const run = await startFirst(repository, first);
  await settled(async () => (await repository.listToolCalls(run.id)).length === 1, "call recorded");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const seen: Array<{ input: Turn<object>["input"]; tail: ConversationMessage[] }> = [];
  const second = instance(finishing(seen, store));
  await second.supervisor.sweep();
  await settled(async () => (await repository.getRun(conversationId, run.id))!.status === "completed", "run completes");
  const result = seen[0]!.tail.at(-1)!;
  assert.equal(result.tool_is_error, true);
  assert.match(JSON.stringify(result.tool_content), /Timed out waiting for client tool result: file_read/);
  await second.stop();
});

test("a server tool that may have had an effect interrupts the Run and is never run again", async () => {
  const { repository, store, instance } = await cluster();
  const first = instance({ run: async () => new Promise(() => undefined) });
  const run = await startFirst(repository, first);
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: run.id, message: callMessage("call_9", "api.request") });
  const seen: Array<{ input: Turn<object>["input"]; tail: ConversationMessage[] }> = [];
  const second = instance(finishing(seen, store));
  await second.supervisor.sweep();
  const after = (await repository.getRun(conversationId, run.id))!;
  assert.equal(after.status, "interrupted");
  assert.match(after.failure!.message, /api\.request.*may or may not have had an effect/);
  assert.deepEqual(seen, [], "the Run did not execute again");
  await second.stop();
});

test("the recovery policy: finished calls are never repeated, read-only calls are reissuable, others interrupt", async () => {
  const records: never[] = [];
  const recovery = new ToolRecovery({ repository: { listToolCalls: async () => records } });
  const finished: ConversationMessage[] = [{ role: "user", content: "q" }, callMessage("a", "api.request"), { role: "tool", content: null, tool_call_id: "a", tool_name: "api.request", tool_content: [{ type: "text", text: "{}" }] }];
  assert.deepEqual(await recovery.plan({ id: "r" }, finished), { kind: "ready", results: [] });
  const readOnly = await recovery.plan({ id: "r" }, [{ role: "user", content: "q" }, callMessage("b", "hatch.web_search")]);
  assert.equal(readOnly.kind, "ready");
  if (readOnly.kind === "ready") assert.match(JSON.stringify(readOnly.results), /did not run; call it again/);
  const effectful = await recovery.plan({ id: "r" }, [{ role: "user", content: "q" }, callMessage("c", "api.request")]);
  assert.equal(effectful.kind, "interrupt");
  const local = await recovery.plan({ id: "r" }, [{ role: "user", content: "q" }, callMessage("d", "file_write")]);
  assert.equal(local.kind, "ready");
});
