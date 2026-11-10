import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { allow, png } from "../assets/kit.test.js";
import { PostgresConversationRepository, type AlsoCommit } from "../conversationRepository.js";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { PostgresStore } from "../postgresStore.js";
import { openChatAssets } from "./openChatAssets.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };

async function isolated(body: (pool: Pool) => Promise<void>) {
  const schema = `chat_assets_test_${randomUUID().replaceAll("-", "")}`;
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

const blobs = async () => new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "chat-assets-pg-")));

test("without the output guard, moderation is off and an upload is ready", options, () => isolated(async (pool) => {
  const assets = await openChatAssets({ pool, blobs: await blobs(), environment: {} });
  const conversation = { id: "c1", ownerAccountId: "acct" } as Parameters<typeof assets.upload>[0];
  assert.equal((await assets.upload(conversation, { name: "a.txt", bytes: Buffer.from("hello") })).state, "ready");
}));

test("an asset is bound in the transaction that accepts its message, so a crash in between leaves it free", options, () => isolated(async (pool) => {
  const store = new PostgresStore(pool);
  const repository = new PostgresConversationRepository(pool);
  repository.bindSubmissionStore(store);
  const assets = await openChatAssets({ pool, blobs: await blobs(), environment: {}, moderator: allow });
  const binding = { ownerAccountId: "acct", creatorId: "creator", agentId: "agent", productId: "agent", corpusDigest: "d" };
  const { conversation } = await repository.createConversation({ ...binding, id: "conv-1", publicId: "pub-1" });
  const { asset_id: assetId } = await assets.upload(conversation, { name: "photo.png", bytes: await png() });
  const parts = [{ type: "image" as const, assetId }];
  const submit = async (key: string, through: (bind: AlsoCommit) => AlsoCommit = (bind) => bind) => {
    const prepared = await assets.prepare(parts, conversation, key);
    return repository.acceptSubmission(
      { binding, run: { id: `run-${key}`, conversationId: conversation.id, clientMessageId: key, inputDigest: prepared.digest, corpusDigest: "d" }, canonicalUser: await prepared.message() },
      through(prepared.bind!)
    );
  };
  const boundTo = async () => (await pool.query("SELECT message_id FROM hatch_assets WHERE id = $1", [assetId])).rows[0].message_id as string | null;

  // The process dies after the bind and before the commit.
  await assert.rejects(submit("key-1", (bind) => async (tx) => { await bind(tx); throw new Error("crash"); }), /crash/);
  assert.equal(await boundTo(), null, "the bind rolled back with the message");
  assert.equal(await repository.hasAcceptedMessage(conversation.id, "key-1"), false);
  assert.equal((await assets.upload(conversation, { name: "photo.png", bytes: await png() })).asset_id, assetId, "re-upload is the same asset, and it is free");

  // Any message may take it now, whatever its key: there is no orphan to recover.
  assert.equal((await submit("key-2")).created, true);
  assert.match((await boundTo())!, /^msg_/);

  // Another message cannot take it, and then nothing of that message is accepted.
  await assert.rejects(submit("key-3"), { code: "asset_conflict", status: 409 });
  assert.equal(await repository.hasAcceptedMessage(conversation.id, "key-3"), false);
  const runs = await repository.listRuns(conversation.id);
  assert.deepEqual([runs.length, runs[0]!.steeredCount], [1, 0]);
}));
