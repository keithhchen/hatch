import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository, type AcceptSubmissionInput } from "../conversationRepository.js";
import { RunEventHub } from "./runEventHub.js";
import { RunSupervisor, type RunExecutor } from "./runSupervisor.js";
import { runTerminators } from "./runTerminator.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const conversationId = `scope:${"e".repeat(24)}:supervisor-terminal`;
const message = (n: number, lease?: string): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "dead", ...(lease ? { executorLeaseExpiresAt: lease } : {}) },
  canonicalUser: { role: "user", content: `q${n}` }
});

async function setup(executor: RunExecutor) {
  const repository = new InMemoryConversationRepository();
  const hub = new RunEventHub();
  await repository.createConversation({ ...binding, id: conversationId, publicId: "supervisor-terminal" });
  const heard: Array<Record<string, unknown>> = [];
  hub.subscribe(conversationId, { push: (event) => { heard.push(event); } });
  const supervisor = (executorId: string) => new RunSupervisor(repository, executor, async () => undefined, { executorId, leaseMs: 60_000, sweepMs: 60_000 }, runTerminators(repository, hub, executorId));
  return { repository, supervisor, heard };
}

const settled = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("condition not reached");
};
const terminalOf = async (repository: InMemoryConversationRepository, runId: string) =>
  (await repository.snapshot(conversationId)).events.filter((event) => event.runId === runId && event.type === "run.state").at(-1);

test("a sweep that interrupts an orphan writes the journal's terminal and tells observers", async () => {
  const { repository, supervisor, heard } = await setup({ execute: async () => assert.fail("must not run") });
  const orphan = await repository.acceptSubmission(message(0, new Date(Date.now() - 1000).toISOString()));
  await supervisor("a").sweep();
  const terminal = await terminalOf(repository, orphan.run.id);
  assert.deepEqual([terminal?.payload.status, (terminal?.payload.failure as { code: string }).code], ["interrupted", "run_interrupted"]);
  assert.deepEqual(heard.map((event) => event.type), ["turn.failed", "turn.state"]);
  assert.equal((heard[1] as { status: string }).status, "interrupted");
});

test("an executor that throws ends its Run failed, in the journal and for observers, in the one failure shape", async () => {
  const { repository, supervisor, heard } = await setup({ execute: async () => { throw new Error("the executor broke"); } });
  const started = await repository.acceptSubmission(message(0));
  supervisor("dead").adopt(started.run);
  await settled(async () => (await repository.getRun(conversationId, started.run.id))!.status === "failed");
  const terminal = await terminalOf(repository, started.run.id);
  assert.equal(terminal?.payload.status, "failed");
  assert.deepEqual(heard.map((event) => event.type), ["turn.failed", "turn.state"]);
  const failure = (heard[0] as { error: { code: string; message: string; reference?: string } }).error;
  assert.deepEqual([failure.code, failure.message, typeof failure.reference], ["run_failed", "the executor broke", "string"]);
  assert.deepEqual((await repository.getRun(conversationId, started.run.id))!.failure, failure);
});

test("an explicit stop tells observers the Run was cancelled, once", async () => {
  const { repository, supervisor, heard } = await setup({ execute: async (_run, control) => { await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve())); } });
  const started = await repository.acceptSubmission(message(0));
  const instance = supervisor("dead");
  instance.adopt(started.run);
  assert.equal(await instance.cancel(conversationId, started.run.id, "stop"), true);
  assert.deepEqual(heard.map((event) => event.type), ["turn.failed", "turn.state"]);
  assert.equal((heard[0] as { error: { code: string } }).error.code, "run_cancelled");
});
