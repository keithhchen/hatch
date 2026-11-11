import assert from "node:assert/strict";
import test from "node:test";
import { reloadOnStaleBuild } from "./staleBuild.js";

function page(start = 0) {
  const listeners = {}; const store = new Map(); let clock = start; let reloads = 0;
  const target = { addEventListener: (name, fn) => { listeners[name] = fn; }, location: { reload: () => { reloads++; } } };
  const storage = () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) });
  reloadOnStaleBuild(target, storage, () => clock);
  const fire = () => { let prevented = false; listeners["vite:preloadError"]({ preventDefault: () => { prevented = true; } }); return prevented; };
  return { fire, reloads: () => reloads, advance: (ms) => { clock += ms; } };
}

test("a chunk of an older build reloads the page once to get the current build", () => {
  const p = page(100_000);
  assert.equal(p.fire(), true);
  assert.equal(p.reloads(), 1);
});

test("a second chunk failure right after the reload surfaces as an error instead of looping", () => {
  const p = page(100_000);
  p.fire();
  p.advance(2_000);
  assert.equal(p.fire(), false);
  assert.equal(p.reloads(), 1);
  p.advance(20_000);
  assert.equal(p.fire(), true);
  assert.equal(p.reloads(), 2);
});
