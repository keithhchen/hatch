import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelHub } from "./hub.js";
import { ChannelListeners } from "./listeners.js";
import type { ChannelAdapter, ChannelKind } from "./types.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** A fake adapter whose listen blocks until aborted, or throws when `fail` is set. */
function adapter(kind: ChannelKind, options: { fail?: boolean; listens?: boolean } = {}) {
  const log = { started: 0, running: 0, maxRunning: 0 };
  const fake = {
    kind, available: () => true, log,
    ...(options.listens === false ? {} : {
      listen: async (_: unknown, signal: AbortSignal) => {
        log.started++; log.running++; log.maxRunning = Math.max(log.maxRunning, log.running);
        try {
          if (options.fail) throw new Error("refused");
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        } finally { log.running--; }
      },
    }),
  };
  return fake as unknown as ChannelAdapter & { log: typeof log };
}

/** One lock table shared by every "process": a holder blocks the others, who skip. */
const lockTable = () => {
  const held = new Set<string>();
  return async (name: string, fn: () => Promise<void>) => {
    if (held.has(name)) return;
    held.add(name);
    try { await fn(); } finally { held.delete(name); }
  };
};

function world(shared: ChannelAdapter[] = []) {
  const own = new Map<string, ChannelAdapter | undefined>();
  const rows: Array<{ ownerAccountId: string; channel: ChannelKind; scope: string }> = [];
  const hub = new ChannelHub(shared, async (kind, scope) => own.get(`${kind}:${scope}`));
  const errors: Array<[string, unknown]> = [];
  const manager = (exclusive = lockTable(), backoff = 5) => new ChannelListeners({
    hub, connections: { listening: async () => rows }, exclusive, accept: async () => {}, onError: (key, error) => errors.push([key, error]), backoff,
  });
  return { own, rows, hub, errors, manager };
}

test("new credentials start a listener, removed credentials stop it", async () => {
  const w = world(); const a = adapter("feishu");
  const listeners = w.manager();
  w.rows.push({ ownerAccountId: "u1", channel: "feishu", scope: "u1" }); w.own.set("feishu:u1", a);
  await listeners.reconcile(); await tick();
  assert.equal(a.log.running, 1);
  await listeners.reconcile(); await tick();
  assert.equal(a.log.started, 1);
  w.rows.length = 0; w.own.delete("feishu:u1");
  await listeners.reconcile();
  assert.equal(a.log.running, 0);
  await listeners.stop();
});

test("replaced credentials restart the listener with the new adapter", async () => {
  const w = world(); const [old, next] = [adapter("feishu"), adapter("feishu")];
  const listeners = w.manager();
  w.rows.push({ ownerAccountId: "u1", channel: "feishu", scope: "u1" }); w.own.set("feishu:u1", old);
  await listeners.reconcile(); await tick();
  w.own.set("feishu:u1", next);
  await listeners.reconcile(); await tick();
  assert.deepEqual([old.log.running, next.log.running], [0, 1]);
  await listeners.stop();
});

test("a revoked connection stops its listener", async () => {
  const w = world(); const a = adapter("lark");
  const listeners = w.manager();
  w.rows.push({ ownerAccountId: "u1", channel: "lark", scope: "u1" }); w.own.set("lark:u1", a);
  await listeners.reconcile(); await tick();
  w.rows.length = 0;
  await listeners.reconcile();
  assert.equal(a.log.running, 0);
  await listeners.stop();
});

test("shared adapters listen too", async () => {
  const a = adapter("telegram"); const w = world([a]);
  const listeners = w.manager();
  await listeners.reconcile(); await tick();
  assert.equal(a.log.running, 1);
  await listeners.stop();
});

test("two processes never run the same key at once", async () => {
  const w = world(); const a = adapter("feishu");
  w.rows.push({ ownerAccountId: "u1", channel: "feishu", scope: "u1" }); w.own.set("feishu:u1", a);
  const exclusive = lockTable();
  const [one, two] = [w.manager(exclusive), w.manager(exclusive)];
  await one.reconcile(); await two.reconcile(); await tick(); await tick(); await tick();
  assert.equal(a.log.maxRunning, 1);
  await one.stop();
  await tick(); await tick();
  assert.equal(a.log.running, 1, "the other process takes over once the lock is released");
  assert.equal(a.log.maxRunning, 1);
  await two.stop();
});

test("a throwing adapter is retried after backoff and reported", async () => {
  const w = world(); const a = adapter("feishu", { fail: true });
  const listeners = w.manager();
  w.rows.push({ ownerAccountId: "u1", channel: "feishu", scope: "u1" }); w.own.set("feishu:u1", a);
  await listeners.reconcile();
  await new Promise(resolve => setTimeout(resolve, 40));
  await listeners.stop();
  assert.ok(a.log.started >= 2);
  assert.equal((w.errors[0]![1] as Error).message, "refused");
  assert.equal(w.errors[0]![0], "feishu:u1");
});

test("adapters without listen or unavailable are ignored", async () => {
  const w = world(); const quiet = adapter("wecom", { listens: false });
  const off = adapter("wechatkf"); (off as any).available = () => false;
  const listeners = w.manager();
  w.rows.push({ ownerAccountId: "u1", channel: "wecom", scope: "u1" }, { ownerAccountId: "u2", channel: "wechatkf", scope: "u2" }, { ownerAccountId: "u3", channel: "lark", scope: "u3" });
  w.own.set("wecom:u1", quiet); w.own.set("wechatkf:u2", off);
  await listeners.reconcile(); await tick();
  assert.equal(off.log.started, 0);
  await listeners.stop();
});

test("stop aborts every listener", async () => {
  const w = world(); const [a, b] = [adapter("feishu"), adapter("lark")];
  const listeners = w.manager();
  w.rows.push({ ownerAccountId: "u1", channel: "feishu", scope: "u1" }, { ownerAccountId: "u2", channel: "lark", scope: "u2" });
  w.own.set("feishu:u1", a); w.own.set("lark:u2", b);
  await listeners.reconcile(); await tick();
  await listeners.stop();
  assert.deepEqual([a.log.running, b.log.running], [0, 0]);
});
