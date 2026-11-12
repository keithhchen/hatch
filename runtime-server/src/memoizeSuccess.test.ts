import assert from "node:assert/strict";
import test from "node:test";
import { memoizeSuccess } from "./memoizeSuccess.js";

test("memoizeSuccess caches a resolved value", async () => {
  let calls = 0;
  const get = memoizeSuccess(async () => ++calls);
  assert.equal(await get(), 1);
  assert.equal(await get(), 1);
  assert.equal(calls, 1);
});

test("memoizeSuccess retries after a rejection", async () => {
  let calls = 0;
  const get = memoizeSuccess(async () => { if (++calls === 1) throw new Error("boom"); return calls; });
  await assert.rejects(get(), /boom/);
  assert.equal(await get(), 2);
  assert.equal(await get(), 2);
});

test("memoizeSuccess shares one in-flight promise between concurrent callers", async () => {
  let calls = 0;
  const get = memoizeSuccess(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return "ok"; });
  assert.deepEqual(await Promise.all([get(), get(), get()]), ["ok", "ok", "ok"]);
  assert.equal(calls, 1);
});
