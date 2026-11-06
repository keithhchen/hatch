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
