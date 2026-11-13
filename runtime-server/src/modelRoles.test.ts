import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROLES, InMemoryModelRoleResolver, PostgresModelRoleResolver, profileForRole, type ModelRolesDatabase } from "./modelRoles.js";

const quiet = async <T>(work: () => Promise<T>): Promise<T> => { const log = console.error; console.error = () => undefined; try { return await work(); } finally { console.error = log; } };

test("the seed rows keep today's production choices", () => {
  assert.deepEqual({ ...MODEL_ROLES }, { chat: "kimi-k3.1-pro", assistant: "gemini-api", worker: "kimi-k3.1-pro", factory: "gemini-3.1-pro", ingest: "kimi-k3.1-pro", inspiration: "kimi-k3.1-pro", content: "kimi-k3.1-pro" });
});

/** A database of two tables, counting the reads that reach it. */
function fakeDatabase() {
  const roles = new Map<string, string>(), products = new Map<string, string>();
  const reads: string[] = [];
  const database: ModelRolesDatabase = {
    async query(text, values = []) {
      if (/^\s*CREATE TABLE/i.test(text)) return { rows: [] };
      if (/INSERT INTO hatch_model_roles/.test(text)) {
        (values[0] as string[]).forEach((role, i) => { if (!roles.has(role)) roles.set(role, (values[1] as string[])[i]!); });
        return { rows: [] };
      }
      reads.push(text);
      const table = /hatch_product_models/.test(text) ? products : roles;
      const profile = table.get(String(values[0]));
      return { rows: profile ? [{ profile }] : [] };
    }
  };
  return { database, roles, products, reads };
}

test("the global role resolves to its profile; a product override applies to chat only", async () => {
  const { database, products } = fakeDatabase();
  const resolver = new PostgresModelRoleResolver(database);
  assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro");
  assert.equal((await resolver.resolve("assistant")).name, "gemini-api");
  assert.equal((await resolver.resolve("factory")).name, "gemini-3.1-pro");
  products.set("product-1", "gemini-api");
  assert.equal((await resolver.resolve("chat", { productId: "product-1" })).name, "gemini-api");
  assert.equal((await resolver.resolve("chat", { productId: "product-2" })).name, "kimi-k3.1-pro", "another product keeps the global choice");
  assert.equal((await resolver.resolve("worker", { productId: "product-1" })).name, "kimi-k3.1-pro", "only chat has a per-product override");
});

test("a choice is cached for 30 seconds per key, then read again", async () => {
  const { database, roles, products, reads } = fakeDatabase();
  let now = 1_000;
  const resolver = new PostgresModelRoleResolver(database, { now: () => now });
  assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro");
  const first = reads.length;
  roles.set("chat", "gemini-api");
  now += 29_999;
  assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro", "still the cached choice");
  assert.equal(reads.length, first);
  now += 1;
  assert.equal((await resolver.resolve("chat")).name, "gemini-api", "after 30 s the row is read again");
  products.set("p", "deepseek-v4-pro");
  assert.equal((await resolver.resolve("chat", { productId: "p" })).name, "deepseek-v4-pro");
  products.delete("p");
  assert.equal((await resolver.resolve("chat", { productId: "p" })).name, "deepseek-v4-pro", "each key has its own cache entry");
  now += 30_000;
  assert.equal((await resolver.resolve("chat", { productId: "p" })).name, "gemini-api");
});

test("an unknown profile, a profile the role does not allow, or a missing row is model_profile_invalid and is logged; nothing falls back", async () => {
  const { database, roles, products } = fakeDatabase();
  const resolver = new PostgresModelRoleResolver(database, { cacheMs: 0 });
  await resolver.resolve("chat");
  const invalid = (error: unknown) => (error as { code?: string }).code === "model_profile_invalid";
  roles.set("chat", "no-such-model");
  await assert.rejects(quiet(() => resolver.resolve("chat")), invalid);
  roles.set("ingest", "gemini-api");
  await assert.rejects(quiet(() => resolver.resolve("ingest")), invalid, "ingest runs on Kimi only");
  roles.set("factory", "deepseek-v4-pro");
  await assert.rejects(quiet(() => resolver.resolve("factory")), invalid, "factory does not allow deepseek-v4-pro");
  roles.delete("worker");
  await assert.rejects(quiet(() => resolver.resolve("worker")), invalid);
  roles.set("chat", "kimi-k3.1-pro");
  products.set("p", "typo");
  await assert.rejects(quiet(() => resolver.resolve("chat", { productId: "p" })), invalid, "a bad product row does not fall back to the global role");
  const lines: string[] = [];
  const log = console.error;
  console.error = (line: unknown) => { lines.push(String(line)); };
  try { assert.throws(() => profileForRole("chat", "nope", "hatch_model_roles chat"), invalid); } finally { console.error = log; }
  assert.ok(lines.some(line => line.includes('"event":"model_profile_invalid"') && line.includes("nope")));
});

test("a failed schema step is not remembered: the next read tries again", async () => {
  let failures = 1;
  const { database } = fakeDatabase();
  const flaky: ModelRolesDatabase = { query: (text, values) => failures-- > 0 ? Promise.reject(new Error("database down")) : database.query(text, values) };
  const resolver = new PostgresModelRoleResolver(flaky);
  await assert.rejects(resolver.resolve("chat"), /database down/);
  assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro");
});

test("the in-memory resolver serves the seeds and what a test sets, uncached", async () => {
  const resolver = new InMemoryModelRoleResolver({ roles: { factory: "deepseek-v4-flash" }, products: { p: "gemini-api" } });
  assert.equal((await resolver.resolve("chat")).name, "kimi-k3.1-pro");
  assert.equal((await resolver.resolve("factory")).name, "deepseek-v4-flash");
  assert.equal((await resolver.resolve("chat", { productId: "p" })).name, "gemini-api");
  resolver.setRole("chat", "deepseek-v4-pro");
  assert.equal((await resolver.resolve("chat")).name, "deepseek-v4-pro");
  resolver.setRole("chat", "bogus");
  await assert.rejects(quiet(() => resolver.resolve("chat")), (error: unknown) => (error as { code?: string }).code === "model_profile_invalid");
});
