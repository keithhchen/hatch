import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  InMemoryConversationRepository, PostgresConversationRepository, RunFenced,
  type AcceptSubmissionInput, type ConversationRepository
} from "../conversationRepository.js";
import { PostgresStore } from "../postgresStore.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { RunStateMachine } from "../runState.js";
import { endingOf, endsOf } from "../testSupport.js";
import { ChatError } from "./principal.js";
import { ChatService, RunRegistry } from "./chatService.js";
import { RunEventHub } from "./runEventHub.js";
import { RunTerminator } from "./runTerminator.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"d".repeat(24)}:terminator`;
const message = (n: number): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "exec-a" },
  canonicalUser: { role: "user", content: `question ${n}` }
});
const reply = (content: string) => ({ status: "completed" as const, reply: { message: { role: "assistant" as const, content }, finishReason: "stop" as const } });

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; pool?: Pool };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "postgres", body: (harness: Harness) => Promise<void>, wrap?: (pool: Pool) => Pool): Promise<void> {
  if (name === "memory") {
    const authority = new LocalRuntimeAuthority();
    const repository = new InMemoryConversationRepository(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "terminator" });
      await body({ repository, store: new RuntimeStore(authority) });
    } finally { await repository.close(); }
    return;
  }
  const schema = `terminator_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    const used = wrap ? wrap(pool) : pool;
    const store = new PostgresStore(used);
    const repository = new PostgresConversationRepository(used);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "terminator" });
    await body({ repository, store, pool });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

const postgres = { skip: !databaseUrl, timeout: 30_000 };
/** The positions observers were told the log advanced to. */
const heard = (hub: RunEventHub): number[] => {
  const told: number[] = [];
  hub.subscribe(id, (position) => { told.push(position); });
  return told;
};

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? postgres : {};

  test(`${backend}: a Run's ending writes its reply, status and journal together, then tells observers once`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(message(0));
    const hub = new RunEventHub(undefined, async () => 0);
    const events = heard(hub);
    const terminator = new RunTerminator(repository, hub);
    const first = await terminator.end(run.id, reply("the answer"));
    assert.equal(first.ended, true);
    assert.equal(first.run.status, "completed");
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "the answer"]);
    const journal = (await repository.snapshot(id)).events;
    assert.deepEqual(journal.filter((event) => event.runId === run.id).map((event) => event.type), ["run.created", "message.created", "message.created", "run.state"]);
    assert.equal(events.length, 1, "observers are told once, after the ending committed");
    // A second ending, from anywhere, neither writes a second reply nor tells anyone again.
    const again = await terminator.end(run.id, reply("a second answer"));
    assert.equal(again.ended, false);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "the answer"]);
    assert.equal(events.length, 2, "a second ending finds the Run over; the head is told again, harmlessly");
  }));

  test(`${backend}: a failed Run carries one structured failure in its record, its journal and what observers hear`, options, async () => withBackend(backend, async ({ repository }) => {
    const { run } = await repository.acceptSubmission(message(0));
    const hub = new RunEventHub(undefined, async () => 0);
    const events = heard(hub);
    const failure = { code: "upstream_error", message: "An upstream service Hatch uses failed. Reference: err_abc.", reference: "err_abc" };
    await new RunTerminator(repository, hub).end(run.id, { status: "failed", failure });
    assert.deepEqual((await repository.getRun(id, run.id))!.failure, failure);
    const state = (await repository.snapshot(id)).events.filter((event) => event.type === "run.state").at(-1)!;
    assert.deepEqual(state.payload.failure, failure);
    assert.equal(events.length, 1);
  }));

  for (const status of ["failed", "cancelled", "interrupted"] as const) {
    test(`${backend}: a ${status} Run keeps what the model already produced as its reply, before the failure`, options, async () => withBackend(backend, async ({ repository, store }) => {
      const { run } = await repository.acceptSubmission(message(0));
      const hub = new RunEventHub(undefined, async () => 0);
      const events = heard(hub);
      const produced = { message: { role: "assistant" as const, content: "你好。先给我一样东西" }, finishReason: "stop" as const };
      const terminator = new RunTerminator(repository, hub);
      const first = await terminator.end(run.id, { status, failure: { code: "upstream_error", message: "stalled" }, reply: produced });
      assert.equal(first.ended, true);
      assert.equal(first.messageId, "run-0:1");
      assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "你好。先给我一样东西"]);
      assert.equal((await repository.getRun(id, run.id))!.status, status);
      assert.equal(events.length, 1);
      // Written once: a second ending changes nothing.
      await terminator.end(run.id, { status, failure: { code: "x", message: "again" }, reply: produced });
      assert.equal((await store.readConversation(id)).length, 2);
    }));
  }

  test(`${backend}: an ending with no reply keeps the text the Run wrote to the log; none written, none kept`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(message(0));
    await store.append({ type: "assistant.text", conversation_id: id, run_id: run.id, content: "half an ans" });
    const swept = await new RunTerminator(repository, new RunEventHub(undefined, async () => 0)).end(run.id, endingOf("interrupted", "orphan"));
    assert.equal(swept.messageId, "run-0:1");
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "half an ans"]);
    const silent = await repository.acceptSubmission(message(1));
    await new RunTerminator(repository, new RunEventHub(undefined, async () => 0)).end(silent.run.id, endingOf("failed"));
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "half an ans", "question 1"]);
  }));

  test(`${backend}: a completion while a joined message is unclaimed keeps the reply, leaves the Run open, and claims nothing`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(message(0));
    await repository.acceptSubmission(message(1));
    const hub = new RunEventHub(undefined, async () => 0);
    const events = heard(hub);
    const result = await new RunTerminator(repository, hub).end(run.id, reply("first answer"));
    assert.equal(result.ended, false);
    assert.equal((await repository.getRun(id, run.id))!.status, "queued");
    assert.equal((await repository.getRun(id, run.id))!.consumedCount, 0);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "first answer"]);
    assert.equal(events.length, 1, "observers are told; the Run is not over");
  }));

  test(`${backend}: a stop claims what joined the Run, and a stopped executor's ending is refused`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission(message(0));
    await repository.acceptSubmission(message(1));
    await new RunTerminator(repository, new RunEventHub(undefined, async () => 0)).end(run.id, endingOf("cancelled", "stop"));
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "question 1"]);
    await assert.rejects(repository.endRun(run.id, reply("late"), { heldBy: "exec-a" }), RunFenced);
    await assert.rejects(store.append({ type: "conversation.model_message", conversation_id: id, run_id: run.id, message: { role: "assistant", content: "late" } }, { heldBy: "exec-a" }), RunFenced);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "question 1"]);
  }));
}

test("postgres: a crash inside the ending leaves no reply, and the takeover's ending writes exactly one", postgres, async () => {
  let armed = false;
  const crashing = (pool: Pool): Pool => new Proxy(pool, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "connect") return typeof value === "function" ? value.bind(target) : value;
      return async () => {
        const client = await (value as () => Promise<PoolClient>).call(target);
        return new Proxy(client, {
          get(inner, name) {
            const member = Reflect.get(inner, name, inner);
            if (name !== "query") return typeof member === "function" ? member.bind(inner) : member;
            return (text: unknown, ...rest: unknown[]) => {
              if (armed && typeof text === "string" && text.includes("SET status = $2, completed_at = now(), failure")) { armed = false; throw new Error("crash after the reply was appended"); }
              return (member as (...args: unknown[]) => unknown).call(inner, text, ...rest);
            };
          }
        });
      };
    }
  });
  await withBackend("postgres", async ({ repository, store }) => {
    const { run } = await repository.acceptSubmission({ ...message(0), run: { ...message(0).run, executorLeaseExpiresAt: new Date(Date.now() - 1000).toISOString() } });
    armed = true;
    await assert.rejects(repository.endRun(run.id, reply("the answer"), { heldBy: "exec-a" }), /crash after the reply/);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0"]);
    assert.equal((await repository.getRun(id, run.id))!.status, "queued");
    await repository.claimOrphanedRuns("exec-b", -1);
    await repository.endRun(run.id, reply("the answer"), { heldBy: "exec-b" });
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "the answer"]);
  }, crashing);
});

test("postgres: a write that races a stop is refused atomically, not checked and then made", postgres, async () => withBackend("postgres", async ({ repository, store, pool }) => {
  const { run } = await repository.acceptSubmission(message(0));
  // The stop is mid-transaction: it holds the Run's row and has not committed.
  const stopper = await pool!.connect();
  await stopper.query("BEGIN");
  await stopper.query("UPDATE hatch_conversation_runs SET status = 'cancelled', completed_at = now() WHERE id = $1", [run.id]);
  let settled = false;
  const late = store.append({ type: "conversation.model_message", conversation_id: id, run_id: run.id, message: { role: "assistant", content: "late" } }, { heldBy: "exec-a" })
    .then(() => "written", (error: unknown) => error).finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, "the write waits for the stop instead of passing a check that is about to be stale");
  await stopper.query("COMMIT");
  stopper.release();
  assert.ok(await late instanceof RunFenced);
  assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0"]);
}));

test("a message whose Run capacity is refused after it was stored is answered by a failed Run through the terminator: the journal and the observers both hear a failure, and the message is not refused", async () => withBackend("memory", async ({ repository }) => {
  const hub = new RunEventHub(undefined, async () => 0);
  const events = heard(hub);
  let reserved = 0;
  // The first look finds a Run to join; it ends before the message is accepted, so this one must start a Run and capacity is refused.
  let looked = false;
  const lookingRepository = Object.create(repository) as ConversationRepository;
  lookingRepository.getActiveRun = async (conversationId) => { if (!looked) { looked = true; return { id: "gone" } as never; } return repository.getActiveRun(conversationId); };
  const service = new ChatService<object>({
    repository: lookingRepository,
    terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: () => undefined, executorId: "exec-a", holdsConversation: () => false, steered: () => undefined },
    hub,
    admission: { reserve: () => { reserved++; throw new ChatError("capacity", "The server is at capacity.", 429); } },
    registry: new RunRegistry<object>()
  });
  const conversation = (await repository.getConversation(id))!;
  const submission = await service.submit({
    principal: { kind: "account", accountId: "owner" } as never, conversation, scope: {}, client: { client: "web" },
    clientMessageId: "m-0", message: async () => ({ role: "user", content: "question 0" }), digest: "d-0", runId: "run-0", corpusDigest: "corpus", requiresLocalTools: false
  });
  assert.equal(submission.outcome, "started", "the message is stored, so it is answered, not refused");
  const run = (await repository.getRun(id, "run-0"))!;
  assert.equal(run.status, "failed");
  assert.deepEqual(run.failure, { code: "capacity", message: "The server is at capacity." });
  assert.ok(events.length >= 1, "observers are told");
  const state = (await repository.snapshot(id)).events.filter((event) => event.type === "run.state").at(-1)!;
  assert.equal(state.payload.status, "failed");
}));

test("a Run's state machine ends a failure, a stop and an interruption with whatever the turn has produced by then", async () => {
  for (const end of ["fail", "cancel", "interrupt"] as const) {
    await withBackend("memory", async ({ repository, store }) => {
      const { run } = await repository.acceptSubmission(message(0));
      const state = new RunStateMachine(run.id, id, store as RuntimeStore, endsOf(repository, run.id));
      // What the Run showed is in the log before it ends; the ending keeps it as the reply.
      state.beforeEnd(async () => { await store.append({ type: "assistant.text", conversation_id: id, run_id: run.id, content: "already streamed" }); });
      if (end === "fail") await state.fail({ code: "upstream_error", message: "stalled" }); else await state[end]("stop");
      assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "already streamed"], end);
    });
  }
});
