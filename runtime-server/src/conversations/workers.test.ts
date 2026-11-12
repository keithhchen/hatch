import assert from "node:assert/strict";
import test from "node:test";
import { agentEntries, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import { ROLES } from "../factoryAgents/store.js";
import { blockedBy, blockedMessage, unmappedRoles, WORKERS, WorkerRegistry } from "./workers.js";

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

test("only the builder is ever blocked, by missing uploads and interview", async () => {
  const entries = agentEntries(await initialAgentDefinitions(), [], []);
  const blocked = entries.filter(entry => blockedBy(entry));
  assert.deepEqual(blocked.map(entry => entry.role), ["generation"]);
  assert.deepEqual(blockedBy(blocked[0]!), { needs_one_of: ["uploads", "interview"] });
  assert.equal(blockedMessage("builder"), "builder cannot start yet: upload material or do the interview first.");
});
