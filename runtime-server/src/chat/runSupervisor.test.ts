import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryConversationRepository, type AcceptSubmissionInput } from "../conversationRepository.js";
import { RunHandoff, RunSupervisor, type ResumeDecision, type RunControl, type RunExecutor } from "./runSupervisor.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const conversationId = `scope:${"c".repeat(24)}:supervisor`;
const message = (n: number, lease?: string): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "dead", ...(lease ? { executorLeaseExpiresAt: lease } : {}) },
  canonicalUser: { role: "user", content: `q${n}` }
});

async function setup(executor: RunExecutor, decide: () => ResumeDecision = () => "restart") {
  const repository = new InMemoryConversationRepository();
  await repository.createConversation({ ...binding, id: conversationId, publicId: "supervisor" });
  const supervisor = (executorId: string) => new RunSupervisor(repository, executor, { decide: async () => decide() }, { executorId, leaseMs: 60_000, sweepMs: 60_000 });
  return { repository, supervisor };
}

const settled = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("condition not reached");
};

test("a Run is executed by the supervisor with no client attached and completes on its own", async () => {
  const { repository, supervisor } = await setup({ execute: async (run) => { await repository.transitionRun(run.id, "completed"); } });
  const repositoryRef = repository;
  const started = await repositoryRef.acceptSubmission(message(0));
  supervisor("a").adopt(started.run);
  await settled(async () => (await repositoryRef.getRun(conversationId, started.run.id))!.status === "completed");
});

test("two instances sweeping an orphaned Run execute it once", async () => {
  const executed: string[] = [];
  const { repository, supervisor } = await setup({ execute: async (run, control) => {
    executed.push(run.id);
    await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve()));
  } });
  const started = await repository.acceptSubmission(message(0, new Date(Date.now() - 1000).toISOString()));
  const [a, b] = [supervisor("a"), supervisor("b")];
  await Promise.all([a.sweep(), b.sweep()]);
  await settled(() => executed.length === 1);
  assert.equal(a.owns(started.run.id) !== b.owns(started.run.id), true);
  await Promise.all([a.stop(), b.stop()]);
  // Shutdown is a handoff, not a failure: the Run stays active for the next instance.
  assert.equal((await repository.getRun(conversationId, started.run.id))!.status, "queued");
});

test("the resume policy can interrupt an orphaned Run instead of restarting it", async () => {
  const { repository, supervisor } = await setup({ execute: async () => assert.fail("must not run") }, () => ({ interrupt: "used a local tool" }));
  const started = await repository.acceptSubmission(message(0, new Date(Date.now() - 1000).toISOString()));
  await supervisor("a").sweep();
  const run = (await repository.getRun(conversationId, started.run.id))!;
  assert.deepEqual([run.status, run.interruptedReason], ["interrupted", "used a local tool"]);
});

test("a message that joins after the executor's last claim makes the supervisor execute again", async () => {
  const seen: number[] = [];
  const { repository, supervisor } = await setup({ execute: async (run) => {
    seen.push(run.steeredCount);
    if (seen.length === 1) await repository.acceptSubmission(message(1));
    else { await repository.claimSteeredMessages(run.id); await repository.transitionRun(run.id, "completed"); }
  } });
  const started = await repository.acceptSubmission(message(0));
  supervisor("a").adopt(started.run);
  await settled(async () => (await repository.getRun(conversationId, started.run.id))!.status === "completed");
  assert.deepEqual(seen, [0, 1]);
});

test("an explicit stop aborts the executor and cancels the Run", async () => {
  let aborted: unknown;
  const { repository, supervisor } = await setup({ execute: async (_run, control) => {
    await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => { aborted = control.signal.reason; resolve(); }));
  } });
  const started = await repository.acceptSubmission(message(0));
  const instance = supervisor("a");
  instance.adopt(started.run);
  assert.equal(await instance.cancel(conversationId, started.run.id, "stop"), true);
  await settled(() => aborted !== undefined);
  assert.equal(aborted instanceof RunHandoff, false);
  assert.equal((await repository.getRun(conversationId, started.run.id))!.status, "cancelled");
});

test("a local-tool result reaches the Run through its registered tool session", async () => {
  const delivered: string[] = [];
  const control: { current?: RunControl } = {};
  const { repository, supervisor } = await setup({ execute: async (_run, runControl) => {
    control.current = runControl;
    runControl.toolSession({ handleResult: async (result) => { delivered.push(result.tool_call_id); return true; }, cancelRun: async () => 0, pendingRequests: () => [] });
    await new Promise<void>((resolve) => runControl.signal.addEventListener("abort", () => resolve()));
  } });
  const started = await repository.acceptSubmission(message(0));
  const instance = supervisor("a");
  instance.adopt(started.run);
  await settled(() => control.current !== undefined);
  assert.equal(await instance.deliverToolResult(started.run.id, { type: "tool_call.result", run_id: started.run.id, tool_call_id: "t1", status: "ok", result: {} } as never), true);
  assert.equal(await instance.deliverToolResult("unknown", { type: "tool_call.result", run_id: "unknown", tool_call_id: "t2", status: "ok", result: {} } as never), false);
  assert.deepEqual(delivered, ["t1"]);
  await instance.stop();
});
