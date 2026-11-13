import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { ResolvedAgentCorpus } from "../agentCorpus.js";
import { PostgresStore } from "../postgresStore.js";
import { PostgresConversationRepository, type ConversationBinding, type ThreadKey } from "../conversationRepository.js";
import type { Connection } from "../surfaces/contract.js";
import { endingOf } from "../testSupport.js";
import { ContactBinder } from "./contactBinding.js";
import { ServiceChatGateway } from "./serviceGateway.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };

async function isolated<T>(body: (pool: Pool) => Promise<T>): Promise<T> {
  const schema = `hatch_threads_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000 });
    return await body(pool);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

const productId = "11111111-1111-4111-8111-111111111111";
const creatorId = "22222222-2222-4222-8222-222222222222";
const binding = (ownerAccountId: string, agentId = productId): ConversationBinding => ({ ownerAccountId, creatorId, agentId, productId: agentId, corpusDigest: "d" });
const corpus = { digest: "sha256:abc", root: "/tmp/none", corpus: { creator: { id: creatorId, name: "C" }, product: { id: productId, name: "P", boundaries: [], presentation: {} }, tools: [], agent_id: productId } } as unknown as ResolvedAgentCorpus;
const connection: Connection = { id: "conn-1", ownerAccountId: "owner", channel: "telegram", client: "im", target: { kind: "product", productId }, audience: "public", taskSpecific: false, state: "active" };
const alice = { kind: "contact" as const, connectionId: "conn-1", contactId: "alice" };
const ref = (threadId: string) => ({ kind: "thread" as const, connectionId: "conn-1", threadId });
const pointers = async (pool: Pool) => (await pool.query("SELECT connection_id, thread_id, principal_id, conversation_id FROM hatch_contact_threads ORDER BY conversation_id")).rows;

test("real PG: binding follows the pointer, /new moves it, and the old conversation stays", options, async () => isolated(async pool => {
  const repository = new PostgresConversationRepository(pool);
  const binder = new ContactBinder({ get: async () => connection }, { resolveByProduct: async () => corpus }, repository);
  const [a, b] = await Promise.all([binder.bind(alice, ref("t1")), binder.bind(alice, ref("t1"))]);
  assert.equal(a.conversation.id, b.conversation.id, "concurrent first messages share one conversation");
  const fresh = await binder.restart(alice, ref("t1"), "telegram::e1");
  assert.notEqual(fresh.id, a.conversation.id);
  assert.equal((await binder.bind(alice, ref("t1"))).conversation.id, fresh.id);
  const again = await Promise.all([binder.restart(alice, ref("t1"), "telegram::e1"), binder.restart(alice, ref("t1"), "telegram::e1")]);
  assert.deepEqual(again.map(c => c.id), [fresh.id, fresh.id]);
  const second = await binder.restart(alice, ref("t1"), "telegram::e2");
  await binder.restart(alice, ref("t1"), "telegram::e1");
  assert.equal((await binder.bind(alice, ref("t1"))).conversation.id, second.id, "an old /new repeated does not take the thread back");
  assert.ok(await repository.getConversation(a.conversation.id), "history is kept");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_conversations")).rows[0].n, 3);
  // Another person in the same group, and the same person in another thread, are not moved.
  const bob = (await binder.bind({ ...alice, contactId: "bob" }, ref("t1"))).conversation.id;
  assert.notEqual(bob, second.id);
  assert.notEqual((await binder.bind(alice, ref("t2"))).conversation.id, second.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_contact_threads")).rows[0].n, 3);
}));

test("real PG: a Run in flight when /new arrives stays in its own conversation and its reply is read from it", options, async () => isolated(async pool => {
  const repository = new PostgresConversationRepository(pool);
  const transcript = new PostgresStore(pool);
  await transcript.migrate();
  repository.bindSubmissionStore(transcript);
  const binder = new ContactBinder({ get: async () => connection }, { resolveByProduct: async () => corpus }, repository);
  const old = (await binder.bind(alice, ref("t1"))).conversation;
  await repository.createRun({ id: "run-1", conversationId: old.id, clientMessageId: "m1", inputDigest: "i", corpusDigest: "d" });
  await repository.transitionRun("run-1", "running");
  const fresh = await binder.restart(alice, ref("t1"), "telegram::e1");
  assert.equal((await repository.findRun("run-1"))?.conversationId, old.id);
  await repository.endRun("run-1", endingOf("completed"));
  const gateway = new ServiceChatGateway<unknown>({
    chat: undefined as never, binders: undefined as never, parts: undefined as never, repository,
    history: { readVisibleConversation: async id => id === old.id ? [{ role: "assistant", run_id: "run-1", content: "the answer" } as never] : [] }
  });
  const progress = await gateway.progress("run-1");
  assert.ok(progress?.ended && progress.reply.text === "the answer", "the reply is the old conversation's, whatever the pointer says");
  assert.equal((await binder.bind(alice, ref("t1"))).conversation.id, fresh.id);
}));

test("real PG: the backfill points each thread at the conversation made under the old deterministic id, once", options, async () => isolated(async pool => {
  const repository = new PostgresConversationRepository(pool);
  await repository.initialize();
  const old = async (owner: string, clientRequestId: string, agentId = productId) =>
    (await repository.createConversation({ ...binding(owner, agentId), id: `conversation:${randomUUID()}`, publicId: `conv_${randomUUID()}`, clientRequestId })).conversation.id;
  const contact = await old("contact:conn-1:alice", "thread:conn-1:T1:alice");
  const colons = await old("contact:conn-1:C1", "thread:conn-1:T1:PN1:C1:C1");
  const colonContact = await old("contact:conn-2:a:b", "thread:conn-2:g:a:b");
  const self = await old("acct-1", "thread:conn-9:chat7");
  const retargetedOld = await old("contact:conn-1:bob", "thread:conn-1:T1:bob", "33333333-3333-4333-8333-333333333333");
  await new Promise(resolve => setTimeout(resolve, 5));
  const retargetedNew = await old("contact:conn-1:bob", "thread:conn-1:T1:bob");
  await old("contact:conn-1:carol", "something-else");
  await old("acct-1", "assistant-conversation");
  await pool.query("DROP TABLE hatch_contact_threads");

  const migrated = new PostgresConversationRepository(pool);
  await migrated.initialize();
  const key = (connectionId: string, threadId: string, principalId: string): ThreadKey => ({ connectionId, threadId, principalId });
  assert.equal(await migrated.threadConversation(key("conn-1", "T1", "alice")), contact);
  assert.equal(await migrated.threadConversation(key("conn-1", "T1:PN1:C1", "C1")), colons, "a thread id may hold colons");
  assert.equal(await migrated.threadConversation(key("conn-2", "g", "a:b")), colonContact);
  assert.equal(await migrated.threadConversation(key("conn-9", "chat7", "acct-1")), self, "a self Connection's account is the principal");
  assert.equal(await migrated.threadConversation(key("conn-1", "T1", "bob")), retargetedNew, "the newest of a thread's conversations");
  assert.notEqual(retargetedOld, retargetedNew);
  assert.equal((await pointers(pool)).length, 5, "nothing else is pointed at");

  // Running it again changes nothing, not even after the thread has moved on.
  const before = await pointers(pool);
  await new PostgresConversationRepository(pool).initialize();
  assert.deepEqual(await pointers(pool), before);
  const binder = new ContactBinder({ get: async () => connection }, { resolveByProduct: async () => corpus }, migrated);
  assert.equal((await binder.bind(alice, ref("T1"))).conversation.id, contact, "an existing contact keeps its conversation");
  const fresh = await binder.restart(alice, ref("T1"), "telegram::e1");
  await pool.query("DELETE FROM hatch_contact_threads WHERE conversation_id = $1", [colons]);
  await new PostgresConversationRepository(pool).initialize();
  assert.equal(await migrated.threadConversation(key("conn-1", "T1", "alice")), fresh.id, "the backfill does not take a moved thread back");
  assert.equal(await migrated.threadConversation(key("conn-1", "T1:PN1:C1", "C1")), colons);
}));
