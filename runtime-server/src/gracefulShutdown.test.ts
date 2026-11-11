import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { InflightResponses, gracefulShutdown } from "./gracefulShutdown.js";

const recorder = (overrides: Partial<Parameters<typeof gracefulShutdown>[0]> = {}) => {
  const calls: string[] = [];
  const steps = {
    markUnready: () => { calls.push("unready"); },
    stopIntake: async () => { calls.push("intake"); },
    drain: async () => { calls.push("drain"); },
    closeConnections: async () => { calls.push("connections"); },
    closeStorage: async () => { calls.push("storage"); },
    deadlineMs: 1000,
    ...overrides
  };
  return { calls, steps };
};

test("shutdown runs its steps in order", async () => {
  const { calls, steps } = recorder();
  assert.deepEqual(await gracefulShutdown(steps), { drained: true });
  assert.deepEqual(calls, ["unready", "intake", "drain", "connections", "storage"]);
});

test("a drain that outlasts the deadline is cut off and the rest still runs", async () => {
  const { calls, steps } = recorder({ deadlineMs: 20, drain: () => new Promise<void>(() => undefined) });
  assert.deepEqual(await gracefulShutdown(steps), { drained: false });
  assert.deepEqual(calls, ["unready", "intake", "connections", "storage"]);
});

test("a failing step is reported and does not stop the later ones", async () => {
  const errors: string[] = [];
  const { calls, steps } = recorder({
    stopIntake: async () => { throw new Error("boom"); },
    drain: async () => { throw new Error("drain boom"); },
    onError: step => { errors.push(step); }
  });
  await gracefulShutdown(steps);
  assert.deepEqual(errors, ["stopIntake", "drain"]);
  assert.deepEqual(calls, ["unready", "connections", "storage"]);
});

test("the drain waits for work held in flight", async () => {
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const { calls, steps } = recorder({ drain: () => held });
  const done = gracefulShutdown(steps);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ["unready", "intake"]);
  finish();
  await done;
  assert.deepEqual(calls, ["unready", "intake", "connections", "storage"]);
});

test("in-flight requests are waited for, event streams are ended cleanly", async () => {
  const inflight = new InflightResponses();
  let finishSlow!: () => void;
  const slow = new Promise<void>(resolve => { finishSlow = resolve; });
  const server = http.createServer((request, response) => {
    inflight.track(response);
    if (request.url === "/events") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": hi\n\n"); return; }
    void slow.then(() => response.end("done"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const stream = await fetch(`${base}/events`);
    const request = fetch(`${base}/slow`).then(response => response.text());
    await new Promise(resolve => setTimeout(resolve, 50));
    let settled = false;
    const requestsDone = inflight.requestsDone(10).then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false, "the slow request is still open");
    finishSlow();
    assert.equal(await request, "done");
    await requestsDone;
    inflight.endAll();
    const reader = stream.body!.getReader();
    let ended = false;
    while (!ended) ended = (await reader.read()).done;
    assert.equal(ended, true, "the stream ends instead of dropping");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
