import assert from "node:assert/strict";
import test from "node:test";
import { MemoryAgentDefinitionRepository, PostgresAgentDefinitionRepository, agentEntries, initialAgentDefinitions } from "./definitions.js";
import type { Session } from "./store.js";
import type { Pool } from "pg";

const session = (role: Session["role"], values: Partial<Session> = {}): Session => ({
  id: `${role}-0000-4000-8000-000000000000`.slice(0, 36), role, title: role,
  createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
  revision: 0, turn: 0, status: "idle", files: [], comments: [], messages: [], context: [], todos: [], ...values,
});

test("Agent dependency state uses outputs and run times without file-level state", async () => {
  const definitions = await initialAgentDefinitions();
  let entries = agentEntries(definitions, []);
  assert.equal(entries.find(entry => entry.role === "research")?.state, "ready");
  assert.deepEqual(entries.find(entry => entry.role === "generation")?.availability, {
    missingRequired: ["research"], normal: { required: true, satisfied: false }, updatedDependencies: []
  });

  const research = session("research", { outputUpdatedAt: "2026-09-10T01:00:00.000Z", lastRunAt: "2026-09-10T00:30:00.000Z" });
  const voice = session("voice", { outputUpdatedAt: "2026-09-10T02:00:00.000Z", lastRunAt: "2026-09-10T01:30:00.000Z" });
  const generation = session("generation", { outputUpdatedAt: "2026-09-10T02:30:00.000Z", lastRunAt: "2026-09-10T02:15:00.000Z" });
  entries = agentEntries(definitions, [research, voice, generation]);
  assert.equal(entries.find(entry => entry.role === "generation")?.state, "complete");

  voice.outputUpdatedAt = "2026-09-10T03:00:00.000Z";
  entries = agentEntries(definitions, [research, voice, generation]);
  assert.equal(entries.find(entry => entry.role === "generation")?.state, "update_available");
  assert.deepEqual(entries.find(entry => entry.role === "generation")?.availability.updatedDependencies, ["voice"]);
  generation.status = "failed";
  assert.equal(agentEntries(definitions, [research, voice, generation]).find(entry => entry.role === "generation")?.state, "failed");
});

test("definition repository is read dynamically for each request", async () => {
  const repository = new MemoryAgentDefinitionRepository(await initialAgentDefinitions());
  const changed = await repository.list();
  changed.find(definition => definition.role === "voice")!.dependencies.required = [];
  repository.replace(changed);
  assert.deepEqual((await repository.list()).find(definition => definition.role === "voice")!.dependencies.required, []);
});

test("database cold start seeds atomically, then the database remains the only authority", async () => {
  const rows: Array<{ role: string; definition: Record<string, unknown> }> = [];
  let inserts = 0;
  const query = async (text: string, values?: unknown[]) => {
    if (text.includes("COUNT(*)")) return { rows: [{ count: rows.length }] };
    if (text.includes("SELECT role")) return { rows: rows.map(row => ({ ...row })) };
    if (text.includes("DELETE FROM")) { rows.length = 0; return { rows: [] }; }
    if (text.includes("INSERT INTO")) {
      inserts++;
      const [role, definition] = values! as [string, string];
      if (!rows.some(row => row.role === role)) rows.push({ role, definition: JSON.parse(definition) });
    }
    return { rows: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as Pool;
  const repository = await PostgresAgentDefinitionRepository.open(pool);
  assert.equal(inserts, 5);
  assert.equal((await repository.list()).length, 5);
  (rows.find(row => row.role === "voice")!.definition.dependencies as { required: string[] }).required = [];
  assert.deepEqual((await repository.list()).find(row => row.role === "voice")?.dependencies.required, []);
  const replacement = await initialAgentDefinitions();
  replacement.find(row => row.role === "voice")!.dependencies.required = [];
  await repository.replace(replacement);
  assert.deepEqual((await repository.list()).find(row => row.role === "voice")?.dependencies.required, []);
  await assert.rejects(repository.replace(replacement.slice(0, 4)));
  await assert.rejects(repository.replace(replacement.map((row, index) => ({ ...row, order: index === 1 ? replacement[0]!.order : row.order }))));
  await assert.rejects(repository.replace(replacement.map(row => row.role === "research" ? { ...row, dependencies: { required: ["research"], normal: [] } } : row)));
  assert.equal((await repository.list()).length, 5);

  inserts = 0;
  await assert.rejects(PostgresAgentDefinitionRepository.open({
    query: async (text: string) => text.includes("COUNT(*)") ? { rows: [{ count: 1 }] } : text.includes("SELECT role") ? { rows: [rows[0]] } : { rows: [] },
  } as unknown as Pool));
  assert.equal(inserts, 0);
});
