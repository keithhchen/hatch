import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Pool } from "pg";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import { userMessage } from "../factoryAgents/imageRefs.js";
import { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import { WorkbenchStore } from "../factoryAgents/store.js";
import type { Conversation } from "./conversation.js";
import { MemoryEventLog, type EventLog } from "./eventLog.js";
import { EventLogJournal } from "./journal.js";
import { PostgresEventLog } from "./postgresEventLog.js";
import { snapshotOf } from "./snapshot.js";

// A real store and runtime with a scripted model, journaling into a real event log. Snapshots are taken
// from a second log object (a second Registry process on Postgres) while the runtime writes.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;

type Logs = { writer: EventLog; reader: EventLog };

async function onMemory(body: (logs: Logs) => Promise<void>) { const log = new MemoryEventLog(); await body({ writer: log, reader: log }); }

async function onPostgres(body: (logs: Logs) => Promise<void>) {
  const schema = `journal_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools = [0, 1].map(() => new Pool({ connectionString, options: `-c search_path=${schema}` }));
  try {
    await PostgresEventLog.open(pools[0]!);
    await body({ writer: await PostgresEventLog.open(pools[0]!), reader: await PostgresEventLog.open(pools[1]!) });
  } finally { await Promise.all(pools.map(pool => pool.end())); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
}

async function runtimeOn(log: EventLog) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-journal-"));
  const store = new WorkbenchStore(root, { creatorId: "c1", productId: "p1" }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  const runtime = new WorkbenchRuntime(store, {
    env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash" },
    journal: new EventLogJournal(log, event => event.sessionId),
    agentFactory: factory => new Agent({ ...factory.agentOptions, initialState: { ...factory.initialState, model: createFactoryLlmModel({ env: factory.env }) }, streamFn: (_model, context) => {
      const call = context.messages.length;
      const tool = call % 4 === 1 ? "list" : undefined;
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(),
        content: tool ? [{ type: "toolCall", id: `call-${call}`, name: tool, arguments: { directory: "input" } }] : [{ type: "text", text: `Reply ${call}` }],
        stopReason: tool ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(message); }, 2);
      return stream;
    } }),
  });
  const session = await store.create("research");
  const idle = async () => { for (let i = 0; i < 1000; i++) { if (!runtime.isRunning(session.id)) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("run did not end"); };
  /** Every message the store holds, as a conversation shows them: the message count is what matters here. */
  const conversation = { feedKey: async () => session.id, status: async () => ({ state: runtime.isRunning(session.id) ? "running" : "idle" }), messages: async () => ({ status: { state: runtime.isRunning(session.id) ? "running" : "idle" }, messages: (await store.get(session.id)).messages.map((_, index) => ({ id: String(index), role: "user", text: "", created_at: "" })) }) } as unknown as Conversation;
  return { runtime, store, session, idle, conversation, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

const adapters: Array<[string, (body: (logs: Logs) => Promise<void>) => Promise<void>, boolean]> = [["memory", onMemory, false], ["postgres", onPostgres, !connectionString]];

for (const [name, run, skip] of adapters) {
  test(`${name}: snapshot plus the events after its cursor hold every message exactly once, while Runs write`, { skip }, () => run(async ({ writer, reader }) => {
    const h = await runtimeOn(writer);
    try {
      const snapshots: Array<{ cursor: string; held: number }> = [];
      let writing = true;
      const readers = Array.from({ length: 4 }, async () => {
        while (writing) { const snapshot = await snapshotOf(h.conversation, reader); snapshots.push({ cursor: snapshot.cursor, held: snapshot.messages.length }); await new Promise(resolve => setTimeout(resolve, 1)); }
      });
      for (let turn = 0; turn < 12; turn++) {
        await h.runtime.send(h.session.id, userMessage(`message ${turn}`, [], { kind: "expert", itemId: `m${turn}`, text: `message ${turn}` }));
        await new Promise(resolve => setTimeout(resolve, turn % 3 * 6));
        await h.runtime.send(h.session.id, userMessage(`and ${turn}`, [], { kind: "expert", itemId: `n${turn}`, text: `and ${turn}` }));
      }
      await h.idle();
      writing = false;
      await Promise.all(readers);
      const total = (await h.store.get(h.session.id)).messages.length;
      const messageEvents = (await reader.after(h.session.id, "0", 5000)).filter(entry => entry.event.type === "message");
      assert.equal(messageEvents.length, total, "every persisted message has exactly one event");
      assert.ok(snapshots.length > 20, `readers really overlapped the writer (${snapshots.length} snapshots)`);
      for (const { cursor, held } of snapshots) {
        const after = messageEvents.filter(entry => Number(entry.cursor) > Number(cursor)).length;
        assert.equal(held + after, total, `a snapshot at cursor ${cursor} holds ${held} messages and ${after} more follow, of ${total}`);
      }
    } finally { await h.close(); }
  }));

  test(`${name}: a Run is recorded from its start, with no conversation route involved`, { skip }, () => run(async ({ writer, reader }) => {
    const h = await runtimeOn(writer);
    try {
      await h.runtime.send(h.session.id, userMessage("go", [], { kind: "expert", itemId: "go", text: "go" }));
      await h.idle();
      const types = (await reader.after(h.session.id, "0")).map(entry => entry.event.type);
      assert.equal(types[0], "state", "the first thing that happened is the first thing recorded");
      assert.ok(types.includes("message") && types.includes("message_end"));
      assert.equal(types.filter(type => type === "run_end").length, 1);
      assert.ok(!types.some(type => type.startsWith("voice.")), "internal events stay inside");
    } finally { await h.close(); }
  }));

  test(`${name} event log: a step that fails leaves no event, and one that works leaves its event with its effect`, { skip }, () => run(async ({ writer, reader }) => {
    await assert.rejects(writer.commit("k", { type: "message" }, async () => { throw new Error("disk full"); }), /disk full/);
    assert.equal(await reader.head("k"), "0");
    let stored = 0;
    await writer.commit("k", { type: "message" }, async () => { stored++; });
    assert.deepEqual([stored, await reader.head("k")], [1, "1"]);
    assert.deepEqual(await reader.consistent("k", async head => head), "1");
  }));
}
