import assert from "node:assert/strict";
import test from "node:test";
import { ADVANCED_STEP, STUDIO_PATH, studioNextStep, studioPathStates, studioStepForRoute } from "./studioPath.js";

const agent = (role, state) => ({ role, state });
const file = { path: "input/manual/a.md" };

test("Studio path is upload, interview, build and publish; the advanced Agents are a separate tab", () => {
  assert.deepEqual(STUDIO_PATH.map((step) => step.id), ["upload", "ask", "build", "ship"]);
  assert.deepEqual(ADVANCED_STEP.items.map(([, role]) => role), ["research", "case-generation", "evaluator"]);
  assert.equal(STUDIO_PATH.some((step) => step.items.some(([, role]) => ADVANCED_STEP.items.some(([, advanced]) => advanced === role))), false);
});

test("Studio path derives step state only from the live Factory snapshot", () => {
  const states = studioPathStates([agent("voice", "running"), agent("generation", "locked")], { status: "working" }, [file]);
  assert.deepEqual(states.map((item) => item.state), ["done", "running", "locked", "todo"]);
  assert.equal(studioNextStep(states).step.id, "ask");
});

test("Advanced Agents never change the path's progress", () => {
  const states = studioPathStates([agent("research", "complete"), agent("evaluator", "complete"), agent("generation", "locked")], null, []);
  assert.deepEqual(states.map((item) => item.state), ["todo", "todo", "locked", "todo"]);
});

test("Studio path marks the client step done only for a live Product", () => {
  const states = studioPathStates([], { status: "published" });
  assert.equal(states.at(-1).state, "done");
  assert.equal(states[0].state, "todo");
});

test("Factory routes map onto the guided steps and the advanced tab", () => {
  assert.equal(studioStepForRoute("sources", "uploads"), "upload");
  assert.equal(studioStepForRoute("sources", "voice"), "ask");
  assert.equal(studioStepForRoute("build", "generation"), "build");
  for (const [section, page] of ADVANCED_STEP.items) assert.equal(studioStepForRoute(section, page), "advanced");
  assert.equal(studioStepForRoute(null, null), null);
});
