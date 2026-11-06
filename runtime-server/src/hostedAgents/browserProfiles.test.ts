import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
const baseTest = test;
import pg from "pg";
import { CredentialSeal } from "../assistant/channelCredentials.js";
import { cookiesFromExport, hostsForCookies, MemoryBrowserProfiles, PostgresBrowserProfiles } from "./browserProfiles.js";
import type { BrowserCookie, BrowserProfileStore } from "./ports.js";

const fingerprint = { userAgent: "UA", locale: "zh-CN", timezone: "Asia/Shanghai", viewport: { width: 1280, height: 800 } };
const cookie = (name: string, value: string, extra: Partial<BrowserCookie> = {}): BrowserCookie => ({ name, value, domain: ".xiaohongshu.com", path: "/", ...extra });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const future = () => Math.floor(Date.now() / 1000) + 3600;

async function seed(store: BrowserProfileStore, accountId: string, platform = "xiaohongshu", label = "main", extra: object = {}) {
  return store.put({ accountId, platform, label, hosts: ["xiaohongshu.com"], cookies: [cookie("a", "1", { expires: future() }), cookie("b", "1")], fingerprint, proxy: "http://u:p@h:1", status: "ready", ...extra });
}

/** The shared contract, run against the Memory store and, when a database is reachable, Postgres. */
function storeTests(name: string, open: () => Promise<{ store: BrowserProfileStore; cleanup?: () => Promise<void> }>, skip: string | false = false) {
  const test = (title: string, run: () => Promise<void>) => baseTest(title, { skip }, run);
  test(`${name}: put, list newest first, remove scoped to account`, async () => {
    const { store, cleanup } = await open();
    try {
      const account = randomUUID();
      const first = await seed(store, account, "xiaohongshu", "one");
      await sleep(3);
      const second = await seed(store, account, "douyin", "two");
      assert.deepEqual((await store.list(account)).map(p => p.label), ["two", "one"]);
      assert.equal(first.proxy, "http://u:p@h:1");
      assert.equal((await store.list(account))[1]!.cookies.length, 2);
      const updated = await store.put({ ...first, label: "renamed" });
      assert.equal(updated.id, first.id);
      await assert.rejects(store.put({ ...first, accountId: randomUUID() }), /not found/);
      await store.remove(randomUUID(), second.id);
      assert.equal((await store.list(account)).length, 2);
      await store.remove(account, second.id);
      assert.deepEqual((await store.list(account)).map(p => p.label), ["renamed"]);
    } finally { await cleanup?.(); }
  });

  test(`${name}: lease is exclusive, expiry is takeable, needs_login is excluded`, async () => {
    const { store, cleanup } = await open();
    try {
      const account = randomUUID();
      await seed(store, account);
      await seed(store, account, "douyin");
      await seed(store, account, "weibo", "login", { status: "needs_login" });
      const first = await store.lease(account, ["xiaohongshu", "douyin", "weibo"], "run-1", 60_000);
      assert.deepEqual(first.map(l => l.profile.platform).sort(), ["douyin", "xiaohongshu"]);
      assert.equal(first[0]!.profile.cookies.length, 2);
      assert.deepEqual(await store.lease(account, ["xiaohongshu"], "run-2", 60_000), []);
      await store.release(first.find(l => l.profile.platform === "xiaohongshu")!.leaseId, { status: "ready" });
      assert.equal((await store.lease(account, ["xiaohongshu"], "run-3", 60_000)).length, 1);
      assert.deepEqual(await store.lease(randomUUID(), ["xiaohongshu"], "other", 60_000), []);
      await store.release(first.find(l => l.profile.platform === "douyin")!.leaseId, { status: "ready" });
      const short = await store.lease(account, ["douyin"], "run-4", 1);
      assert.equal(short.length, 1);
      await sleep(20);
      assert.equal((await store.lease(account, ["douyin"], "run-5", 60_000)).length, 1);
    } finally { await cleanup?.(); }
  });

  test(`${name}: lease picks the least recently used profile per platform`, async () => {
    const { store, cleanup } = await open();
    try {
      const account = randomUUID();
      const a = await seed(store, account, "xiaohongshu", "a");
      const b = await seed(store, account, "xiaohongshu", "b");
      const one = (await store.lease(account, ["xiaohongshu"], "r1", 60_000))[0]!;
      assert.equal(one.profile.id, a.id);
      await store.release(one.leaseId, { status: "ready" });
      await sleep(5);
      const two = await store.lease(account, ["xiaohongshu"], "r2", 60_000);
      assert.equal(two.length, 1);
      assert.equal(two[0]!.profile.id, b.id);
      await store.release(two[0]!.leaseId, { status: "ready" });
      await sleep(5);
      assert.equal((await store.lease(account, ["xiaohongshu"], "r3", 60_000))[0]!.profile.id, a.id);
    } finally { await cleanup?.(); }
  });

  test(`${name}: release merges cookies, drops expired, records outcome`, async () => {
    const { store, cleanup } = await open();
    try {
      const account = randomUUID();
      await store.put({ accountId: account, platform: "xiaohongshu", label: "m", hosts: [], fingerprint, status: "ready", cookies: [cookie("a", "old", { expires: future() }), cookie("b", "keep"), cookie("gone", "x", { expires: future() }), cookie("a", "other-path", { path: "/x" })] });
      const lease = (await store.lease(account, ["xiaohongshu"], "r", 60_000))[0]!;
      await store.release(lease.leaseId, { status: "needs_login", note: "captcha", cookies: [cookie("a", "new", { expires: future() }), cookie("gone", "x", { expires: 1 }), cookie("c", "added")] });
      const [profile] = await store.list(account);
      const values = Object.fromEntries(profile!.cookies.map(c => [`${c.name}${c.path}`, c.value]));
      assert.deepEqual(values, { "a/": "new", "b/": "keep", "a/x": "other-path", "c/": "added" });
      assert.equal(profile!.status, "needs_login");
      assert.equal(profile!.note, "captcha");
      assert.deepEqual(await store.lease(account, ["xiaohongshu"], "r2", 60_000), []);
    } finally { await cleanup?.(); }
  });

  test(`${name}: stale, unknown and repeated releases cannot clobber a newer lease`, async () => {
    const { store, cleanup } = await open();
    try {
      const account = randomUUID();
      await seed(store, account);
      const old = (await store.lease(account, ["xiaohongshu"], "old", 1))[0]!;
      await sleep(20);
      await store.release(old.leaseId, { status: "needs_login", cookies: [cookie("a", "stale")] });
      assert.equal((await store.list(account))[0]!.status, "ready");
      const fresh = (await store.lease(account, ["xiaohongshu"], "new", 60_000))[0]!;
      await store.release(old.leaseId, { status: "needs_login", cookies: [cookie("a", "stale")] });
      await store.release(randomUUID(), { status: "needs_login" });
      await store.release("not-a-uuid", { status: "needs_login" });
      assert.deepEqual(await store.lease(account, ["xiaohongshu"], "third", 60_000), []);
      await store.release(fresh.leaseId, { status: "ready", cookies: [cookie("a", "fresh", { expires: future() })] });
      const [profile] = await store.list(account);
      assert.equal(profile!.cookies.find(c => c.name === "a")!.value, "fresh");
      await store.release(fresh.leaseId, { status: "needs_login" });
      assert.equal((await store.list(account))[0]!.status, "ready");
    } finally { await cleanup?.(); }
  });
}

storeTests("memory", async () => ({ store: new MemoryBrowserProfiles() }));

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL ?? "postgres://localhost:55471/hatch_it";
const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 1500 });
const reachable = await pool.query("SELECT 1").then(() => true, () => false);
after(() => pool.end().catch(() => undefined));
const skip = reachable ? false : "no reachable test Postgres (set HATCH_TEST_DATABASE_URL)";

/** Wraps a store so every account it touched has its rows deleted afterwards. */
async function openPostgres() {
  const store = await PostgresBrowserProfiles.open(pool, new CredentialSeal("browser-profiles-test"));
  const accounts = new Set<string>();
  const track = <A extends unknown[], R>(fn: (...args: A) => R, account: (...args: A) => string) => (...args: A) => { accounts.add(account(...args)); return fn(...args); };
  const tracked: BrowserProfileStore = {
    put: track(p => store.put(p), p => p.accountId), list: a => store.list(a), lease: track((a, p, h, t) => store.lease(a, p, h, t), a => a),
    release: (l, o) => store.release(l, o), remove: (a, i) => store.remove(a, i),
  };
  return { store: tracked, cleanup: async () => { await pool.query("DELETE FROM hatch_browser_profiles WHERE account_id = ANY($1::uuid[])", [[...accounts]]); } };
}
storeTests("postgres", openPostgres, skip);

test("postgres seals cookies and proxy at rest", { skip }, async () => {
  const { store, cleanup } = await openPostgres();
  try {
    const account = randomUUID();
    await store.put({ accountId: account, platform: "x", label: "m", hosts: [], fingerprint, status: "ready", proxy: "http://secret-proxy:1", cookies: [cookie("sid", "secret-cookie-value")] });
    const { rows } = await pool.query("SELECT sealed FROM hatch_browser_profiles WHERE account_id = $1", [account]);
    assert.doesNotMatch(rows[0].sealed, /secret/);
    assert.doesNotMatch(Buffer.from(rows[0].sealed, "base64").toString("latin1"), /secret/);
  } finally { await cleanup(); }
});

test("cookiesFromExport reads Playwright storageState", () => {
  const cookies = cookiesFromExport({ cookies: [{ name: "a", value: "1", domain: ".x.com", path: "/", expires: 1900000000, httpOnly: true, secure: true, sameSite: "Lax" }, { name: "s", value: "2", domain: "x.com", path: "/", expires: -1, sameSite: "None" }], origins: [] });
  assert.deepEqual(cookies[0], { name: "a", value: "1", domain: ".x.com", path: "/", expires: 1900000000, httpOnly: true, secure: true, sameSite: "Lax" });
  assert.equal(cookies[1]!.expires, undefined);
  assert.equal(cookies[1]!.sameSite, "None");
});

test("cookiesFromExport reads Cookie-Editor / EditThisCookie arrays", () => {
  const cookies = cookiesFromExport([
    { name: "a", value: "1", domain: ".x.com", path: "/", expirationDate: 1900000000.5, hostOnly: false, sameSite: "no_restriction", secure: true },
    { name: "b", value: "2", domain: "x.com", hostOnly: true, session: true, sameSite: "unspecified" },
    { name: "c", value: "3", domain: ".x.com", path: "/p", sameSite: "strict" },
  ]);
  assert.equal(cookies[0]!.sameSite, "None");
  assert.equal(cookies[0]!.expires, 1900000000.5);
  assert.equal(cookies[1]!.sameSite, undefined);
  assert.equal(cookies[1]!.expires, undefined);
  assert.equal(cookies[1]!.path, "/");
  assert.equal(cookies[2]!.sameSite, "Strict");
});

test("cookiesFromExport reads DevTools-style arrays and JSON text, millisecond expiry normalised", () => {
  const cookies = cookiesFromExport(JSON.stringify([{ name: "a", value: "1", domain: ".x.com", path: "/", expires: 1900000000000, httpOnly: false, sameSite: "Lax", size: 2, priority: "Medium" }]));
  assert.equal(cookies[0]!.expires, 1900000000);
  assert.equal(cookies[0]!.httpOnly, false);
  assert.equal("size" in cookies[0]!, false);
});

test("cookiesFromExport rejects non-cookie input", () => {
  assert.throws(() => cookiesFromExport({ foo: 1 }), /Not a cookie export/);
  assert.throws(() => cookiesFromExport("nope"), /not valid JSON/);
  assert.throws(() => cookiesFromExport(null), /Not a cookie export/);
  assert.throws(() => cookiesFromExport([{ name: "a" }]), /Cookie #1/);
});

test("hostsForCookies returns root and wildcard of registrable hosts", () => {
  assert.deepEqual(hostsForCookies([cookie("a", "1")]), ["xiaohongshu.com", "*.xiaohongshu.com"]);
  assert.deepEqual(hostsForCookies([cookie("a", "1", { domain: "www.xiaohongshu.com" }), cookie("b", "1", { domain: "edith.xiaohongshu.com" }), cookie("c", "1", { domain: ".douyin.com" })]), ["douyin.com", "*.douyin.com", "xiaohongshu.com", "*.xiaohongshu.com"]);
  assert.deepEqual(hostsForCookies([cookie("a", "1", { domain: ".example.com.cn" })]), ["example.com.cn", "*.example.com.cn"]);
  assert.deepEqual(hostsForCookies([]), []);
});
