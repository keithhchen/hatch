import assert from "node:assert/strict";
import { test } from "node:test";
import { createConversationOwner } from "./conversation-owner.js";
import { createConversationSessionManager } from "./conversation-session.js";

const scope = (conversationId) => ({ accountId: "account", entitlementId: "agent", conversationId });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("claim listens before acquiring; another window activates A while owner currently shows B", async () => {
  const manager = createConversationSessionManager();
  const a = manager.get(scope("A"));
  const b = manager.get(scope("B"));
  a.set("composerDraft", "draft A");
  b.set("composerDraft", "draft B");
  a.set("readingPosition", { top: 125, followTail: false });
  a.ref("socketRef").current = { close() {} };
  const socket = a.ref("socketRef").current;
  a.ref("activeRunRef").current = { runId: "run-A" };
  manager.select(b);
  let activate;
  let listening = false;
  const calls = [];
  const owner = createConversationOwner({
    listen: async (_name, callback) => { listening = true; activate = callback; return () => {}; },
    invoke: async (name, args) => {
      assert.ok(listening);
      calls.push([name, args]);
      return { owned: true, windowLabel: "main", lease: `lease-${args.conversationId}` };
    },
    onActivate: ({ conversationId }) => manager.select(manager.get(scope(conversationId)))
  });
  assert.ok(await owner.claim(a));
  assert.ok(await owner.claim(b));
  activate({ payload: scope("A") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(manager.isSelected(a));
  assert.equal(a.ref("socketRef").current, socket);
  assert.equal(a.ref("activeRunRef").current.runId, "run-A");
  assert.equal(a.snapshot().composerDraft, "draft A");
  assert.equal(b.snapshot().composerDraft, "draft B");
  assert.equal(a.snapshot().readingPosition.top, 125);
  assert.ok(!calls.some(([name]) => name.startsWith("release")));
  await manager.closeAll();
  assert.equal(calls.filter(([name]) => name === "release_conversation_session").length, 2);
});

test("redirected session does not open a second draft; simultaneous local claims share one call", async () => {
  const manager = createConversationSessionManager();
  const a = manager.get(scope("A"));
  const pending = deferred();
  let count = 0;
  const owner = createConversationOwner({ listen: async () => () => {}, onActivate() {},
    invoke: async () => { count++; return pending.promise; } });
  a.ensureOwnership = () => owner.claim(a);
  const first = owner.claim(a);
  const second = a.openDraft(async () => { throw new Error("must not open a redirected draft"); });
  await Promise.resolve();
  pending.resolve({ owned: false, windowLabel: "other", lease: null });
  assert.equal(await first, false);
  assert.equal(await second, undefined);
  assert.equal(count, 1);
  assert.equal(a.releaseOwnership, undefined);
  await manager.closeAll();
});

test("close racing claim retains lease until tools clear; failed cleanup prevents release and can retry", async () => {
  const manager = createConversationSessionManager();
  const a = manager.get(scope("A"));
  const claim = deferred();
  const events = [];
  const owner = createConversationOwner({ listen: async () => () => {}, onActivate() {},
    invoke: async (name) => {
      if (name === "claim_conversation_session") return claim.promise;
      events.push("release");
    } });
  let fails = true;
  a.cancelTools = async () => { events.push("cancel"); return true; };
  a.clearContexts = async () => { events.push("clear"); if (fails) throw new Error("clear failed"); };
  const acquiring = owner.claim(a);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = a.close();
  claim.resolve({ owned: true, windowLabel: "main", lease: "lease-A" });
  assert.equal(await acquiring, false);
  await assert.rejects(closing, /Could not close conversation/);
  assert.deepEqual(events, ["cancel", "clear"]);
  fails = false;
  await a.close();
  assert.deepEqual(events, ["cancel", "clear", "cancel", "clear", "release"]);
});

test("listener or malformed native reply fails closed without acquiring a fake lease", async () => {
  const a = createConversationSessionManager().get(scope("A"));
  const owner = createConversationOwner({ listen: async () => { throw new Error("listener unavailable"); },
    invoke: async () => { throw new Error("must not claim before listener"); }, onActivate() {} });
  await assert.rejects(owner.claim(a), /listener unavailable/);
  assert.equal(a.releaseOwnership, undefined);
  const bad = createConversationOwner({ listen: async () => () => {}, invoke: async () => ({ owned: true, windowLabel: "main" }), onActivate() {} });
  await assert.rejects(bad.claim(a), /lease is missing/);
  await a.close();
});

test("activation errors reach existing App handler and dispose unregisters even late listeners", async () => {
  const errors = [];
  let listener;
  let stops = 0;
  const owner = createConversationOwner({
    invoke: async () => { throw new Error("unexpected claim"); },
    listen: async (_event, callback) => { listener = callback; return () => { stops++; }; },
    onActivate: async () => { throw new Error("Could not activate target A"); },
    onError: (error) => errors.push(error.message)
  });
  await owner.start();
  listener({ payload: scope("A") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ["Could not activate target A"]);
  owner.dispose();
  owner.dispose();
  listener({ payload: scope("A") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(errors.length, 1);
  const registering = deferred();
  const late = createConversationOwner({ invoke: async () => {}, listen: () => registering.promise,
    onActivate() {}, onError: (error) => errors.push(error.message) });
  const start = late.start();
  late.dispose();
  registering.resolve(() => { stops++; });
  await start;
  assert.equal(stops, 2);
  await assert.rejects(late.start(), /disposed/);
});
