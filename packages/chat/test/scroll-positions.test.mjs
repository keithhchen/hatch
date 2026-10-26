import assert from "node:assert/strict";
import test from "node:test";
import { ScrollPositions } from "../src/domain/scroll-positions.js";

test("scroll positions are kept per conversation, bounded, and reported most recent first", () => {
  const reported = [];
  const positions = new ScrollPositions({ limit: 2, onChange: value => reported.push(value) });
  positions.save("a", { top: 120, atBottom: false });
  positions.save("b", { top: 900, atBottom: true });
  positions.save("b", { top: 950, atBottom: true });
  assert.equal(reported.length, 2, "moving along the bottom is not a change");
  positions.save("c", { top: 10, atBottom: false });
  assert.equal(positions.get("a"), null);
  assert.deepEqual(positions.get("c"), { top: 10, atBottom: false });
  assert.deepEqual(Object.keys(positions.toJSON()), ["c", "b"]);
  positions.save("", { top: 1, atBottom: false });
  positions.save("d", { top: -1, atBottom: false });
  assert.equal(positions.get("d"), null);
});

test("persisted entries seed the store oldest first", () => {
  const positions = new ScrollPositions({ entries: { newer: { top: 5, atBottom: false }, older: { top: 7, atBottom: true } } });
  assert.deepEqual(Object.keys(positions.toJSON()), ["newer", "older"]);
  assert.deepEqual(positions.get("older"), { top: 7, atBottom: true });
  const live = new ScrollPositions();
  live.save("seen", { top: 3, atBottom: false });
  live.restore({ seen: { top: 99, atBottom: false }, saved: { top: 4, atBottom: false } });
  assert.deepEqual(live.get("seen"), { top: 3, atBottom: false }, "a position recorded this session wins");
  assert.deepEqual(Object.keys(live.toJSON()), ["seen", "saved"]);
});
