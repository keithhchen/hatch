import assert from "node:assert/strict";
import test from "node:test";
import { awaitTurn } from "./awaitTurn.js";
import type { Conversation, ConversationStatus, PublicMessage } from "./conversation.js";

const line = (id: string, role: "user" | "assistant", text = id): PublicMessage => ({ id, role, text, created_at: "t" });

/** A conversation whose answers come from a script, one step per read. */
function scripted(steps: Array<{ status: ConversationStatus; messages: PublicMessage[] }>): Conversation & { reads: number } {
  const conversation = { reads: 0, async messages() { const step = steps[Math.min(conversation.reads++, steps.length - 1)]!; return step; } };
  return conversation as unknown as Conversation & { reads: number };
}
const clock = () => { let time = 0; return { now: () => time, sleep: async (ms: number) => { time += ms; } }; };
const idle: ConversationStatus = { state: "idle" };
const running: ConversationStatus = { state: "running" };

test("returns the reply once the turn that took the message is over", async () => {
  const conversation = scripted([
    { status: running, messages: [line("u", "user")] },
    { status: running, messages: [line("u", "user")] },
    { status: idle, messages: [line("u", "user"), line("a", "assistant", "Done.")] },
  ]);
  const outcome = await awaitTurn(conversation, { sentId: "u", timeoutMs: 10_000, pollMs: 100, ...clock() });
  assert.equal(outcome.reply?.text, "Done.");
  assert.equal(outcome.status.state, "idle");
  assert.equal(conversation.reads, 3);
});

test("times out while the turn is still running and says so", async () => {
  const outcome = await awaitTurn(scripted([{ status: running, messages: [line("u", "user")] }]), { sentId: "u", timeoutMs: 1000, pollMs: 300, ...clock() });
  assert.equal(outcome.status.state, "running");
  assert.equal(outcome.reply, undefined);
});

test("a reply to an earlier message is not the reply to this one", async () => {
  const conversation = scripted([{ status: idle, messages: [line("old", "assistant", "old reply")] }]);
  const outcome = await awaitTurn(conversation, { sentId: "u", timeoutMs: 500, pollMs: 100, ...clock() });
  assert.equal(outcome.reply, undefined, "the sent message never showed up in history");
});

test("a turn that ends without a reply returns its status at once; failure is reported", async () => {
  const quiet = await awaitTurn(scripted([{ status: idle, messages: [line("u", "user")] }]), { sentId: "u", timeoutMs: 60_000, pollMs: 100, ...clock() });
  assert.deepEqual(quiet, { status: idle });
  const failed = await awaitTurn(scripted([{ status: { state: "failed", error: "model down" }, messages: [line("u", "user")] }]), { sentId: "u", timeoutMs: 60_000, ...clock() });
  assert.equal(failed.status.error, "model down");
});

test("several assistant lines in one turn become one reply", async () => {
  const outcome = await awaitTurn(scripted([{ status: idle, messages: [line("u", "user"), line("a1", "assistant", "One."), line("a2", "assistant", "Two.")] }]), { sentId: "u", timeoutMs: 100, ...clock() });
  assert.equal(outcome.reply?.text, "One.\n\nTwo.");
  assert.equal(outcome.reply?.id, "a2");
});
