import assert from "node:assert/strict";
import test from "node:test";
import { AccountStoreTs } from "./registryAuth.js";

test("opaque desktop sessions expire, refresh idle activity, and revoke server-side", async () => {
  const accounts = new AccountStoreTs();
  const account = await accounts.create("jordan@example.com", "password123", "user", "Jordan Lee");
  const issuedAt = Date.parse(account.created_at);
  const issued = await accounts.createSession(account, issuedAt);

  const active = await accounts.resolveSession(issued.token, issuedAt + 1_000);
  assert.equal(active?.account.id, account.id);
  assert.equal(active?.session.last_seen_at, new Date(issuedAt + 1_000).toISOString());

  const keptAlive = await accounts.resolveSession(issued.token, issuedAt + 29 * 24 * 60 * 60 * 1000);
  assert.ok(keptAlive);
  const idleExpired = await accounts.resolveSession(issued.token, issuedAt + 59 * 24 * 60 * 60 * 1000 + 1);
  assert.equal(idleExpired, undefined);

  const absoluteSession = await accounts.createSession(account, issuedAt);
  const absoluteExpired = await accounts.resolveSession(absoluteSession.token, issuedAt + 90 * 24 * 60 * 60 * 1000 + 1);
  assert.equal(absoluteExpired, undefined);

  const second = await accounts.createSession(account, issuedAt);
  await accounts.revokeSession(second.token);
  assert.equal(await accounts.resolveSession(second.token, issuedAt + 1_000), undefined);
});
