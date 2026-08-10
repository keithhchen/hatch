import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountStoreTs,
  PasswordHasher,
  PasswordWorkCapacityError,
  passwordWorkOptionsFromEnvironment,
  validateSigninCredentials,
  verifyPassword
} from "./registryAuth.js";

test("password hashing is asynchronous and rejects work beyond its bounded queue", async () => {
  const hasher = new PasswordHasher({ concurrency: 1, maxQueue: 0 });
  const first = hasher.derive("password123", Buffer.alloc(16, 1));
  await assert.rejects(
    hasher.derive("password456", Buffer.alloc(16, 2)),
    PasswordWorkCapacityError
  );
  assert.match(await first, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(passwordWorkOptionsFromEnvironment({
    HATCH_AUTH_SCRYPT_CONCURRENCY: "2",
    HATCH_AUTH_SCRYPT_MAX_QUEUE: "8"
  }), { concurrency: 2, maxQueue: 8 });
});

test("password verification uses the same generic failure path for an unknown account", async () => {
  const accounts = new AccountStoreTs();
  const account = await accounts.create("signin@example.com", "password123", "user", "Signin User");

  assert.equal(await verifyPassword("password123", account), true);
  assert.equal(await verifyPassword("wrong-password", account), false);
  assert.equal(await verifyPassword("wrong-password", undefined), false);
});

test("authentication fields are bounded before password work", async () => {
  const accounts = new AccountStoreTs();
  assert.throws(
    () => validateSigninCredentials(`${"a".repeat(250)}@example.com`, "password123"),
    /email_invalid/
  );
  assert.throws(
    () => validateSigninCredentials("user@example.com", "x".repeat(1025)),
    /password_too_long/
  );
  await assert.rejects(
    accounts.create("user@example.com", "password123", "user", "x".repeat(129)),
    /display_name_too_long/
  );
  const longestValid = await accounts.create(
    "long-name@example.com",
    "password123",
    "creator",
    "a".repeat(128),
  );
  assert.ok(longestValid.id.length <= 128);
});

test("concurrent duplicate signup has one canonical winner", async () => {
  const accounts = new AccountStoreTs();
  const results = await Promise.allSettled([
    accounts.create("same@example.com", "password123", "user", "First Name"),
    accounts.create(" SAME@example.com ", "password456", "user", "Second Name"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /email_already_registered/);
  assert.equal((await accounts.getByEmail("same@example.com"))?.email, "same@example.com");
});

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

test("Postgres session resolution atomically refreshes only an active row", async () => {
  const now = Date.parse("2026-08-11T00:00:00.000Z");
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{
          id: "00000000-0000-4000-8000-000000000001",
          account_id: "jordan",
          token_hash: "hash",
          client_type: "desktop",
          created_at: "2026-08-01T00:00:00.000Z",
          last_seen_at: new Date(now).toISOString(),
          idle_expires_at: "2026-09-10T00:00:00.000Z",
          absolute_expires_at: "2026-10-30T00:00:00.000Z",
          revoked_at: null,
          account_id_value: "jordan",
          role: "user",
          email: "jordan@example.com",
          display_name: "Jordan",
          password_salt: "salt",
          password_hash: "hash",
          account_created_at: "2026-08-01T00:00:00.000Z",
        }],
      };
    },
  };
  const accounts = new AccountStoreTs(pool as never);
  const resolved = await accounts.resolveSession("opaque-token", now);
  assert.equal(resolved?.account.id, "jordan");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /^UPDATE account_sessions AS s/);
  assert.match(queries[0]!.sql, /s\.revoked_at IS NULL/);
  assert.match(queries[0]!.sql, /RETURNING/);
});
