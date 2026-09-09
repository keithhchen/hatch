import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Pool } from "pg";
import { FileConversationRepository, InMemoryConversationRepository, PostgresConversationRepository,
  type AcceptSubmissionInput } from "./conversationRepository.js";
import { LocalRuntimeAuthority, RuntimeStore } from "./store.js";
import { PostgresStore, type PostgresQueryExecutor } from "./postgresStore.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"a".repeat(24)}:submission`;
const conversation = { ...binding, id, publicId: "submission" };
const input: AcceptSubmissionInput = {
  binding,
  run: { id: "run", conversationId: id, clientMessageId: "message", inputDigest: "digest", corpusDigest: "corpus", executorId: "executor" },
  canonicalUser: { role: "user", content: "image question", model_images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }
};

for (const backend of ["memory", "file"] as const) {
  test(`${backend}: one acceptance record, concurrent idempotency, fixed images, rollback and observer-only restart`, async () => {
    const root = backend === "file" ? await mkdtemp(path.join(os.tmpdir(), "hatch-accept-file-")) : undefined;
    const authority = new LocalRuntimeAuthority(root);
    const repository = new InMemoryConversationRepository(authority);
    const store = new RuntimeStore(authority);
    try {
      await repository.createConversation(conversation);
      await assert.rejects(repository.acceptSubmission({ ...input, binding: { ...binding, ownerAccountId: "foreign" } }), { code: "conversation_binding_mismatch" });
      // Inject an actual file transaction failure, not a fake persistence result.
      if (root) {
        const db = new DatabaseSync(path.join(root, "runtime-commits-v2.sqlite"));
        db.exec(`CREATE TRIGGER fail_accept BEFORE INSERT ON commits
          WHEN json_extract(NEW.payload, '$.kind') = 'accept'
          BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
        await assert.rejects(repository.acceptSubmission(input), /injected write failure/);
        assert.deepEqual(await repository.listRuns(id), []);
        assert.equal(await store.readSubmissionReceipt(id, "run"), undefined);
        assert.equal((await repository.snapshot(id)).events.length, 1);
        assert.deepEqual(await store.readEvents(), []);
        db.exec("DROP TRIGGER fail_accept");
        db.close();
      }
      const results = await Promise.all(Array.from({ length: 8 }, (_, n) => repository.acceptSubmission({ ...input, run: { ...input.run, id: `run-${n}` } })));
      assert.equal(results.filter((row) => row.created).length, 1);
      assert.equal(new Set(results.map((row) => row.run.id)).size, 1);
      const winner = results[0]!;
      assert.deepEqual(await store.readSubmissionReceipt(id, winner.run.id), winner.receipt);
      assert.deepEqual(await store.readConversation(id), [input.canonicalUser]);
      assert.deepEqual((await repository.snapshot(id)).events.map((event) => event.type), ["conversation.created", "run.created", "message.created"]);
      assert.equal((await store.readEvents()).length, 2);
      await assert.rejects(repository.acceptSubmission({ ...input, run: { ...input.run, inputDigest: "different" } }), { code: "client_message_conflict" });
      await assert.rejects(repository.acceptSubmission({ ...input, run: { ...input.run, clientMessageId: "another" } }), { code: "conversation_busy" });
      if (root) {
        const db = new DatabaseSync(path.join(root, "runtime-commits-v2.sqlite"));
        const accept = db.prepare("SELECT payload FROM commits WHERE json_extract(payload, '$.kind') = 'accept'").all();
        assert.equal(accept.length, 1);
        const record = JSON.parse(String(accept[0]!.payload));
        assert.equal(record.runs.length, 1);
        assert.equal(record.events.length, 2);
        assert.equal(record.journal.length, 2);
        // Streaming does not rewrite an acceptance or embed prior history.
        await store.append({ type: "runtime.event", conversation_id: id, run_id: winner.run.id, event: { delta: "x" } });
        const tail = JSON.parse(String(db.prepare("SELECT payload FROM commits ORDER BY sequence DESC LIMIT 1").get()!.payload));
        assert.equal(tail.kind, "event");
        assert.equal(tail.events.length, 1);
        assert.equal(tail.runs, undefined);
        assert.equal(db.prepare("SELECT payload FROM commits WHERE json_extract(payload, '$.kind') = 'accept'").get()!.payload, accept[0]!.payload);
        db.close();
        await store.close();
        const reopenedAuthority = new LocalRuntimeAuthority(root);
        const reopened = new InMemoryConversationRepository(reopenedAuthority);
        const reopenedStore = new RuntimeStore(reopenedAuthority);
        await reopened.interruptActiveRuns("executor lost");
        const replay = await reopened.acceptSubmission(input);
        assert.equal(replay.created, false);
        assert.equal(replay.run.status, "interrupted");
        assert.deepEqual(replay.receipt, winner.receipt);
        assert.deepEqual(await reopenedStore.readConversation(id), [input.canonicalUser]);
        await reopened.close();
      }
    } finally {
      await repository.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });
}

test("local quota failure rolls back all acceptance state and usage; retry after failure is accepted once", async (t) => {
  const previous = process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS;
  t.after(() => { if (previous === undefined) delete process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS; else process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS = previous; });
  process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS = "1";
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation(conversation);
  await assert.rejects(repository.acceptSubmission(input), /quota exceeded/);
  assert.deepEqual(await repository.listRuns(id), []);
  assert.deepEqual(await store.readEvents(), []);
  process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS = "2";
  assert.equal((await repository.acceptSubmission(input)).created, true);
  assert.equal((await repository.acceptSubmission(input)).created, false);
});

for (const scope of ["GLOBAL", "SCOPE", "CONVERSATION"] as const) {
  test(`local acceptance honors the shared ${scope} byte quota setting without partial state`, async (t) => {
    const setting = `HATCH_RUNTIME_MAX_${scope}_${scope === "CONVERSATION" ? "BYTES" : "EVENT_BYTES"}`;
    const previous = process.env[setting];
    t.after(() => { if (previous === undefined) delete process.env[setting]; else process.env[setting] = previous; });
    process.env[setting] = "1024";
    const authority = new LocalRuntimeAuthority();
    const repository = new InMemoryConversationRepository(authority);
    const store = new RuntimeStore(authority);
    await repository.createConversation(conversation);
    await assert.rejects(repository.acceptSubmission({ ...input, canonicalUser: { role: "user", content: "x".repeat(2048) } }), /quota exceeded/);
    assert.deepEqual(await repository.listRuns(id), []);
    assert.deepEqual(await store.readEvents(), []);
    assert.equal((await repository.acceptSubmission(input)).created, true);
  });
}

async function child(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    const timeout = setTimeout(() => { process.kill("SIGKILL"); reject(new Error("child deadline")); }, 15_000);
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.stderr.on("data", (chunk) => { errors += chunk; });
    process.on("error", reject);
    process.on("exit", (status) => { clearTimeout(timeout); if (status !== 0) reject(new Error(errors)); else resolve(output); });
  });
}

test("file log survives process exits before and after commit, and independent writers serialize the same ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-accept-crash-"));
  const module = new URL("./conversationRepository.js", import.meta.url).href;
  const setup = `import {FileConversationRepository} from ${JSON.stringify(module)};
    const r = new FileConversationRepository(${JSON.stringify(root)});
    await r.createConversation(${JSON.stringify(conversation)});`;
  try {
    await child(`${setup} process.exit(0);`);
    let repository = new FileConversationRepository(root);
    assert.deepEqual(await repository.listRuns(id), []);
    await repository.close();
    const outputs = await Promise.all([0, 1].map((n) => child(`${setup}
      const result = await r.acceptSubmission(${JSON.stringify({ ...input, run: { ...input.run, id: `writer-${n}` } })});
      console.log(JSON.stringify(result)); process.exit(0);`)));
    const receipts = outputs.map((text) => JSON.parse(text));
    assert.equal(receipts.filter((row) => row.created).length, 1);
    assert.deepEqual(receipts[0].receipt, receipts[1].receipt);
    repository = new FileConversationRepository(root);
    const store = new RuntimeStore(repository.localAuthority);
    assert.deepEqual(await store.readSubmissionReceipt(id, receipts[0].run.id), receipts[0].receipt);
    await repository.interruptActiveRuns("crashed after commit");
    assert.equal((await repository.acceptSubmission(input)).created, false);
    assert.deepEqual(await store.readConversation(id), [input.canonicalUser]);
    await repository.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("file v1 migration is a single historical boundary; orphan runs stay explicitly unaccepted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-accept-migration-"));
  try {
    const timestamp = "2025-01-01T00:00:00.000Z";
    const legacy = JSON.stringify({ format: 1, nextCursor: 1, conversations: [{ ...conversation,
      productIdAtCreation: binding.productId, status: "active", version: 1, createdAt: timestamp, updatedAt: timestamp }],
      runs: [{ ...input.run, status: "interrupted", createdAt: timestamp }], events: [], conversationRequests: [] });
    await writeFile(path.join(root, "conversations-v1.json"), legacy);
    await writeFile(path.join(root, "events.jsonl"), "");
    const repository = new FileConversationRepository(root);
    const store = new RuntimeStore(repository.localAuthority);
    await repository.initialize();
    await assert.rejects(repository.acceptSubmission(input), { code: "submission_not_accepted" });
    assert.equal(await store.readSubmissionReceipt(id, "run"), undefined);
    assert.equal(await readFile(path.join(root, "conversations-v1.json"), "utf8"), legacy);
    await writeFile(path.join(root, "events.jsonl"), "invalid late write from retired format");
    await repository.close();
    const reopened = new InMemoryConversationRepository(new LocalRuntimeAuthority(root));
    await reopened.initialize();
    assert.equal((await reopened.listRuns(id)).length, 1);
    assert.equal((await reopened.acceptSubmission({ ...input, run: { ...input.run, id: "explicit-new", clientMessageId: "explicit-new" } })).created, true);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
async function withPostgres(body: (pool: Pool, options: { connectionString: string; options: string }) => Promise<void>): Promise<void> {
  const schema = `accept_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const options = { connectionString: databaseUrl!, options: `-c search_path=${schema}` };
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ ...options, statement_timeout: 5_000 });
    await body(pool, options);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

test("real PG: shared quota race admits one conversation; binding, archives and orphan runs remain fail-closed", { skip: !databaseUrl }, async () => withPostgres(async (pool) => {
  const store = new PostgresStore({ pool, maxScopeEvents: 2 });
  const repository = new PostgresConversationRepository(pool);
  repository.bindSubmissionStore(store);
  await repository.createConversation(conversation);
  await assert.rejects(repository.acceptSubmission({ ...input, binding: { ...binding, ownerAccountId: "foreign" } }), { code: "conversation_binding_mismatch" });
  await repository.updateConversation(id, { status: "archived" });
  await assert.rejects(repository.acceptSubmission(input), { code: "conversation_archived" });
  await repository.updateConversation(id, { status: "active" });
  await repository.createRun(input.run);
  await repository.interruptActiveRuns("historical orphan");
  await assert.rejects(repository.acceptSubmission(input), { code: "submission_not_accepted" });
  assert.equal(await store.readSubmissionReceipt(id, "run"), undefined);
  assert.deepEqual(await store.readEvents(), []);
  const otherId = `${id}-other`;
  await repository.createConversation({ ...conversation, id: otherId, publicId: "other" });
  const attempts = [id, otherId].map((conversationId, n) => ({ ...input,
    run: { ...input.run, conversationId, id: `new-${n}`, clientMessageId: `new-${n}` } }));
  const results = await Promise.allSettled(attempts.map((attempt) => repository.acceptSubmission(attempt)));
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  const rejected = results.find((row) => row.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.match(String(rejected.reason), /quota exceeded/);
  const loser = attempts[results.findIndex((row) => row.status === "rejected")]!;
  assert.equal(await repository.getRunByClientMessageId(loser.run.conversationId, loser.run.clientMessageId), undefined);
  assert.equal(await store.readSubmissionReceipt(loser.run.conversationId, loser.run.id), undefined);
  assert.equal((await store.readEvents()).length, 2);
  assert.ok((await pool.query("SELECT event_count FROM hatch_conversation_usage")).rows.every((row) => Number(row.event_count) === 2));
}));

test("real PG: each failed transaction rolls back run, canonical user, journal and all three quota scopes", { skip: !databaseUrl }, async () => withPostgres(async (pool) => {
  const store = new PostgresStore(pool);
  const repository = new PostgresConversationRepository(pool);
  repository.bindSubmissionStore(store);
  await repository.createConversation(conversation);
  await store.initialize();
  const baseline = async () => ({
    runs: (await pool.query("SELECT * FROM hatch_conversation_runs")).rows,
    events: (await pool.query("SELECT * FROM hatch_conversation_events")).rows,
    journal: (await pool.query("SELECT * FROM hatch_conversation_journal ORDER BY cursor")).rows,
    usage: (await pool.query("SELECT * FROM hatch_conversation_usage ORDER BY scope_key")).rows
  });
  const before = await baseline();
  for (const [table, condition] of [
    ["hatch_conversation_runs", "TRUE"],
    ["hatch_conversation_events", "NEW.event_type = 'conversation.model_message'"],
    ["hatch_conversation_events", "NEW.event_type = 'turn.state'"],
    ["hatch_conversation_journal", "NEW.event_type = 'run.created'"],
    ["hatch_conversation_journal", "NEW.event_type = 'message.created'"]
  ]) {
    await pool.query(`CREATE OR REPLACE FUNCTION fail_submission() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected submission write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_submission BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_submission()`);
    await assert.rejects(repository.acceptSubmission(input), /injected submission write failure/);
    assert.deepEqual(await baseline(), before);
    await pool.query(`DROP TRIGGER fail_submission ON ${table}`);
  }
  const limited = new PostgresStore({ pool, maxConversationEvents: 1 });
  repository.bindSubmissionStore(limited);
  await assert.rejects(repository.acceptSubmission(input), /quota exceeded/);
  assert.deepEqual(await baseline(), before, "failure on queued event rolls back the canonical event's reservation too");
  repository.bindSubmissionStore(store);
  assert.equal((await repository.acceptSubmission(input)).created, true);
  const usage = (await pool.query("SELECT * FROM hatch_conversation_usage ORDER BY scope_key")).rows;
  assert.equal(usage.length, 3);
  assert.ok(usage.every((row) => Number(row.event_count) === 2));
  const after = await baseline();
  assert.equal((await repository.acceptSubmission(input)).created, false);
  assert.deepEqual(await baseline(), after);
}));

test("real PG: concurrent same ID, lost COMMIT acknowledgement and fresh pool receipt do not replay or reserve twice", { skip: !databaseUrl }, async () => withPostgres(async (pool, options) => {
  let loseCommit = true;
  const transactionStatements: string[] = [];
  const executor = {
    query: async <T extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
      assert.doesNotMatch(sql, /^(BEGIN|COMMIT|ROLLBACK)$/);
      return pool.query<T>(sql, values);
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async <T extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
          transactionStatements.push(sql);
          const result = await client.query<T>(sql, values);
          if (sql === "COMMIT" && loseCommit) { loseCommit = false; throw new Error("lost commit acknowledgement"); }
          return result;
        },
        release: (error?: Error) => client.release(error)
      };
    }
  } satisfies PostgresQueryExecutor & { connect: unknown };
  const store = new PostgresStore(executor);
  const repository = new PostgresConversationRepository(executor);
  repository.bindSubmissionStore(store);
  await repository.createConversation(conversation);
  await assert.rejects(repository.acceptSubmission(input), /lost commit acknowledgement/);
  assert.ok(transactionStatements.includes("BEGIN") && transactionStatements.includes("COMMIT"));
  // A newly constructed pool cannot obtain the receipt from process-local maps.
  const reopenedPool = new Pool(options);
  try {
    const reopenedStore = new PostgresStore(reopenedPool);
    const reopened = new PostgresConversationRepository(reopenedPool);
    reopened.bindSubmissionStore(reopenedStore);
    const receipt = await reopenedStore.readSubmissionReceipt(id, "run");
    assert.ok(receipt);
    await reopened.interruptActiveRuns("executor lost after commit");
    const replays = await Promise.all(Array.from({ length: 8 }, (_, n) => reopened.acceptSubmission({ ...input, run: { ...input.run, id: `retry-${n}` } })));
    assert.ok(replays.every((row) => !row.created && row.run.status === "interrupted"));
    assert.ok(replays.every((row) => JSON.stringify(row.receipt) === JSON.stringify(receipt)));
    assert.deepEqual(await reopenedStore.readConversation(id), [input.canonicalUser]);
    await assert.rejects(reopened.acceptSubmission({ ...input, run: { ...input.run, inputDigest: "tampered" } }), { code: "client_message_conflict" });
    const next = { ...input, run: { ...input.run, id: "next", clientMessageId: "next" } };
    const accepts = await Promise.all(Array.from({ length: 8 }, (_, n) => reopened.acceptSubmission({ ...next, run: { ...next.run, id: `next-${n}` } })));
    assert.equal(accepts.filter((row) => row.created).length, 1);
    assert.equal(new Set(accepts.map((row) => row.run.id)).size, 1);
    assert.equal((await reopened.listRuns(id)).length, 2);
    assert.equal((await reopenedStore.readConversation(id)).length, 2);
    assert.ok((await pool.query("SELECT event_count FROM hatch_conversation_usage")).rows.every((row) => Number(row.event_count) === 4));
  } finally { await reopenedPool.end(); }
}));
