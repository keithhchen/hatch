import assert from "node:assert/strict";
import test from "node:test";
import { createStaleBuildReload, reloadOnStaleBuild } from "./staleBuild.js";

function page(build = "/assets/index-a.js", store = new Map(), broken = false) {
  let reloads = 0; const reports = [];
  const sessionStorage = broken
    ? { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } }
    : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const target = { sessionStorage, location: { reload: () => { reloads++; } }, addEventListener: (_, fn) => { target.fire = fn; } };
  const reload = createStaleBuildReload({ target, build, report: (r) => reports.push(r) });
  reloadOnStaleBuild(target, reload);
  const fire = () => { let prevented = false; target.fire({ preventDefault: () => { prevented = true; } }); return prevented; };
  return { reload, fire, reloads: () => reloads, reports };
}

test("a chunk of an older build reloads the page once to get the current build", () => {
  const p = page();
  assert.equal(p.fire(), true);
  assert.equal(p.reloads(), 1);
  assert.deepEqual(p.reports, [{ build: "/assets/index-a.js", reloading: true }]);
});

test("the same build failing again after its reload surfaces instead of looping", () => {
  const store = new Map();
  page("/assets/index-a.js", store).fire();
  const reloaded = page("/assets/index-a.js", store);
  assert.equal(reloaded.fire(), false);
  assert.equal(reloaded.reloads(), 0);
});

test("a different build in the same tab gets its own reload", () => {
  const store = new Map();
  page("/assets/index-a.js", store).fire();
  const next = page("/assets/index-b.js", store);
  assert.equal(next.fire(), true);
  assert.equal(next.reloads(), 1);
});

test("the preload event and the rejected import for one failure reload once", () => {
  const p = page();
  p.fire();
  assert.equal(p.reload(), true);
  assert.equal(p.reloads(), 1);
});

test("without session storage the failure surfaces rather than risking a reload loop", () => {
  const p = page("/assets/index-a.js", new Map(), true);
  assert.equal(p.fire(), false);
  assert.equal(p.reloads(), 0);
});
