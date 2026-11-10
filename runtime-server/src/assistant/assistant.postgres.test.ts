import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresStore } from "../postgresStore.js";
import { PostgresDeliveries } from "./deliveries.js";
import { PostgresAssistantState } from "./state.js";
import { assistantConversationId } from "./studioVocabulary.js";
import { PostgresTaskRepository } from "./tasks.js";
import { decisionConformance } from "./tasksConformance.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };

async function isolated(body: (pool: Pool) => Promise<void>) {
  const schema = `assistant_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 8 });
    await body(pool);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

const ACCOUNT = randomUUID();

test("an interview holds the conversation for one account at a time, and its news waits once each", options, () => isolated(async (pool) => {
  const state = await PostgresAssistantState.open(pool);
  const interview = { taskId: "t1", productId: "p1", sessionId: "s1", relayFrom: 2 };
  assert.equal(await state.startInterview(ACCOUNT, interview), true);
  assert.equal(await state.startInterview(ACCOUNT, { ...interview, taskId: "t2" }), false, "a second interview waits for the first");
  await state.advanceInterview(ACCOUNT, "t1", 7);
  await state.advanceInterview(ACCOUNT, "t2", 99);
  assert.deepEqual(await state.interview(ACCOUNT), { ...interview, relayFrom: 7 });
  await state.hold(ACCOUNT, { id: "n1", text: "[任务 a] 好了" });
  await state.hold(ACCOUNT, { id: "n1", text: "[任务 a] 好了" });
  await state.hold(ACCOUNT, { id: "n2", text: "[任务 b] 卡住了", taskId: "b" });
  await state.endInterview(ACCOUNT, "t2");
  assert.equal((await state.interview(ACCOUNT))?.taskId, "t1", "only the interview that holds it can end it");
  await state.endInterview(ACCOUNT, "t1");
  assert.equal(await state.interview(ACCOUNT), undefined);
  assert.deepEqual((await state.takeHeld(ACCOUNT)).map(news => news.id), ["n1", "n2"]);
  assert.deepEqual(await state.takeHeld(ACCOUNT), [], "taken once");
  await state.expertSpoke(ACCOUNT, { source: "telegram", at: "2026-11-10T00:00:00.000Z", messageRef: "7" });
  assert.equal((await state.lastExpert(ACCOUNT))?.source, "telegram");
  assert.equal(await state.startInterview(ACCOUNT, interview), true, "speaking and holding news did not disturb the interview slot");
}));

test("of any number of instances, exactly one takes the reply a Run owes", options, () => isolated(async (pool) => {
  const deliveries = await PostgresDeliveries.open(pool);
  await deliveries.owe("run_1", ACCOUNT);
  await deliveries.owe("run_1", ACCOUNT);
  await deliveries.owe("run_2", ACCOUNT);
  assert.deepEqual((await deliveries.open(10)).map(row => row.runId), ["run_1", "run_2"]);
  const takes = await Promise.all(Array.from({ length: 8 }, () => deliveries.take("run_1")));
  assert.equal(takes.filter(Boolean).length, 1);
  assert.deepEqual((await deliveries.open(10)).map(row => row.runId), ["run_2"]);
}));

test("the tasks a Run created or announced are found by that Run", options, () => isolated(async (pool) => {
  const tasks = await PostgresTaskRepository.open(pool);
  const one = await tasks.create({ accountId: ACCOUNT, kind: "build", origin: { source: "web" }, payload: { run: "run_9" } });
  await tasks.create({ accountId: ACCOUNT, kind: "evaluate", origin: { source: "web" }, payload: { run: "run_other" } });
  assert.deepEqual((await tasks.byRun("run_9")).map(task => task.id), [one.id]);
  assert.deepEqual(await tasks.byRun("run_none"), []);
}));

decisionConformance("Postgres tasks", async () => {
  const schema = `assistant_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 8 });
  return { tasks: await PostgresTaskRepository.open(pool), close: async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } };
}, options);

test("on Postgres a user message is known by its client key, and a reply by the id its Run's ending stored it under", options, () => isolated(async (pool) => {
  const store = new PostgresStore(pool);
  const conversationId = assistantConversationId(ACCOUNT);
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: "run_1", client_message_id: "key-1", message: { role: "user", content: "你好" } });
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: "run_1", message_id: "run_1:1", message: { role: "assistant", content: "你好呀" }, finish_reason: "stop" });
  const history = await store.readVisibleConversation(conversationId);
  assert.deepEqual(history.map(message => [message.id, message.role, message.content]), [["key-1", "user", "你好"], ["run_1:1", "assistant", "你好呀"]]);
}));
