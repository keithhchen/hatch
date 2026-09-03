import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeAssetStore, type AssetReference } from "./assetStore.js";
import type { ArtifactObjectStore, ObjectStoreObject, ObjectStorePutOptions } from "./creatorLearning/objectStore.js";
import { parseInboundMessage, type AssetAttachment } from "./protocol.js";

class FakeObjectStore implements ArtifactObjectStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, content: Buffer | string, _options?: ObjectStorePutOptions): Promise<ObjectStoreObject> {
    const bytes = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
    const existing = this.objects.get(key);
    if (existing && !existing.equals(bytes)) throw new Error(`Immutable object key already contains different bytes: ${key}`);
    this.objects.set(key, bytes);
    return { key, sha256: "", bytes: bytes.length };
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (!bytes) {
      const error = Object.assign(new Error(`Missing object: ${key}`), { code: "NoSuchKey" });
      throw error;
    }
    return Buffer.from(bytes);
  }

  async list(_prefix: string): Promise<string[]> {
    return [...this.objects.keys()];
  }
}

test("rich asset payload is validated and stored outside the conversation record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-assets-"));
  try {
    const bytes = Buffer.from("image bytes are opaque to the transcript", "utf8");
    const attachment: AssetAttachment = {
      kind: "asset",
      attachment_id: "drop_asset_1",
      asset_id: "asset_1",
      display_name: "screen.png",
      media_type: "image/png",
      source_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: bytes.toString("base64")
    };
    const parsed = parseInboundMessage({
      type: "client.message",
      run_id: "run_asset",
      client_message_id: "message_asset",
      conversation_id: "conversation_asset",
      message: { role: "user", content: "What is this?", attachments: [attachment] }
    });
    assert.equal(parsed.type, "client.message");

    const store = new RuntimeAssetStore(root);
    const reference = await store.put(attachment);
    assert.equal("data_base64" in reference, false);
    assert.deepEqual(await store.read("asset_1"), bytes);
    assert.equal(await store.has("asset_1"), true);
    assert.equal((await stat(path.join(root, "assets", "asset_1.bin"))).isFile(), true);
    assert.deepEqual(await store.put(reference as AssetAttachment), reference);
    assert.equal((await readFile(path.join(root, "assets", "asset_1.bin"))).toString("utf8"), bytes.toString("utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset identity mismatch cannot overwrite an existing asset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-assets-"));
  try {
    const store = new RuntimeAssetStore(root);
    const bytes = Buffer.from("first", "utf8");
    const attachment: AssetAttachment = {
      kind: "asset",
      attachment_id: "drop_asset_2",
      asset_id: "asset_same",
      display_name: "first.pdf",
      media_type: "application/pdf",
      source_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: bytes.toString("base64")
    };
    await store.put(attachment);
    const other = Buffer.from("second", "utf8");
    await assert.rejects(
      store.put({
        ...attachment,
        source_bytes: other.length,
        sha256: createHash("sha256").update(other).digest("hex"),
        data_base64: other.toString("base64")
      }),
      /different content/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production asset store persists bytes in cloud object storage and returns an OSS reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-cloud-assets-"));
  try {
    const bytes = Buffer.from("cloud image bytes", "utf8");
    const attachment: AssetAttachment = {
      kind: "asset",
      attachment_id: "drop_cloud_1",
      asset_id: "asset_cloud_1",
      display_name: "cloud.png",
      media_type: "image/png",
      source_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: bytes.toString("base64")
    };
    const objectStore = new FakeObjectStore();
    const store = new RuntimeAssetStore(root, {
      objectStore,
      objectKeyPrefix: "hatch/runtime-assets",
      storageReferencePrefix: "oss://private-hatch-assets"
    });
    const reference: AssetReference = await store.put(attachment);
    assert.equal(reference.storage_ref, "oss://private-hatch-assets/hatch/runtime-assets/asset_cloud_1");
    assert.deepEqual([...objectStore.objects.keys()], ["hatch/runtime-assets/asset_cloud_1"]);
    assert.deepEqual(await store.read(reference.asset_id, reference.storage_ref), bytes);
    await assert.rejects(stat(path.join(root, "assets", "asset_cloud_1.bin")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
