import assert from "node:assert/strict";
import test from "node:test";
import { mapLimit, singleFlight } from "./bounded.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("mapLimit never runs more than the limit at once and keeps order", async () => {
  let running = 0; let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { running++; peak = Math.max(peak, running); await sleep(5); running--; return n * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test("singleFlight: concurrent callers of one key share one computation; a failure is not remembered", async () => {
  let computed = 0;
  let fail = true;
  const mint = singleFlight(async (key: string) => { computed++; await sleep(10); if (fail) throw new Error("down"); return `${key}-token`; });
  const first = await Promise.allSettled([mint("a"), mint("a"), mint("a")]);
  assert.equal(computed, 1);
  assert.ok(first.every((result) => result.status === "rejected"));
  fail = false;
  assert.deepEqual(await Promise.all([mint("a"), mint("a"), mint("b")]), ["a-token", "a-token", "b-token"]);
  assert.equal(computed, 3, "one more for a, one for b");
});
