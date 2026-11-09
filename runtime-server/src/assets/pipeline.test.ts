import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync } from "fflate";
import sharp from "sharp";
import { AssetError } from "./domain.js";
import { fileLine, fitImagesToBudget, imageLabel, pathsFor } from "./views.js";
import { block, docx, harness, png, saying, scopeA, scopeB, wav } from "./kit.test.js";
import { UnavailableTranscriber } from "./adapters.js";

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof AssetError && error.code === code);

test("the content decides the type, not the extension", async () => {
  const { pipeline } = await harness();
  const asset = await pipeline.accept(scopeA, { name: "notes.txt", bytes: await png() });
  assert.equal(asset.record.kind, "image");
  assert.equal(asset.record.mime, "image/png");
  await rejects(pipeline.accept(scopeA, { name: "pic.png", bytes: Buffer.from([0, 1, 2, 3, 0, 0xff, 0xfe]) }), "unsupported_type");
});

test("an image is resized to 2000, loses EXIF, and keeps its original", async () => {
  const { pipeline, blobs } = await harness();
  const original = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "red" } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: "secret" } } }).toBuffer();
  assert.ok((await sharp(original).metadata()).exif);
  const asset = await pipeline.accept(scopeA, { name: "p.jpg", bytes: original });
  assert.equal(asset.state, "ready");
  const resized = await blobs.get(asset.derivative("resized")!.key);
  const meta = await sharp(resized).metadata();
  assert.deepEqual([meta.width, meta.height], [2000, 1000]);
  assert.equal(meta.exif, undefined);
  assert.ok((await blobs.get(`account/acct-1/c/conv-1/${asset.record.sha256}/original`)).equals(original));
});

test("a small image is not enlarged and a malformed one ends failed, never ready", async () => {
  const { pipeline, blobs } = await harness();
  const small = await pipeline.accept(scopeA, { name: "a.png", bytes: await png(50, 20) });
  assert.equal((await sharp(await blobs.get(small.derivative("resized")!.key)).metadata()).width, 50);
  const broken = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("not really a png")]);
  const failed = await pipeline.accept(scopeA, { name: "b.png", bytes: broken });
  assert.equal(failed.state, "failed");
  assert.equal(failed.record.failure?.code, "malformed");
});

test("the same bytes upload once per scope, even concurrently", async () => {
  const { pipeline } = await harness();
  const bytes = await png(11, 11);
  const results = await Promise.all(Array.from({ length: 8 }, () => pipeline.accept(scopeA, { name: "a.png", bytes })));
  assert.equal(new Set(results.map(a => a.id)).size, 1);
  const other = await pipeline.accept(scopeB, { name: "a.png", bytes });
  assert.notEqual(other.id, results[0]!.id);
});

test("text, CSV and converted documents become Markdown beside the original", async () => {
  const { pipeline, blobs } = await harness();
  const csv = await pipeline.accept(scopeA, { name: "data.csv", bytes: Buffer.from("a,b\n1,2\n") });
  assert.equal(csv.record.mime, "text/csv");
  assert.equal((await blobs.get(csv.derivative("text")!.key)).toString(), "a,b\n1,2\n");
  const gbk = await pipeline.accept(scopeA, { name: "cn.txt", bytes: Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) });
  assert.equal((await blobs.get(gbk.derivative("text")!.key)).toString(), "你好");
  const doc = await pipeline.accept(scopeA, { name: "report.exe", bytes: docx() });
  assert.equal(doc.record.mime.includes("wordprocessingml"), true);
  assert.match((await blobs.get(doc.derivative("text")!.key)).toString(), /^# converted/);
  assert.match(fileLine(doc, "/attachments/m1/report.exe"), /^\[file: report\.exe \| application\/vnd.*\| \d+ B \| \/attachments\/m1\/report\.exe\]$/);
});

test("a converter that fails ends the asset failed with its reason", async () => {
  const { pipeline } = await harness({ convert: async () => { throw Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }); } });
  const asset = await pipeline.accept(scopeA, { name: "x.docx", bytes: docx() });
  assert.equal(asset.state, "failed");
  assert.equal(asset.record.failure?.code, "unavailable");
});

test("a zip bomb is rejected before anything is stored or inflated", async () => {
  const { pipeline, repository } = await harness();
  const bomb = Buffer.from(zipSync({ "word/document.xml": new Uint8Array(120 * 1024 * 1024) }));
  assert.ok(bomb.length < 1024 * 1024);
  await rejects(pipeline.accept(scopeA, { name: "bomb.docx", bytes: bomb }), "unsafe_archive");
  assert.equal((await repository.listAttached(scopeA)).length, 0);
  await rejects(pipeline.accept(scopeA, { name: "bad.docx", bytes: Buffer.from("PK\x03\x04garbage garbage garbage") }), "malformed");
  await rejects(pipeline.accept(scopeA, { name: "x.zip", bytes: Buffer.from(zipSync({ "a.txt": new Uint8Array([65]) })) }), "unsupported_type");
});

test("oversize input is rejected", async () => {
  const { pipeline } = await harness();
  await rejects(pipeline.accept(scopeA, { name: "huge.png", bytes: Buffer.concat([await png(), Buffer.alloc(21 * 1024 * 1024)]) }), "too_large");
});

test("moderation blocks a file, and the failure is real and permanent for those bytes' state", async () => {
  const { pipeline } = await harness({ moderator: block("policy") });
  const asset = await pipeline.accept(scopeA, { name: "a.txt", bytes: Buffer.from("bad words") });
  assert.equal(asset.record.failure?.code, "moderation_blocked");
  await rejects(pipeline.resolveReadyAsset(scopeA, asset.id), "not_ready");
});

test("a voice message is ready only with a transcript, which is the message text", async () => {
  const { pipeline, blobs } = await harness({ transcriber: saying("  buy milk  ") });
  const asset = await pipeline.accept(scopeA, { name: "v.wav", bytes: wav() });
  assert.equal(asset.state, "ready");
  assert.equal(asset.record.transcript, "buy milk");
  assert.equal((await blobs.get(asset.derivative("transcript")!.key)).toString(), "buy milk");
});

test("without a transcription provider the voice message fails as unavailable, and a retry is a new asset", async () => {
  const down = await harness({ transcriber: new UnavailableTranscriber("DASHSCOPE_API_KEY is not set") });
  const first = await down.pipeline.accept(scopeA, { name: "v.wav", bytes: wav() });
  assert.equal(first.record.failure?.code, "unavailable");
  assert.match(first.record.failure!.message, /DASHSCOPE_API_KEY/);
  assert.equal(first.record.transcript, undefined);
  const again = await down.pipeline.accept(scopeA, { name: "v.wav", bytes: wav() });
  assert.notEqual(again.id, first.id);
  const silent = await harness({ transcriber: saying("   ") });
  assert.equal((await silent.pipeline.accept(scopeA, { name: "v.wav", bytes: wav() })).state, "failed");
});

test("only ready assets in the caller's scope resolve and attach, once", async () => {
  const { pipeline } = await harness();
  const ready = await pipeline.accept(scopeA, { name: "a.txt", bytes: Buffer.from("hi") });
  assert.equal((await pipeline.resolveReadyAsset(scopeA, ready.id)).id, ready.id);
  await rejects(pipeline.resolveReadyAsset(scopeB, ready.id), "not_found");
  await rejects(pipeline.resolveReadyAsset(scopeA, "nope"), "not_found");
  await rejects(pipeline.attach(scopeB, ready.id, "m1"), "not_found");
  assert.equal((await pipeline.attach(scopeA, ready.id, "m1")).messageId, "m1");
  assert.equal((await pipeline.attach(scopeA, ready.id, "m1")).messageId, "m1");
  await rejects(pipeline.attach(scopeA, ready.id, "m2"), "conflict");
  const blocked = await harness({ moderator: block() });
  const failed = await blocked.pipeline.accept(scopeA, { name: "b.txt", bytes: Buffer.from("x") });
  await rejects(blocked.pipeline.attach(scopeA, failed.id, "m1"), "not_ready");
});

test("images over the byte budget are replaced by their label, oldest first", () => {
  const slots = [1, 2, 3, 4].map(n => ({ id: `i${n}`, bytes: 100, label: imageLabel(`/attachments/m${n}/p.png`) }));
  const fitted = fitImagesToBudget(slots, 250);
  assert.deepEqual(fitted.map(s => s.kept), [false, false, true, true]);
  assert.equal(fitted[0]!.label, "[image: /attachments/m1/p.png]");
  assert.deepEqual(fitImagesToBudget(slots, 1_000).map(s => s.kept), [true, true, true, true]);
  assert.deepEqual(fitImagesToBudget([{ id: "x", bytes: 500, label: "l" }], 10).map(s => s.kept), [true]);
});

test("paths in one message are distinct", async () => {
  const { pipeline } = await harness();
  const a = await pipeline.accept(scopeA, { name: "same.txt", bytes: Buffer.from("one") });
  const b = await pipeline.accept(scopeA, { name: "dir/same.txt", bytes: Buffer.from("two") });
  const paths = [...pathsFor("m1", [a, b]).values()];
  assert.equal(new Set(paths).size, 2);
  assert.ok(paths.every(p => p.startsWith("/attachments/m1/")));
});
