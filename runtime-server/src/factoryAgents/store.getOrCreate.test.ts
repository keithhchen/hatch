import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkbenchStore } from "./store.js";

test("getOrCreate: concurrent callers, even from separate store instances, get one session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-getorcreate-"));
  const scope = { creatorId: "c1", productId: "p1" };
  const stores = [new WorkbenchStore(root, scope), new WorkbenchStore(root, scope)];
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => stores[i % 2]!.getOrCreate("research")));
    assert.equal(new Set(results.map(r => r.session.id)).size, 1);
    assert.equal(results.filter(r => r.created).length, 1, "exactly one creator");
    assert.equal((await stores[0]!.list()).length, 1);
    assert.equal((await stores[1]!.getOrCreate("research")).created, false);
    assert.notEqual((await stores[0]!.getOrCreate("voice")).session.id, results[0]!.session.id, "another role is another session");
  } finally { await rm(root, { recursive: true, force: true }); }
});
