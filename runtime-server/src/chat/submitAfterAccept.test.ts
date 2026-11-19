import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  InMemoryConversationRepository, PostgresConversationRepository,
  type ConversationRepository, type ConversationRunRecord
} from "../conversationRepository.js";
import { PostgresStore } from "../postgresStore.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { ChatService, RunRegistry } from "./chatService.js";
import { ChatError } from "./principal.js";
import { RunEventHub } from "./runEventHub.js";
import { RunTerminator } from "./runTerminator.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"f".repeat(24)}:accepted`;
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; service: ChatService<object>; heard: Array<Record<string, unknown>>; ghostActiveRun: () => void };

function harness(repository: ConversationRepository, store: Harness["store"], overrides: { cap?: () => Promise<void>; adopt?: () => void } = {}): Harness {
  const hub = new RunEventHub();
  const heard: Array<Record<string, unknown>> = [];
  hub.subscribe(id, { push: (event) => { heard.push(event); } });
  // One read of the active Run that sees a Run which has ended by the time the message is accepted.
  let ghost = false;
  const racing = new Proxy(repository, {
    get: (target, property, receiver) => property === "getActiveRun"
      ? async (conversationId: string) => { if (ghost) { ghost = false; return { id: "ghost-run", status: "running" } as ConversationRunRecord; } return target.getActiveRun(conversationId); }
      : Reflect.get(target, property, receiver)
  });
  const service = new ChatService<object>({
    repository: racing, terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: overrides.adopt ?? (() => undefined), executorId: "exec-a", holdsConversation: () => false, steered: () => undefined },
    hub, registry: new RunRegistry<object>(),
    ...(overrides.cap ? { cap: overrides.cap } : {})
  });
  return { repository, store, service, heard, ghostActiveRun: () => { ghost = true; } };
}

async function withBackend(name: "memory" | "postgres", overrides: Parameters<typeof harness>[2], body: (h: Harness) => Promise<void>): Promise<void> {
  if (name === "memory") {
    const authority = new LocalRuntimeAuthority();
    const repository = new InMemoryConversationRepository(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "accepted" });
      await body(harness(repository, new RuntimeStore(authority), overrides));
    } finally { await repository.close(); }
    return;
  }
  const schema = `accepted_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000, max: 8 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "accepted" });
    await body(harness(repository, store, overrides));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

const submit = async (h: Harness, key: string) => h.service.submit({
  principal: { kind: "account", accountId: "owner" } as never, conversation: (await h.repository.getConversation(id))!, scope: {}, client: { client: "web" },
  clientMessageId: key, message: async () => ({ role: "user", content: `question ${key}` }), digest: `digest-${key}`,
  runId: `run-${key}`, corpusDigest: "corpus", requiresLocalTools: false
});

/** A message is either refused and not stored, or stored and answered: never stored with a Run nobody will execute. */
async function assertAnswered(h: Harness, key: string): Promise<ConversationRunRecord[]> {
  const runs = await h.repository.listRuns(id);
  assert.ok(runs.every((run) => !["queued", "running"].includes(run.status)), `no Run left queued: ${runs.map((run) => run.status)}`);
  assert.deepEqual((await h.store.readConversation(id)).filter((entry) => entry.role === "user").map((entry) => entry.content), [`question ${key}`]);
  return runs;
}

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? { skip: !databaseUrl, timeout: 30_000 } : {};

  test(`${backend}: the Run a message joined ended and the cap refuses its replacement: the stored message is answered with that failure, not refused`, options, () => withBackend(backend, {
    cap: async () => { throw new ChatError("usage_cap_exceeded", "Monthly token limit reached.", 429); }
  }, async (h) => {
    h.ghostActiveRun();
    const submission = await h.service.submit({
      principal: { kind: "account", accountId: "owner" } as never, conversation: (await h.repository.getConversation(id))!, scope: {}, client: { client: "web" },
      clientMessageId: "m1", message: async () => ({ role: "user", content: "question m1" }), digest: "digest-m1", runId: "run-m1", corpusDigest: "corpus", requiresLocalTools: false
    });
    assert.equal(submission.outcome, "started");
    const runs = await assertAnswered(h, "m1");
    assert.deepEqual(runs.map((run) => [run.id, run.status]), [["run-m1", "failed"]]);
    assert.deepEqual(h.heard.filter((event) => event.run_id === "run-m1").map((event) => event.type), ["message.accepted", "turn.state", "turn.failed", "turn.state"]);
    // The client's retry under the same key is the same message, not a duplicate.
    assert.equal((await submit(h, "m1")).outcome, "replayed");
    assert.equal((await h.repository.listRuns(id)).length, 1);
  }));

  test(`${backend}: a failure after the message was accepted ends its Run and never leaves it queued and ownerless`, options, () => withBackend(backend, {
    adopt: () => { throw new Error("executor unavailable"); }
  }, async (h) => {
    const submission = await submit(h, "m2");
    assert.equal(submission.outcome, "started");
    const runs = await assertAnswered(h, "m2");
    assert.deepEqual(runs.map((run) => [run.id, run.status]), [["run-m2", "failed"]]);
    assert.ok(h.heard.some((event) => event.type === "turn.failed" && event.run_id === "run-m2"), "the client is told the Run failed");
    assert.equal((await submit(h, "m2")).outcome, "replayed");
  }));
}
