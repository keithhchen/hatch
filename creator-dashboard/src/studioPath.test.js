import assert from "node:assert/strict";
import test from "node:test";
import { studioNextStep, studioPathStates, studioStepForRoute } from "./studioPath.js";

const agent = (role, state) => ({ role, state });

test("Studio path derives step state only from the live Factory snapshot", () => {
  const states = studioPathStates([agent("research", "complete"), agent("voice", "running"), agent("generation", "locked"), agent("case-generation", "locked"), agent("evaluator", "locked")], { status: "working" });
  assert.deepEqual(states.map((item) => item.state), ["done", "running", "locked", "locked", "todo"]);
  assert.equal(studioNextStep(states).step.id, "ask");
});

test("Studio path marks the client step done only for a live Product", () => {
  const states = studioPathStates([], { status: "published" });
  assert.equal(states.at(-1).state, "done");
  assert.equal(states[0].state, "todo");
});

test("Factory routes map onto the guided steps", () => {
  assert.equal(studioStepForRoute("sources", "uploads"), "read");
  assert.equal(studioStepForRoute("sources", "voice"), "ask");
  assert.equal(studioStepForRoute("build", "generation"), "build");
  assert.equal(studioStepForRoute("evaluate", "evaluator"), "test");
  assert.equal(studioStepForRoute(null, null), null);
});
