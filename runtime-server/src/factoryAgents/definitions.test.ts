import assert from "node:assert/strict";
import test from "node:test";
import { BuildNotReadyError, MemoryAgentDefinitionRepository, PostgresAgentDefinitionRepository, agentEntries, assertAgentAvailable, initialAgentDefinitions } from "./definitions.js";
import type { Session } from "./store.js";
import type { Pool } from "pg";

const session = (role: Session["role"], values: Partial<Session> = {}): Session => ({
  id: `${role}-0000-4000-8000-000000000000`.slice(0, 36), role, title: role,
  createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
  revision: 0, turn: 0, status: "idle", files: [], comments: [], messages: [], context: [], todos: [], ...values,
});

const stateOf = (entries: ReturnType<typeof agentEntries>, role: string) => entries.find(entry => entry.role === role)?.state;
const upload = { path: "input/manual/notes.md", bytes: 1, mimeType: "text/markdown" };

test("advanced Agents are never locked, whatever else exists", async () => {
  const definitions = await initialAgentDefinitions();
  for (const sessions of [[], [session("generation", { outputUpdatedAt: "2026-09-10T01:00:00.000Z" })]]) {
    const entries = agentEntries(definitions, sessions, []);
    for (const role of ["research", "case-generation", "evaluator", "voice"]) assert.equal(stateOf(entries, role), "ready");
  }
});

test("Build is locked until there are uploads or interview output, and either one unlocks it", async () => {
  const definitions = await initialAgentDefinitions();
  assert.equal(stateOf(agentEntries(definitions, [], []), "generation"), "locked");
  const research = session("research", { outputUpdatedAt: "2026-09-10T01:00:00.000Z" });
  assert.equal(stateOf(agentEntries(definitions, [research], []), "generation"), "locked", "research output does not unlock Build");
  assert.equal(stateOf(agentEntries(definitions, [], [upload]), "generation"), "ready");
  assert.equal(stateOf(agentEntries(definitions, [session("voice", { outputUpdatedAt: "2026-09-10T01:00:00.000Z" })], []), "generation"), "ready");
  assert.equal(stateOf(agentEntries(definitions, [session("voice")], []), "generation"), "locked", "a voice session without output is not an interview");
  assert.throws(() => assertAgentAvailable(agentEntries(definitions, [], []), "generation"), BuildNotReadyError);
  assertAgentAvailable(agentEntries(definitions, [], [upload]), "generation");
});

test("Build is updatable only by the interview, never by advanced output", async () => {
  const definitions = await initialAgentDefinitions();
  const generation = session("generation", { outputUpdatedAt: "2026-09-10T02:00:00.000Z" });
  const later = "2026-09-10T03:00:00.000Z";
  assert.equal(stateOf(agentEntries(definitions, [generation], [upload]), "generation"), "complete");
  for (const role of ["research", "case-generation", "evaluator"] as const) {
    assert.equal(stateOf(agentEntries(definitions, [generation, session(role, { outputUpdatedAt: later })], [upload]), "generation"), "complete");
  }
  assert.equal(stateOf(agentEntries(definitions, [generation, session("voice", { outputUpdatedAt: later })], []), "generation"), "update_available");
  assert.equal(stateOf(agentEntries(definitions, [{ ...generation, status: "failed" }], [upload]), "generation"), "failed");
});

test("Evaluator is a Creator calibration loop, not a publishing or scoring loop", async () => {
  const evaluator = (await initialAgentDefinitions()).find(definition => definition.role === "evaluator");
  assert.ok(evaluator);
  assert.match(evaluator.systemPrompt, /找出最可能改变下一版 Agent 的少数关键错位/);
  assert.match(evaluator.systemPrompt, /挑出 1–3 个高杠杆/);
  assert.match(evaluator.systemPrompt, /调用 askuser 后不得自动重跑案例/);
  assert.match(evaluator.systemPrompt, /一次真实运行最多发出一个 askuser 批次/);
  assert.match(evaluator.systemPrompt, /观察到的行为 → 对客户\/交付的后果/);
  assert.match(evaluator.systemPrompt, /上传 corpus、发布 Product/);
  assert.match(evaluator.systemPrompt, /不要把报告写成 pass\/fail 评分表/);
});

test("definition repository is read dynamically for each request", async () => {
  const repository = new MemoryAgentDefinitionRepository(await initialAgentDefinitions());
  const changed = await repository.list();
  const hint = { en: "Custom", zh: "自定义", ja: "カスタム" };
  changed.find(definition => definition.role === "voice")!.hint = hint;
  repository.replace(changed);
  assert.deepEqual((await repository.list()).find(definition => definition.role === "voice")!.hint, hint);
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
  const replacement = await initialAgentDefinitions();
  replacement.find(row => row.role === "voice")!.order = 2;
  await repository.replace(replacement);
  await assert.rejects(repository.replace(replacement.slice(0, 4)));
  await assert.rejects(repository.replace(replacement.map((row, index) => ({ ...row, order: index === 1 ? replacement[0]!.order : row.order }))));
  await assert.rejects(repository.replace(replacement.map(row => row.role === "research" ? { ...row, dependencies: { required: ["research"], normal: [], updates: [] } } : row)), "the retired dependencies field is not accepted from a writer");
  assert.equal((await repository.list()).length, 5);

  // Rows stored while dependencies existed still carry the field; it is dropped on read and the row is left as it was.
  const legacy = await initialAgentDefinitions();
  rows.splice(0, rows.length, ...legacy.map(definition => ({ role: definition.role, definition: { ...structuredClone(definition), dependencies: { required: ["research"], normal: [], updates: [] } } })));
  const migrated = await PostgresAgentDefinitionRepository.open(pool);
  assert.equal("dependencies" in (await migrated.list())[0]!, false);
  assert.equal((await migrated.list()).length, 5);
  const customHint = { en: "Custom English", zh: "自定义中文", ja: "カスタム" };
  (rows.find(row => row.role === "research")!.definition as { hint?: unknown }).hint = customHint;
  assert.deepEqual((await (await PostgresAgentDefinitionRepository.open(pool)).list()).find(item => item.role === "research")?.hint, customHint);

  inserts = 0;
  await assert.rejects(PostgresAgentDefinitionRepository.open({
    query: async (text: string) => text.includes("COUNT(*)") ? { rows: [{ count: 1 }] } : text.includes("SELECT role") ? { rows: [rows[0]] } : { rows: [] },
  } as unknown as Pool));
  assert.equal(inserts, 0);
});

test("the shelved person-centred method is not loaded; the interview method is shared by the voice and Assistant prompts", async () => {
  const { readFile } = await import("node:fs/promises");
  const prompts = new URL("../../prompts/", import.meta.url);
  const voice = (await initialAgentDefinitions()).find(definition => definition.role === "voice")!.systemPrompt;
  const done = await readFile(new URL("assistant/INTERVIEW_DONE.md", prompts), "utf8");
  const assistant = await readFile(new URL("assistant/ASSISTANT.md", prompts), "utf8");
  for (const loaded of [voice, done, assistant]) assert.doesNotMatch(loaded, /Intellectual Genealogy|Reciprocal disclosure/);
  assert.match(done, /^# 访谈方法/m);
  assert.match(assistant, /「访谈方法」/);
  const form = await readFile(new URL("factory-agents/voice/FORM_PAGE.md", prompts), "utf8");
  assert.match(form, /说法不一致，请定一个/);
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  assert.equal(count(done, "婚礼摄影师，只示范形式"), 1);
  assert.equal(count(done, "元问题和具体问题"), 1);
  assert.equal(count(form, "婚礼摄影师的骨架"), 1);
  for (const other of [voice, assistant]) assert.equal(count(other, "婚礼摄影师"), 0, "each example lives in one place only");
});
