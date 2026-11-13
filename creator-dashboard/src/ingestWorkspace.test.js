import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createIngestPort, createJobStore, ingestFile, settleJob } from "./ingestPort.js";

const job = (status, item = {}) => ({ id: "j1", status, items: [{ id: "i1", status: "pending", ...item }] });
const file = { name: "talk.pdf", type: "application/pdf", lastModified: 1 };
const none = () => undefined;

test("every submit carries one Idempotency-Key, reused when the same submission is retried", async () => {
  const headers = [];
  const port = createIngestPort(async (route, options) => { headers.push(options?.headers?.["Idempotency-Key"]); return { job: { id: "j" } }; });
  await port.submit("p", "u1", "k1");
  await port.submit("p", "u1", "k1");
  await port.submit("p", "u1");
  assert.deepEqual(headers.slice(0, 2), ["k1", "k1"]);
  assert.match(headers[2], /^[0-9a-f-]{36}$/);
  const keys = [];
  const send = { upload: async () => "u", submit: async (_, __, key) => { keys.push(key); return job("done", { status: "ok" }); } };
  await ingestFile(send, "p", file, none);
  await ingestFile(send, "p", file, none, { key: "again" });
  assert.match(keys[0], /^[0-9a-f-]{36}$/);
  assert.equal(keys[1], "again");
});

test("in-flight job ids are stored per product, resumed until they settle, and cleared", async () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = createJobStore("p1", storage);
  const jobs = [];
  await ingestFile({ upload: async () => "u", submit: async () => job("queued"), get: async () => job("done", { status: "ok" }) }, "p1", file, none, { wait: async () => undefined, onJob: j => { store.add(j.id, file.name); jobs.push(...store.list()); } });
  assert.deepEqual(jobs, [{ jobId: "j1", name: "talk.pdf" }]);
  assert.deepEqual(createJobStore("p2", storage).list(), []);
  const resumed = [];
  await settleJob({ get: async () => job("done", { status: "failed", error: "boom" }) }, "p1", job("running"), state => resumed.push(state), { wait: async () => undefined });
  assert.deepEqual(resumed, [{ status: "ingesting" }, { status: "failed", error: "boom" }]);
  store.remove("j1");
  assert.deepEqual(createJobStore("p1", storage).list(), []);
});

test("blocked sessionStorage only costs the resume", () => {
  const blocked = () => { throw new Error("blocked"); };
  const store = createJobStore("p1", { getItem: blocked, setItem: blocked });
  store.add("x", "a");
  store.remove("x");
  assert.deepEqual(store.list(), []);
});

test("the workspace Add files opens the Upload page; only the Upload page ingests", async () => {
  const source = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(\) => onOpenAgent\("uploads"\)\}>\{t\("addFiles"\)\}/);
  assert.doesNotMatch(source, /uploads\.add|uploads\.items|uploads\.ingestedAt|ingestedAt/);
  assert.doesNotMatch(source, /<Workspace[^>]*uploads=/);
  assert.match(source, /tooLarge\(file\)/);
  assert.match(source, /jobs\.list\(\)/);
});
