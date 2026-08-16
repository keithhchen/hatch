import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import { LocalArtifactObjectStore } from "./objectStore.js";
import { ProductFileStore, ProductFilesError } from "./productFiles.js";

test("Product File Store projects non-images to Markdown and preserves images natively", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-product-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProductFileStore(new LocalArtifactObjectStore(root));
  const creatorId = "creator-test";
  const productId = "product-test";

  const text = await store.createFromUpload({
    creatorId,
    productId,
    displayName: "notes.txt",
    bytes: Buffer.from("A judgment\nwith context.", "utf8")
  });
  assert.equal(text.projection.kind, "markdown");
  assert.match(text.projectionContent ?? "", /A judgment/);
  assert.equal(text.projection.mediaType, "text/markdown");
  assert.match(text.artifactId, /^artifact_[a-f0-9]{64}$/);

  const csv = await store.createFromUpload({
    creatorId,
    productId,
    displayName: "examples.csv",
    bytes: Buffer.from("Situation,Decision\nunclear goal,clarify first\n", "utf8")
  });
  assert.equal(csv.projection.kind, "markdown");
  assert.match(csv.projectionContent ?? "", /\| Situation \| Decision \|/);
  assert.match(csv.projectionContent ?? "", /clarify first/);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Situation", "Decision"], ["boundary", "decline"]]), "Cases");
  const xlsxBytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const xlsx = await store.createFromUpload({
    creatorId,
    productId,
    displayName: "cases.xlsx",
    bytes: xlsxBytes
  });
  assert.match(xlsx.projectionContent ?? "", /## Sheet: Cases/);
  assert.match(xlsx.projectionContent ?? "", /decline/);

  const json = await store.createFromUpload({
    creatorId,
    productId,
    displayName: "method.json",
    bytes: Buffer.from(JSON.stringify({ principle: "diagnose first" }), "utf8")
  });
  assert.match(json.projectionContent ?? "", /diagnose first/);

  // A tiny valid 1x1 PNG. The bytes stay unchanged and are returned as a
  // native image projection rather than flattened into Markdown.
  const png = await store.createFromUpload({
    creatorId,
    productId,
    displayName: "example.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  });
  assert.equal(png.projection.kind, "image");
  assert.equal(png.projection.mediaType, "image/png");
  assert.ok(png.projectionBase64);
  assert.ok(Buffer.from(png.projectionBase64!, "base64").toString("hex").startsWith("89504e470d0a1a0a"));

  const files = await store.listFiles(creatorId, productId);
  assert.equal(files.length, 5);
  assert.ok(files.every((file) => file.productId === productId));

  const snapshot = await store.createSnapshot(creatorId, productId, [text.id, csv.id, xlsx.id, json.id, png.id]);
  assert.equal(snapshot.productId, productId);
  assert.equal(snapshot.documents.length, 5);
  assert.match(snapshot.manifestSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.fileIds, [text.id, csv.id, xlsx.id, json.id, png.id]);

  const sources = await store.resolveSnapshotSources(creatorId, productId, snapshot.id);
  assert.equal(sources.length, 5);
  assert.equal(sources.find((source) => source.title === "notes.txt")?.content.includes("A judgment"), true);
  const imageSource = sources.find((source) => source.title === "example.png");
  assert.equal(imageSource?.image?.mediaType, "image/png");
  assert.equal(imageSource?.content, "[Native image source: example.png]");
});

test("Product Snapshot is immutable and cannot mix Product files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-product-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProductFileStore(new LocalArtifactObjectStore(root));
  const first = await store.createFromUpload({
    creatorId: "creator-test",
    productId: "product-a",
    displayName: "one.md",
    bytes: Buffer.from("one", "utf8")
  });
  const second = await store.createFromUpload({
    creatorId: "creator-test",
    productId: "product-b",
    displayName: "two.md",
    bytes: Buffer.from("two", "utf8")
  });
  await assert.rejects(
    () => store.createSnapshot("creator-test", "product-a", [first.id, second.id]),
    (error: unknown) => error instanceof ProductFilesError && error.code === "product_file_not_found"
  );

  const snapshot = await store.createSnapshot("creator-test", "product-a", [first.id]);
  const snapshots = await store.listSnapshots("creator-test", "product-a");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.id, snapshot.id);
  assert.equal((await store.getSnapshot("creator-test", "product-a", snapshot.id)).manifestSha256, snapshot.manifestSha256);
  await assert.rejects(
    () => store.getSnapshot("creator-test", "product-b", snapshot.id),
    (error: unknown) => error instanceof ProductFilesError && error.code === "product_snapshot_not_found"
  );
});

test("Product file and snapshot commands are idempotent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-product-idempotency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProductFileStore(new LocalArtifactObjectStore(root));
  const input = {
    creatorId: "creator-test",
    productId: "product-test",
    displayName: "notes.md",
    bytes: Buffer.from("same bytes", "utf8"),
    idempotencyKey: "upload-1"
  };
  const first = await store.createFromUpload(input);
  const replay = await store.createFromUpload(input);
  assert.equal(replay.id, first.id);
  await assert.rejects(
    () => store.createFromUpload({ ...input, bytes: Buffer.from("different", "utf8") }),
    (error: unknown) => error instanceof ProductFilesError && error.code === "idempotency_conflict"
  );

  const locked = await store.createSnapshot("creator-test", "product-test", [first.id], "snapshot-1");
  const lockedReplay = await store.createSnapshot("creator-test", "product-test", [first.id], "snapshot-1");
  assert.equal(lockedReplay.id, locked.id);
});

test("Product File and Snapshot idempotency keys replay the same immutable resource", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-product-idempotency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProductFileStore(new LocalArtifactObjectStore(root));
  const input = {
    creatorId: "creator-test",
    productId: "product-test",
    displayName: "method.md",
    bytes: Buffer.from("diagnose first", "utf8"),
    metadata: { source_kind: "codex", source_ref: "session-1" },
    idempotencyKey: "file-upload-1"
  };
  const first = await store.createFromUpload(input);
  const replay = await store.createFromUpload(input);
  assert.equal(replay.id, first.id);
  assert.equal((await store.listFiles(input.creatorId, input.productId)).length, 1);

  const contentAddressedReplay = await store.createFromUpload({ ...input, idempotencyKey: undefined });
  assert.equal(contentAddressedReplay.id, first.id);
  assert.equal((await store.listFiles(input.creatorId, input.productId)).length, 1);

  await assert.rejects(
    () => store.createFromUpload({ ...input, bytes: Buffer.from("different", "utf8") }),
    (error: unknown) => error instanceof ProductFilesError && error.code === "idempotency_conflict"
  );

  const snapshot = await store.createSnapshot(input.creatorId, input.productId, [first.id], "snapshot-1");
  const snapshotReplay = await store.createSnapshot(input.creatorId, input.productId, [first.id], "snapshot-1");
  assert.equal(snapshotReplay.id, snapshot.id);
  assert.equal((await store.listSnapshots(input.creatorId, input.productId)).length, 1);

  await store.createFromUpload({
    creatorId: input.creatorId,
    productId: input.productId,
    displayName: "second.md",
    bytes: Buffer.from("second", "utf8")
  });
  await assert.rejects(
    () => store.createSnapshot(input.creatorId, input.productId, [], "snapshot-1"),
    (error: unknown) => error instanceof ProductFilesError && error.code === "idempotency_conflict"
  );
});

test("Product Files and Snapshots survive a store re-open without losing Product binding", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-product-files-reopen-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const creatorId = "creator-reopen";
  const productId = "product-reopen";
  const firstStore = new ProductFileStore(new LocalArtifactObjectStore(root));
  const file = await firstStore.createFromUpload({
    creatorId,
    productId,
    displayName: "method.md",
    bytes: Buffer.from("Choose one supported recommendation.", "utf8"),
    idempotencyKey: "reopen-file"
  });
  const snapshot = await firstStore.createSnapshot(creatorId, productId, [file.id], "reopen-snapshot");

  // A new ProductFileStore instance reads the same immutable object keys; no
  // in-memory index or generic Source Library is allowed to be the authority.
  const reopened = new ProductFileStore(new LocalArtifactObjectStore(root));
  const files = await reopened.listFiles(creatorId, productId);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.id, file.id);
  const loaded = await reopened.getSnapshot(creatorId, productId, snapshot.id);
  assert.equal(loaded.manifestSha256, snapshot.manifestSha256);
  assert.deepEqual(loaded.fileIds, [file.id]);
  await assert.rejects(
    () => reopened.getSnapshot(creatorId, "another-product", snapshot.id),
    (error: unknown) => error instanceof ProductFilesError && error.code === "product_snapshot_not_found"
  );
});
