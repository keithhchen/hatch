import assert from "node:assert/strict";
import test from "node:test";
import { defaultCredential } from "./creatorLearning/objectStore.js";

test("Alibaba credentials resolve the ESM-wrapped CommonJS default provider", () => {
  const credential = defaultCredential();
  assert.equal(typeof credential.getCredential, "function");
});

test("public object URLs are https on the public endpoint, even for an internal-endpoint store", async () => {
  const { AliyunArtifactObjectStore } = await import("./creatorLearning/objectStore.js");
  const store = new AliyunArtifactObjectStore({
    bucket: "hatch-test",
    region: "oss-cn-shanghai",
    internal: true,
    prefix: "hatch",
    credential: { getCredential: async () => ({ accessKeyId: "test-id", accessKeySecret: "test-secret" }) }
  });
  assert.equal(
    await store.generatePublicObjectUrl("accounts/avatars/a.webp"),
    "https://hatch-test.oss-cn-shanghai.aliyuncs.com/hatch/accounts/avatars/a.webp"
  );
});

test("Aliyun presign signs a public-endpoint URL for the exact key, method and Content-Type, even when the store itself uses the internal endpoint", async () => {
  const { AliyunArtifactObjectStore } = await import("./creatorLearning/objectStore.js");
  const store = new AliyunArtifactObjectStore({
    bucket: "hatch-test", region: "oss-cn-shanghai", internal: true, prefix: "hatch",
    credential: { getCredential: async () => ({ accessKeyId: "AKID", accessKeySecret: "secret", securityToken: "sts-token" }) }
  });
  const put = await store.presign("creator-products/a/p/ingest-uploads/u/talk.mp4", { method: "PUT", expiresSeconds: 900, contentType: "video/mp4" });
  const url = new URL(put.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "hatch-test.oss-cn-shanghai.aliyuncs.com", "the public endpoint, reachable from a browser");
  assert.equal(url.pathname, "/hatch/creator-products/a/p/ingest-uploads/u/talk.mp4");
  assert.ok(url.searchParams.get("Signature") && url.searchParams.get("OSSAccessKeyId") === "AKID" && url.searchParams.get("security-token") === "sts-token");
  assert.ok(Number(url.searchParams.get("Expires")) - Date.now() / 1000 <= 900 + 5);
  assert.deepEqual(put.headers, { "Content-Type": "video/mp4" });
  const get = await store.presign("creator-products/a/p/ingest-uploads/u/talk.mp4", { method: "GET", expiresSeconds: 3600 });
  assert.deepEqual(get.headers, {});
  assert.notEqual(new URL(get.url).searchParams.get("Signature"), url.searchParams.get("Signature"));
});

test("Local copy moves an object inside the store, keeps its type, and leaves an existing target alone", async () => {
  const { LocalArtifactObjectStore } = await import("./creatorLearning/objectStore.js");
  const store = new LocalArtifactObjectStore(await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "hatch-copy-")));
  await store.put("staging/a/talk.mp4", Buffer.from("frames"), { contentType: "video/mp4" });
  await store.copy("staging/a/talk.mp4", "products/p/talk.mp4");
  assert.equal((await store.get("products/p/talk.mp4")).toString(), "frames");
  assert.deepEqual(await store.head("products/p/talk.mp4"), { bytes: 6, contentType: "video/mp4" });
  await store.put("products/p/other.mp4", Buffer.from("keep"), { contentType: "video/mp4" });
  await store.copy("staging/a/talk.mp4", "products/p/other.mp4");
  assert.equal((await store.get("products/p/other.mp4")).toString(), "keep");
  await assert.rejects(store.copy("staging/none", "products/p/x"), /ENOENT/);
});
