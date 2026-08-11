import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ConversationRepositoryError,
  FileConversationRepository,
  InMemoryConversationRepository,
  POSTGRES_CONVERSATION_REPOSITORY_SCHEMA,
  PostgresConversationRepository
} from "./conversationRepository.js";
import type { PostgresQueryExecutor } from "./postgresStore.js";

const binding = {
  ownerAccountId: "account_1",
  creatorId: "creator_a",
  agentId: "agent_a",
  productId: "product_a",
  corpusDigest: `sha256:${"a".repeat(64)}`
};
const inputDigest = `sha256:${"b".repeat(64)}`;

function conversationInput(id: string, publicId = id, clientRequestId?: string) {
  return {
    ...binding,
    id,
    publicId,
    title: `Title ${id}`,
    ...(clientRequestId ? { clientRequestId } : {})
  };
}

test("ConversationRepository stores first-class metadata, versions it, and pages the bound Library", async () => {
  const repository = new InMemoryConversationRepository();
  const one = await repository.createConversation(conversationInput("conversation_1", "conv_1", "create_1"));
  const idempotent = await repository.createConversation(conversationInput("different_internal_id", "different", "create_1"));
  const two = await repository.createConversation(conversationInput("conversation_2", "conv_2", "create_2"));

  assert.equal(one.created, true);
  assert.equal(idempotent.created, false);
  assert.equal(idempotent.conversation.id, "conversation_1");
  assert.equal(one.conversation.ownerAccountId, "account_1");
  assert.equal(one.conversation.productIdAtCreation, "product_a");
  assert.equal(one.conversation.version, 1);

  const renamed = await repository.updateConversation(one.conversation.id, {
    title: "A renamed conversation",
    expectedVersion: 1
  });
  assert.equal(renamed.version, 2);
  assert.equal(renamed.title, "A renamed conversation");
  await assert.rejects(
    () => repository.updateConversation(one.conversation.id, { title: "stale", expectedVersion: 1 }),
    (error: unknown) => error instanceof ConversationRepositoryError && error.code === "version_conflict"
  );

  const firstPage = await repository.listConversations(binding, { limit: 1 });
  assert.equal(firstPage.conversations.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await repository.listConversations(binding, { limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.conversations.length, 1);
  assert.notEqual(firstPage.conversations[0]?.id, secondPage.conversations[0]?.id);
  assert.equal(new Set([one.conversation.id, two.conversation.id]).size, 2);
});

test("ConversationRepository enforces idempotent client messages and one active durable run", async () => {
  const repository = new InMemoryConversationRepository();
  const conversation = (await repository.createConversation(conversationInput("conversation_runs"))).conversation;
  const first = await repository.createRun({
    id: "run_1",
    conversationId: conversation.id,
    clientMessageId: "message_1",
    inputDigest,
    corpusDigest: binding.corpusDigest
  });
  const replay = await repository.createRun({
    id: "run_replayed_with_a_new_transport_id",
    conversationId: conversation.id,
    clientMessageId: "message_1",
    inputDigest,
    corpusDigest: binding.corpusDigest
  });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.run.id, "run_1");
  assert.equal((await repository.getRunByClientMessageId(conversation.id, "message_1"))?.id, "run_1");
  await assert.rejects(
    () => repository.createRun({
      id: "run_tampered_retry",
      conversationId: conversation.id,
      clientMessageId: "message_1",
      inputDigest: `sha256:${"c".repeat(64)}`,
      corpusDigest: binding.corpusDigest
    }),
    (error: unknown) => error instanceof ConversationRepositoryError && error.code === "client_message_conflict"
  );

  await assert.rejects(
    () => repository.createRun({
      id: "run_2",
      conversationId: conversation.id,
      clientMessageId: "message_2",
      inputDigest,
      corpusDigest: binding.corpusDigest
    }),
    (error: unknown) => error instanceof ConversationRepositoryError
      && error.code === "conversation_busy"
      && error.existingRun?.id === "run_1"
  );

  await repository.transitionRun("run_1", "running");
  await repository.transitionRun("run_1", "completed");
  const second = await repository.createRun({
    id: "run_2",
    conversationId: conversation.id,
    clientMessageId: "message_2",
    inputDigest,
    corpusDigest: binding.corpusDigest
  });
  assert.equal(second.created, true);
  assert.equal(second.run.status, "queued");

  const firstSnapshot = await repository.snapshot(conversation.id);
  assert.deepEqual(firstSnapshot.events.map((event) => event.cursor), [1, 2, 3, 4, 5]);
  const replaySnapshot = await repository.snapshot(conversation.id, 3);
  assert.deepEqual(replaySnapshot.events.map((event) => event.type), ["run.state", "run.created"]);
  assert.equal(replaySnapshot.cursor, 5);
});

test("FileConversationRepository survives restart and interrupts rather than replays an active run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-repository-"));
  const first = new FileConversationRepository(root);
  const conversation = (await first.createConversation(conversationInput("conversation_file"))).conversation;
  await first.createRun({
    id: "run_pending",
    conversationId: conversation.id,
    clientMessageId: "message_pending",
    inputDigest,
    corpusDigest: binding.corpusDigest
  });
  await first.close();

  const restarted = new FileConversationRepository(root);
  const interrupted = await restarted.interruptActiveRuns("Runtime restarted");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]?.status, "interrupted");
  assert.equal(interrupted[0]?.interruptedReason, "Runtime restarted");
  assert.equal((await restarted.interruptActiveRuns("again")).length, 0);
  const snapshot = await restarted.snapshot(conversation.id);
  assert.equal(snapshot.runs[0]?.status, "interrupted");
  assert.ok(snapshot.events.some((event) => event.type === "run.state" && event.payload.reason === "Runtime restarted"));
  await restarted.close();

  const persisted = JSON.parse(await readFile(path.join(root, "conversations-v1.json"), "utf8")) as { events: unknown[] };
  assert.ok(persisted.events.length >= 3);
});

test("Postgres ConversationRepository schema has durable idempotency, active-run exclusion, and a cursor journal", () => {
  assert.match(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, /UNIQUE \(conversation_id, client_message_id\)/);
  assert.match(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, /WHERE status IN \('queued', 'running', 'waiting_for_tool', 'compacting'\)/);
  assert.match(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, /cursor BIGSERIAL PRIMARY KEY/);
  assert.match(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, /input_digest TEXT NOT NULL/);
  assert.match(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, /interrupted/);
});

test("Postgres ConversationRepository maps the same durable contract through its database queries", async () => {
  const pool = new ConversationPostgresFake();
  const repository = new PostgresConversationRepository({ pool });
  const conversation = (await repository.createConversation(conversationInput("postgres_conversation", "conv_postgres", "request_postgres"))).conversation;
  const run = (await repository.createRun({
    id: "postgres_run",
    conversationId: conversation.id,
    clientMessageId: "postgres_message",
    inputDigest,
    corpusDigest: binding.corpusDigest
  })).run;
  assert.equal((await repository.getRunByClientMessageId(conversation.id, "postgres_message"))?.id, run.id);
  await repository.transitionRun(run.id, "running");
  await repository.appendEvent({
    conversationId: conversation.id,
    runId: run.id,
    type: "message.created",
    payload: { role: "user", content: "A durable message" }
  });

  const snapshot = await repository.snapshot(conversation.id);
  assert.equal(snapshot.conversation.publicId, "conv_postgres");
  assert.equal(snapshot.runs[0]?.status, "running");
  assert.deepEqual(snapshot.events.map((event) => event.type), [
    "conversation.created",
    "run.created",
    "run.state",
    "message.created"
  ]);
  assert.equal(snapshot.cursor, 4);
  assert.ok(pool.queries.some((query) => /hatch_conversation_one_active_run_idx/.test(query.text)));
  assert.ok(pool.queries.some((query) => /INSERT INTO hatch_conversation_journal/.test(query.text)));
});

type DatabaseRow = Record<string, unknown>;

class ConversationPostgresFake implements PostgresQueryExecutor {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  readonly conversations = new Map<string, DatabaseRow>();
  readonly runs = new Map<string, DatabaseRow>();
  readonly events: DatabaseRow[] = [];

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    if (/^\s*CREATE TABLE/i.test(text)) return { rows: [] };
    if (/^\s*SELECT \* FROM hatch_conversations\s+WHERE owner_account_id/i.test(text)) {
      const [owner, creator, agent, requestId] = values ?? [];
      return this.rows([...this.conversations.values()].filter((row) => (
        row.owner_account_id === owner && row.creator_id === creator && row.agent_id === agent && row.client_request_id === requestId
      )));
    }
    if (/^\s*SELECT \* FROM hatch_conversations WHERE id/i.test(text)) {
      const row = this.conversations.get(String(values?.[0]));
      return this.rows(row ? [row] : []);
    }
    if (/^\s*INSERT INTO hatch_conversations/i.test(text)) {
      const [id, publicId, owner, creator, agent, product, digest, productAtCreation, title, requestId] = values ?? [];
      const timestamp = "2026-08-11T00:00:00.000Z";
      const row: DatabaseRow = {
        id, public_id: publicId, owner_account_id: owner, creator_id: creator, agent_id: agent,
        product_id: product, corpus_digest: digest, product_id_at_creation: productAtCreation,
        title, status: "active", version: 1, client_request_id: requestId,
        created_at: timestamp, updated_at: timestamp
      };
      this.conversations.set(String(id), row);
      return this.rows([row]);
    }
    if (/^\s*UPDATE hatch_conversations\s+SET updated_at/i.test(text)) {
      const [id, updatedAt] = values ?? [];
      const row = this.conversations.get(String(id));
      if (row) row.updated_at = updatedAt;
      return { rows: [] };
    }
    if (/^\s*SELECT \* FROM hatch_conversation_runs\s+WHERE conversation_id = \$1 AND client_message_id/i.test(text)) {
      const [conversationId, messageId] = values ?? [];
      return this.rows([...this.runs.values()].filter((row) => row.conversation_id === conversationId && row.client_message_id === messageId));
    }
    if (/^\s*INSERT INTO hatch_conversation_runs/i.test(text)) {
      const [id, conversationId, messageId, messageDigest, digest, executorId, lease] = values ?? [];
      const row: DatabaseRow = {
        id, conversation_id: conversationId, client_message_id: messageId, input_digest: messageDigest, status: "queued", corpus_digest: digest,
        executor_id: executorId, executor_lease_expires_at: lease, interrupted_reason: null,
        created_at: "2026-08-11T00:00:01.000Z", started_at: null, completed_at: null
      };
      this.runs.set(String(id), row);
      return this.rows([row]);
    }
    if (/^\s*SELECT \* FROM hatch_conversation_runs WHERE id/i.test(text)) {
      const row = this.runs.get(String(values?.[0]));
      return this.rows(row ? [row] : []);
    }
    if (/^\s*SELECT \* FROM hatch_conversation_runs WHERE conversation_id = \$1 ORDER BY/i.test(text)) {
      return this.rows([...this.runs.values()].filter((row) => row.conversation_id === values?.[0]));
    }
    if (/^\s*UPDATE hatch_conversation_runs\s+SET status/i.test(text)) {
      const [id, status, reason] = values ?? [];
      const row = this.runs.get(String(id));
      if (!row) return this.rows([]);
      row.status = status;
      if (status === "running" && !row.started_at) row.started_at = "2026-08-11T00:00:02.000Z";
      if (["completed", "failed", "cancelled", "interrupted"].includes(String(status))) row.completed_at = "2026-08-11T00:00:02.000Z";
      if (status === "interrupted") row.interrupted_reason = reason;
      return this.rows([row]);
    }
    if (/^\s*INSERT INTO hatch_conversation_journal/i.test(text)) {
      const [conversationId, runId, eventType, payload, createdAt] = values ?? [];
      const row: DatabaseRow = {
        cursor: this.events.length + 1,
        conversation_id: conversationId,
        run_id: runId,
        event_type: eventType,
        payload: JSON.parse(String(payload)),
        created_at: createdAt ?? `2026-08-11T00:00:0${this.events.length}.000Z`
      };
      this.events.push(row);
      return this.rows([row]);
    }
    if (/^\s*SELECT cursor, conversation_id, run_id, event_type, payload, created_at\s+FROM hatch_conversation_journal/i.test(text)) {
      const [conversationId, after] = values ?? [];
      return this.rows(this.events.filter((row) => row.conversation_id === conversationId && Number(row.cursor) > Number(after)));
    }
    if (/^\s*SELECT cursor FROM hatch_conversation_journal/i.test(text)) {
      const row = [...this.events].filter((event) => event.conversation_id === values?.[0]).at(-1);
      return this.rows(row ? [{ cursor: row.cursor }] : []);
    }
    throw new Error(`Unexpected query: ${text}`);
  }

  private rows<T extends Record<string, unknown>>(rows: DatabaseRow[]): { rows: T[] } {
    return { rows: rows as T[] };
  }
}
