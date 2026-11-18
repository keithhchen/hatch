import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  InMemoryConversationRepository, PostgresConversationRepository,
  type AcceptSubmissionInput, type ConversationRepository, type ConversationRunRecord
} from "../conversationRepository.js";
import { PostgresStore } from "../postgresStore.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { endingOf } from "../testSupport.js";
import { ChatService, RunRegistry } from "./chatService.js";
import { RunEventHub } from "./runEventHub.js";
import { RunTerminator } from "./runTerminator.js";
import { MAX_RESTART_RETRIES, RESTART_RETRY_PREFIX, RestartRetrier, restartRetryKey } from "./restartRetry.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"f".repeat(24)}:restart`;
const message = (n: number): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "exec-a" },
  canonicalUser: { role: "user", content: `question ${n}` }
});

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; service: ChatService<object>; adopted: string[]; heard: Array<Record<string, unknown>> };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

function harness(repository: ConversationRepository, store: Harness["store"]): Harness {
  const hub = new RunEventHub();
  const heard: Array<Record<string, unknown>> = [];
  hub.subscribe(id, { push: (event) => { heard.push(event); } });
  const adopted: string[] = [];
  const service = new ChatService<object>({
    repository, terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: (run: ConversationRunRecord) => { adopted.push(run.id); }, executorId: "exec-a", holdsConversation: () => false, steered: () => undefined },
    hub, admission: { reserve: () => () => undefined }, registry: new RunRegistry<object>()
  });
  return { repository, store, service, adopted, heard };
}

async function withBackend(name: "memory" | "postgres", body: (h: Harness) => Promise<void>): Promise<void> {
  if (name === "memory") {
    const authority = new LocalRuntimeAuthority();
    const repository = new InMemoryConversationRepository(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "restart" });
      await body(harness(repository, new RuntimeStore(authority)));
    } finally { await repository.close(); }
    return;
  }
  const schema = `restart_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000, max: 8 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "restart" });
    await body(harness(repository, store));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

const retry = (h: Harness, key: string) => h.repository.getConversation(id).then((conversation) => h.service.retry({
  principal: { kind: "account", accountId: "owner" } as never, conversation: conversation!, scope: {}, client: { client: "web" },
  key, runId: `run-for-${key}`, corpusDigest: "corpus", requiresLocalTools: false
}));

/** One Runtime instance's retrier over the shared repository: starts the answer-again Run exactly as the buyer's own click does. */
const retrier = (h: Harness, options: { skip?: boolean; windowMs?: number } = {}) => new RestartRetrier({
  repository: h.repository,
  skip: async () => options.skip === true,
  windowMs: options.windowMs,
  start: async (run, key, runId) => h.service.retry({
    principal: { kind: "account", accountId: "owner" } as never, conversation: (await h.repository.getConversation(run.conversationId))!, scope: {},
    client: { client: "web" }, key, runId, corpusDigest: "corpus", requiresLocalTools: false
  })
});
const interrupt = async (h: Harness, n: number) => {
  const { run } = await h.repository.acceptSubmission(message(n));
  await h.repository.savePartialOutput(run.id, "The first half");
  return (await h.repository.endRun(run.id, endingOf("interrupted", "The Runtime restarted"))).run;
};
const runs = async (h: Harness) => h.repository.listRuns(id);

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? { skip: !databaseUrl, timeout: 30_000 } : {};

  test(`${backend}: IDEMPOTENT: a sweep twice, on three instances at once, and again later yields exactly one retry Run, keyed by the interrupted Run`, options, () => withBackend(backend, async (h) => {
    const interrupted = await interrupt(h, 1);
    const instances = [retrier(h), retrier(h), retrier(h)];
    await Promise.all([...instances.map((instance) => instance.afterInterrupted(interrupted)), ...instances.map((instance) => instance.tick())]);
    await instances[0]!.afterInterrupted(interrupted);
    await instances[1]!.tick();
    const all = await runs(h);
    assert.equal(all.length, 2);
    assert.equal(all[1]!.clientMessageId, restartRetryKey(interrupted.id));
    assert.deepEqual(h.adopted, [all[1]!.id]);
    // Delivering the same start again replays the Run instead of starting another.
    const again = await h.service.retry({ principal: { kind: "account", accountId: "owner" } as never, conversation: (await h.repository.getConversation(id))!, scope: {}, client: { client: "web" }, key: restartRetryKey(interrupted.id), runId: "run-other", corpusDigest: "corpus", requiresLocalTools: false });
    assert.deepEqual([again.outcome, again.run.id], ["replayed", all[1]!.id]);
    assert.equal((await runs(h)).length, 2);
  }));

  test(`${backend}: IDEMPOTENT: the buyer clicking answer again N times at once starts one Run`, options, () => withBackend(backend, async (h) => {
    await interrupt(h, 1);
    const click = (key: string) => retry(h, key).then((result) => result, (error: unknown) => error);
    await Promise.all([click("k1"), click("k1"), click("k1"), click("k2"), click("k3")]);
    assert.equal((await runs(h)).length, 2);
    assert.equal(h.adopted.length, 1);
  }));

  test(`${backend}: ATOMIC: a buyer's new message racing the retry ends with one Run; if the message won there is no retry`, options, () => withBackend(backend, async (h) => {
    const interrupted = await interrupt(h, 1);
    const [accepted] = await Promise.allSettled([h.repository.acceptSubmission(message(2)), retrier(h).afterInterrupted(interrupted)]);
    const all = await runs(h);
    assert.equal(all.length, 2, "exactly one Run after the interrupted one");
    assert.equal(all.filter((run) => ["queued", "running"].includes(run.status)).length, 1);
    if (all[1]!.clientMessageId === "m-2") assert.equal(h.adopted.length, 0, "the message won: no retry");
    else {
      assert.equal(all[1]!.clientMessageId, restartRetryKey(interrupted.id));
      assert.equal(accepted!.status === "fulfilled" ? "message ran after the retry" : "refused", "refused");
    }
  }));

  test(`${backend}: a conversation with a newer user message gets no retry`, options, () => withBackend(backend, async (h) => {
    const interrupted = await interrupt(h, 1);
    const { run } = await h.repository.acceptSubmission(message(2));
    await h.repository.endRun(run.id, endingOf("completed"));
    await retrier(h).afterInterrupted(interrupted);
    assert.equal((await runs(h)).length, 2);
    assert.deepEqual(h.adopted, []);
  }));

  test(`${backend}: RESILIENT: the budget is ${MAX_RESTART_RETRIES} automatic attempts, then the partial reply stays quietly`, options, () => withBackend(backend, async (h) => {
    let latest = await interrupt(h, 1);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3)); // the in-memory store orders Runs by millisecond
      await retrier(h).tick();
      const all = await runs(h);
      if (attempt <= MAX_RESTART_RETRIES) {
        assert.equal(all.length, attempt + 1);
        latest = (await h.repository.endRun(all.at(-1)!.id, endingOf("interrupted", "The Runtime restarted"))).run;
        assert.ok(latest.clientMessageId.startsWith(RESTART_RETRY_PREFIX));
      } else assert.equal(all.length, MAX_RESTART_RETRIES + 1, "no third retry");
    }
    assert.equal((await h.repository.getRun(id, latest.id))!.status, "interrupted");
    assert.equal(h.heard.filter((event) => event.type === "turn.failed").length, 0, "no notice is sent by the retrier");
  }));

  test(`${backend}: RESILIENT: a crash between ending the Run and starting its retry is made up by the next scan; an old interruption and a plain failure are left alone`, options, () => withBackend(backend, async (h) => {
    await interrupt(h, 1); // the process died here: no afterInterrupted was ever called
    await retrier(h, { windowMs: -60_000 }).tick();
    assert.equal((await runs(h)).length, 1, "outside the window");
    await retrier(h).tick();
    assert.equal((await runs(h)).length, 2);
  }));

  test(`${backend}: a failed Run is not an interrupted one: the scan leaves it for the buyer's own answer again`, options, () => withBackend(backend, async (h) => {
    const { run } = await h.repository.acceptSubmission(message(1));
    await h.repository.endRun(run.id, endingOf("failed", "fetch failed"));
    await retrier(h).tick();
    assert.equal((await runs(h)).length, 1);
  }));

  test(`${backend}: report-mode conversations are left to their own retrier`, options, () => withBackend(backend, async (h) => {
    const interrupted = await interrupt(h, 1);
    await retrier(h, { skip: true }).afterInterrupted(interrupted);
    await retrier(h, { skip: true }).tick();
    assert.equal((await runs(h)).length, 1);
  }));
}

test("RESILIENT: a database error in the scan is logged and the next scan works; a start that throws never escapes", async () => {
  let fail = true;
  const started: string[] = [];
  const run = { id: "r1", conversationId: id, clientMessageId: "m", status: "interrupted", createdAt: "2026-01-01T00:00:00.000Z" } as ConversationRunRecord;
  const subject = new RestartRetrier({
    repository: {
      restartInterruptedRuns: async () => { if (fail) throw new Error("db down"); return [run]; },
      listRuns: async () => [run]
    },
    start: async (_run, key) => { started.push(key); throw new Error("principal is gone"); }
  });
  await subject.tick();
  assert.deepEqual(started, []);
  fail = false;
  await subject.tick();
  assert.deepEqual(started, [restartRetryKey("r1")]);
});
