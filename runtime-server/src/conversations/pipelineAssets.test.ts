import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import sharp from "sharp";
import type { AssetRepository, AssetScope, ContentModerator } from "../assets/domain.js";
import { AssetPipeline } from "../assets/pipeline.js";
import { FileProcessor, ImageProcessor } from "../assets/processors.js";
import { InMemoryAssetRepository, PostgresAssetRepository } from "../assets/repositories.js";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { AttachedConversation } from "./attachedConversation.js";
import type { Conversation, ReadyAsset, SendInput } from "./conversation.js";
import { PipelineAssets, productPlacement, NoModeration } from "./pipelineAssets.js";

// The real pipeline, processors and object storage. Only the moderator is chosen by the test: it allows
// everything (NoModeration, what a server without the output guard runs) or refuses.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const allow: ContentModerator = { check: async () => ({ allowed: true }) };
const mine: AssetScope = { kind: "account", accountId: "a1", conversationId: "worker:p1:research" };
const theirs: AssetScope = { kind: "account", accountId: "a2", conversationId: "worker:p1:research" };

async function desk(repository: AssetRepository, moderator: ContentModerator) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-assets-"));
  const blobs = new LocalArtifactObjectStore(root);
  const written = new Map<string, Buffer>();
  const assets = new PipelineAssets(new AssetPipeline(repository, blobs, moderator, [new ImageProcessor(), new FileProcessor()]), blobs, { files: { writeManual: async (name, bytes) => { written.set(name, bytes); } }, place: productPlacement });
  return { assets, written, close: () => rm(root, { recursive: true, force: true }) };
}

async function onMemory(body: (repository: AssetRepository) => Promise<void>) { await body(new InMemoryAssetRepository()); }

async function onPostgres(body: (repository: AssetRepository) => Promise<void>) {
  const schema = `assets_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const repository = new PostgresAssetRepository(pool);
    await repository.initialize();
    await body(repository);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
}

const adapters: Array<[string, (body: (repository: AssetRepository) => Promise<void>) => Promise<void>, boolean]> = [["memory", onMemory, false], ["postgres", onPostgres, !connectionString]];

for (const [name, run, skip] of adapters) {
  test(`${name}: an uploaded file becomes a ready asset, is staged as text for the model and bound to one message`, { skip }, () => run(async repository => {
    const d = await desk(repository, allow);
    try {
      const uploaded = await d.assets.upload(mine, { name: "notes.txt", bytes: Buffer.from("alpha\nbeta") });
      assert.deepEqual([uploaded.kind, uploaded.state, uploaded.bytes], ["file", "ready", 10]);
      const asset = await d.assets.resolve(mine, uploaded.asset_id);
      assert.ok(asset);
      assert.equal(asset.path, `input/manual/${uploaded.asset_id.slice(0, 8)}-notes.txt.md`);
      assert.equal(await d.assets.resolve(theirs, uploaded.asset_id), undefined, "another account cannot see it");
      await d.assets.stage(mine, [asset]);
      assert.equal(d.written.get(asset.path)?.toString(), "alpha\nbeta", "the extracted text, reachable by path");
      await d.assets.attach(mine, [asset], "m1");
      await d.assets.attach(mine, [asset], "m1");
      assert.equal(((await d.assets.resolve(mine, uploaded.asset_id)) as { messageId?: string }).messageId, "m1");
      await assert.rejects(d.assets.attach(mine, [asset], "m2"), { status: 409, code: "asset_already_used" }, "an asset joins one message");
      assert.equal((await d.assets.upload(mine, { name: "again.txt", bytes: Buffer.from("alpha\nbeta") })).asset_id, uploaded.asset_id, "the same bytes are the same asset");
    } finally { await d.close(); }
  }));

  test(`${name}: of concurrent sends of one asset exactly one is delivered, and a send that fails frees its assets`, { skip }, () => run(async repository => {
    const d = await desk(repository, allow);
    try {
      const uploaded = await d.assets.upload(mine, { name: "notes.txt", bytes: Buffer.from("alpha") });
      const second = await d.assets.upload(mine, { name: "more.txt", bytes: Buffer.from("beta") });
      const asset = (await d.assets.resolve(mine, uploaded.asset_id)) as ReadyAsset;
      const other = (await d.assets.resolve(mine, second.asset_id)) as ReadyAsset;
      const delivered: string[] = [];
      let failing = false;
      const inner = { send: async (input: SendInput) => { await new Promise(resolve => setTimeout(resolve, 5)); if (failing) throw new Error("runtime down"); delivered.push(input.id); return { conversationId: "c", queued: false, message: { id: input.id, role: "user", text: "", created_at: "" } }; } } as unknown as Conversation;
      const conversation = new AttachedConversation(inner, { scope: mine, desk: d.assets });
      const send = (id: string, attachments: ReadyAsset[]) => conversation.send({ id, text: "hi", attachments, client: { client: "web" } }).then(() => "sent", (error: { code?: string }) => error.code);
      const outcomes = await Promise.all(["m1", "m2", "m3", "m4"].map(id => send(id, [asset])));
      assert.equal(outcomes.filter(outcome => outcome === "sent").length, 1);
      assert.equal(outcomes.filter(outcome => outcome === "asset_already_used").length, 3);
      assert.equal(delivered.length, 1);
      assert.equal(((await d.assets.resolve(mine, asset.id)) as ReadyAsset).messageId, delivered[0], "bound to the message that was delivered");

      failing = true;
      assert.equal(await send("m5", [other]), undefined, "a delivery that throws is the caller's error");
      assert.equal(((await d.assets.resolve(mine, other.id)) as ReadyAsset).messageId, undefined, "its asset is free again");
      failing = false;
      assert.equal(await send("m6", [asset, other]), "asset_already_used", "one used asset refuses the whole message");
      assert.equal(((await d.assets.resolve(mine, other.id)) as ReadyAsset).messageId, undefined, "and binds none of it");
      assert.equal(await send("m7", [other]), "sent");
    } finally { await d.close(); }
  }));

  test(`${name}: an image is staged as the resized picture`, { skip }, () => run(async repository => {
    const d = await desk(repository, allow);
    try {
      const png = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#336699" } }).png().toBuffer();
      const uploaded = await d.assets.upload(mine, { name: "wide.png", bytes: png });
      const asset = (await d.assets.resolve(mine, uploaded.asset_id)) as { kind: string; path: string; mimeType: string };
      assert.deepEqual([asset.kind, asset.mimeType], ["image", "image/png"]);
      await d.assets.stage(mine, [asset as never]);
      assert.equal((await sharp(d.written.get(asset.path)!).metadata()).width, 2000, "the model sees the resized original");
    } finally { await d.close(); }
  }));

  test(`${name}: with moderation off an upload is allowed and ready`, { skip }, () => run(async repository => {
    const d = await desk(repository, new NoModeration());
    try {
      const uploaded = await d.assets.upload(mine, { name: "notes.txt", bytes: Buffer.from("hello") });
      assert.equal(uploaded.state, "ready");
      assert.equal(await d.assets.resolve(mine, "nope"), undefined);
      await assert.rejects(d.assets.upload(mine, { name: "big.bin", bytes: Buffer.from([0, 1, 2, 3, 0, 0]) }), { status: 415, code: "unsupported_type" }, "input that is never stored is refused as it is");
    } finally { await d.close(); }
  }));
}
