import assert from "node:assert/strict";
import test from "node:test";
import { audienceIdentity } from "./productRoutes.js";

test("only UUIDv4 owners are accounts; code: and other prefixes never reach the account lookup", () => {
  const id = "3f2b8c1e-9d4a-4e6b-8a1c-5d7e9f0a1b2c";
  assert.deepEqual(audienceIdentity(id), { kind: "account", account_id: id });
  assert.deepEqual(audienceIdentity("contact:tg:1"), { kind: "im" });
  assert.deepEqual(audienceIdentity("code:ABC123"), { kind: "guest" });
  assert.deepEqual(audienceIdentity("something-else"), { kind: "guest" });
});
