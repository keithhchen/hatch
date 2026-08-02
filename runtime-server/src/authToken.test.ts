import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyHatchAuthToken } from "./authToken.js";

test("Runtime verifies the Registry signed account token", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "HATCH" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "maya-chen", role: "creator", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const token = `${unsigned}.${createHmac("sha256", "test-secret").update(unsigned).digest("base64url")}`;
  assert.deepEqual(verifyHatchAuthToken(token, "test-secret"), {
    sub: "maya-chen",
    role: "creator",
    exp: JSON.parse(Buffer.from(payload, "base64url").toString()).exp
  });
});

test("Runtime rejects expired or tampered account tokens", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "HATCH" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "user_1", role: "user", exp: 1 })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const token = `${unsigned}.${createHmac("sha256", "test-secret").update(unsigned).digest("base64url")}`;
  assert.equal(verifyHatchAuthToken(token, "test-secret"), undefined);
  assert.equal(verifyHatchAuthToken(`${unsigned}.tampered`, "test-secret"), undefined);
});
