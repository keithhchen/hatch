import assert from "node:assert/strict";
import test from "node:test";
import { keepTyping } from "./typing.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("typing repeats while the reply is awaited, and stops when it is sent", async () => {
  let beats = 0; let waiting = true;
  const done = keepTyping(async () => { beats += 1; }, async () => waiting, { everyMs: 10, maxMs: 5_000 });
  await sleep(55);
  waiting = false;
  await done;
  const stopped = beats;
  assert.ok(stopped >= 3, `beat ${stopped} times`);
  await sleep(40);
  assert.equal(beats, stopped);
});

test("typing stops at the cap even when the reply never comes", async () => {
  let beats = 0;
  await keepTyping(async () => { beats += 1; }, async () => true, { everyMs: 10, maxMs: 55 });
  assert.ok(beats >= 2 && beats <= 7, `beat ${beats} times`);
});

test("a failing indicator or a failing check never reaches the caller", async () => {
  let beats = 0;
  await keepTyping(async () => { beats += 1; throw new Error("429"); }, async () => beats < 2, { everyMs: 1, maxMs: 1_000 });
  assert.equal(beats, 2);
  await keepTyping(async () => { beats += 1; }, async () => { throw new Error("db down"); }, { everyMs: 1, maxMs: 1_000 });
  assert.equal(beats, 2);
});
