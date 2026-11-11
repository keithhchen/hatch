import assert from "node:assert/strict";
import test from "node:test";
import { gracefulShutdown } from "../gracefulShutdown.mjs";

const recorder = (overrides = {}) => {
  const calls = [];
  return {
    calls,
    steps: {
      markUnready: () => { calls.push("unready"); },
      stopIntake: async () => { calls.push("intake"); },
      drain: async () => { calls.push("drain"); },
      closeConnections: async () => { calls.push("connections"); },
      closeStorage: async () => { calls.push("storage"); },
      deadlineMs: 1000,
      ...overrides
    }
  };
};

test("shutdown runs its steps in order", async () => {
  const { calls, steps } = recorder();
  assert.deepEqual(await gracefulShutdown(steps), { drained: true });
  assert.deepEqual(calls, ["unready", "intake", "drain", "connections", "storage"]);
});

test("a drain that outlasts the deadline is cut off and the rest still runs", async () => {
  const { calls, steps } = recorder({ deadlineMs: 20, drain: () => new Promise(() => {}) });
  assert.deepEqual(await gracefulShutdown(steps), { drained: false });
  assert.deepEqual(calls, ["unready", "intake", "connections", "storage"]);
});

test("a failing step is reported and does not stop the later ones", async () => {
  const errors = [];
  const { calls, steps } = recorder({
    stopIntake: async () => { throw new Error("boom"); },
    onError: step => { errors.push(step); }
  });
  await gracefulShutdown(steps);
  assert.deepEqual(errors, ["stopIntake"]);
  assert.deepEqual(calls, ["unready", "drain", "connections", "storage"]);
});
