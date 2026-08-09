import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOutputGuardFromEnvironment,
  GuardedAssistantOutput,
  outputLeakVerdict,
  PassThroughOutputGuard,
  type OutputGuard,
  type OutputGuardInput,
  type OutputGuardVerdict
} from "./outputGuard.js";

class RecordingGuard implements OutputGuard {
  readonly calls: OutputGuardInput[] = [];

  constructor(
    private readonly decide: (input: OutputGuardInput) => OutputGuardVerdict | Promise<OutputGuardVerdict>
  ) {}

  async check(input: OutputGuardInput): Promise<OutputGuardVerdict> {
    this.calls.push(input);
    return this.decide(input);
  }
}

test("GuardedAssistantOutput releases semantic segments in order and always sends done=true", async () => {
  const guard = new RecordingGuard(() => "pass");
  const output = new GuardedAssistantOutput(guard, "run_guard", 5, 7);

  assert.deepEqual(await output.push("abcde"), { released: [], blocked: false });
  assert.deepEqual(await output.push("fgh"), { released: ["abcde"], blocked: false });
  assert.deepEqual(await output.finish(), { released: ["fgh"], blocked: false });
  assert.deepEqual(guard.calls, [
    {
      content: "abcde",
      chatId: "run_guard",
      sessionId: "run_guard",
      done: false
    },
    {
      content: "fgh",
      chatId: "run_guard",
      sessionId: "run_guard",
      done: true
    }
  ]);
});

test("GuardedAssistantOutput fails closed and discards unreleased content", async () => {
  const guard = new RecordingGuard(({ content }) => content.includes("secret") ? "block" : "pass");
  const output = new GuardedAssistantOutput(guard, "run_block", 5, 7);

  assert.deepEqual(await output.push("hello!secretx"), {
    released: ["hello"],
    blocked: true
  });
  assert.deepEqual(await output.push("later"), { released: [], blocked: true });
  assert.deepEqual(await output.finish(), { released: [], blocked: true });
  assert.equal(guard.calls.length, 2);
  assert.equal(guard.calls[1]?.content, "!secret");
});

test("GuardedAssistantOutput treats provider errors as a block", async () => {
  const output = new GuardedAssistantOutput({
    async check() {
      throw new Error("provider unavailable");
    }
  }, "run_error", 5, 7);

  assert.deepEqual(await output.push("abcdef"), { released: [], blocked: true });
});

test("Output Guard environment defaults to off and rejects unknown modes", () => {
  assert.ok(createOutputGuardFromEnvironment({}) instanceof PassThroughOutputGuard);
  assert.throws(
    () => createOutputGuardFromEnvironment({ HATCH_OUTPUT_GUARD: "maybe" }),
    /HATCH_OUTPUT_GUARD/
  );
});

test("Output Guard scopes its verdict to the custom output-disclosure dimension", () => {
  assert.equal(outputLeakVerdict([
    { type: "promptAttack", suggestion: "block" },
    { type: "contentModeration", suggestion: "block" },
    { type: "customLabel", suggestion: "pass" }
  ]), "pass");

  assert.equal(outputLeakVerdict([
    { type: "promptAttack", suggestion: "pass" },
    { type: "customLabel", suggestion: "block" }
  ]), "block");
});

test("Output Guard fails closed without a valid custom output-disclosure verdict", () => {
  assert.throws(
    () => outputLeakVerdict([{ type: "promptAttack", suggestion: "pass" }]),
    /customLabel result is unavailable/
  );
  assert.throws(
    () => outputLeakVerdict([{ type: "customLabel", suggestion: "watch" }]),
    /customLabel result is invalid/
  );
});
