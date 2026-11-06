import assert from "node:assert/strict";
import test from "node:test";
import { CredentialSeal } from "./channelCredentials.js";

test("Sealed credentials open only with the same key and don't show the secret", () => {
  const sealed = new CredentialSeal("key-a").seal({ appSecret: "shh-secret" });
  assert.ok(!Buffer.from(sealed, "base64").toString("latin1").includes("shh-secret"));
  assert.deepEqual(new CredentialSeal("key-a").open(sealed), { appSecret: "shh-secret" });
  assert.throws(() => new CredentialSeal("key-b").open(sealed));
});
