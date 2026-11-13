import assert from "node:assert/strict";
import test from "node:test";
import { createClickThrottle } from "../src/domain/click-throttle.js";

// The composer's action slot: Send and Stop share one throttle, so a double-click on Send never reaches the Stop that replaces it.
const slot = () => {
  let time = 1000;
  const calls = [];
  const throttle = createClickThrottle({ now: () => time });
  return {
    calls,
    advance: ms => { time += ms; },
    send: () => throttle(() => calls.push("send")),
    stop: () => throttle(() => calls.push("cancel"))
  };
};

test("double-click on Send sends once and does not cancel the Run it started", () => {
  const s = slot();
  s.send();
  s.stop();
  assert.deepEqual(s.calls, ["send"]);
});

test("a Run that starts without a click can be stopped immediately", () => {
  const s = slot();
  s.stop();
  assert.deepEqual(s.calls, ["cancel"]);
});

test("two clicks on Stop a second apart both reach cancel", () => {
  const s = slot();
  s.stop();
  s.advance(1000);
  s.stop();
  assert.deepEqual(s.calls, ["cancel", "cancel"]);
});
