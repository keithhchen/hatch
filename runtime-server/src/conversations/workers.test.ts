import assert from "node:assert/strict";
import test from "node:test";
import { agentEntries, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import { ROLES } from "../factoryAgents/store.js";
import { blocked, blockedBy, blockedMessage, unmappedRoles, WORKERS, WorkerRegistry } from "./workers.js";

test("public worker ids map to internal roles", () => {
  assert.deepEqual(WORKERS.all.map(w => [w.id, w.role]), [
    ["research", "research"], ["interview", "voice"], ["builder", "generation"], ["cases", "case-generation"], ["evaluator", "evaluator"],
  ]);
  assert.equal(WORKERS.byId("builder")?.role, "generation");
  assert.equal(WORKERS.byId("generation"), undefined, "internal role names are not public ids");
  assert.equal(WORKERS.idOf("voice"), "interview");
});

test("every role has exactly one worker and ids are unique", () => {
  assert.deepEqual(unmappedRoles(), []);
  assert.equal(WORKERS.all.length, ROLES.length);
  assert.equal(new Set(WORKERS.all.map(w => w.id)).size, WORKERS.all.length);
  assert.deepEqual(unmappedRoles(new WorkerRegistry([{ id: "research", role: "research" }])), ["voice", "generation", "case-generation", "evaluator"]);
});

test("a locked worker reports what blocks it in public ids", async () => {
  const entries = agentEntries(await initialAgentDefinitions(), []);
  const entry = (role: string) => entries.find(e => e.role === role)!;
  assert.equal(blockedBy(entry("research")), undefined);
  assert.deepEqual(blockedBy(entry("case-generation")), { missing_required: ["builder"], needs_one_of: [] });
  assert.deepEqual(blockedBy(entry("evaluator")), { missing_required: ["builder", "cases"], needs_one_of: [] });
  assert.deepEqual(blockedBy(entry("generation")), { missing_required: [], needs_one_of: ["research", "interview"] });
  assert.deepEqual(blocked({ missingRequired: [], normalCandidates: ["research"], normalSatisfied: true }), { missing_required: [], needs_one_of: [] });
  assert.equal(blockedMessage("cases", { missing_required: ["builder"], needs_one_of: [] }), "cases cannot start yet: builder must produce output first.");
});
