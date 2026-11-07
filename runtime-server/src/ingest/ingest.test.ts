import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { HostedIngest } from "../hostedAgents/ingest.js";
import { MemoryBrowserProfiles } from "../hostedAgents/browserProfiles.js";
import type { HostedAgentProvider, HostedTask } from "../hostedAgents/ports.js";
import { HostedEngine, PlainTextEngine, RoutingEngine, UnavailableEngine } from "./engines.js";
import { fail, finish, interrupt, queuedJob, start, publicJob } from "./job.js";
import { MemoryIngestJobs } from "./jobs.js";
import { safeName } from "./names.js";
import type { IngestEngine, Result, Source } from "./ports.js";
import { IngestService, MAX_INLINE_BYTES, type InBackground } from "./service.js";
import { ProductWorkspaceSink, placeManual, type ManualFiles } from "./sink.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const b64 = (text: string) => Buffer.from(text).toString("base64");

class MemoryManual implements ManualFiles {
  readonly files = new Map<string, Buffer>();
  async list() { return [...this.files.keys()]; }
  async read(name: string) { return this.files.get(name)!; }
  async write(name: string, bytes: Buffer) { this.files.set(name, bytes); }
}

/** A hosted provider that answers every task with a fixed result.json and files, and records the tasks. */
function fakeHosted(respond: (task: HostedTask) => { items: unknown[]; files?: Record<string, string> }) {
  const tasks: HostedTask[] = [];
  const provider: HostedAgentProvider = {
    run: async task => {
      tasks.push(task);
      const { items, files = {} } = respond(task);
      return {
        sessionId: "sesn_1", status: "done", text: "ok",
        artifacts: [{ name: "result.json", bytes: Buffer.from(JSON.stringify({ items, profiles: [] })) }, ...Object.entries(files).map(([name, text]) => ({ name, bytes: Buffer.from(text) }))],
      };
    },
  };
  return { provider, tasks };
}

async function harness(options: { hosted?: IngestEngine; sink?: ProductWorkspaceSink } = {}) {
  const jobs = new MemoryIngestJobs();
  const manual = new MemoryManual();
  const objects = new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "hatch-ingest-")));
  const pending: Promise<void>[] = [];
  const inBackground: InBackground = work => { pending.push(work()); };
  const hosted = options.hosted ?? new UnavailableEngine("Hosted ingest is not configured");
  const service = new IngestService({
    jobs, inBackground,
    engine: new RoutingEngine([new PlainTextEngine(), hosted]),
    sink: options.sink ?? new ProductWorkspaceSink(async () => manual, objects, (account, product) => `creator-products/${account}/${product}`),
  });
  return { service, jobs, manual, objects, settle: () => Promise.all(pending) };
}

// ---- domain ----

test("A job moves queued, running, then done; illegal moves throw", () => {
  const queued = queuedJob("j", ACCOUNT, PRODUCT, [{ url: "https://a.test/" }, { name: "n.md", bytes: 3 }], "", "t0");
  assert.deepEqual(queued.items.map(item => [item.id, item.status]), [["i1", "pending"], ["i2", "pending"]]);
  assert.throws(() => finish(queued, new Map(), "t1"), /Only a running ingest job can finish/);
  const running = start(queued, "t1");
  assert.equal(running.status, "running");
  assert.throws(() => start(running, "t2"), /running to running/);
  const done = finish(running, new Map([["i1", { status: "ok" as const, markdown_path: "input/manual/a.md" }]]), "t2");
  assert.equal(done.status, "done");
  assert.equal(done.items[1]!.status, "failed", "an item the engine never reported is failed, not silently ok");
  assert.throws(() => fail(done, "x", "t3"), /done to failed/);
});

test("A job fails only when every item failed; failing and interrupting close pending items", () => {
  const running = start(queuedJob("j", ACCOUNT, PRODUCT, [{ url: "https://a.test/" }], "", "t0"), "t1");
  const allFailed = finish(running, new Map([["i1", { status: "failed" as const, error: "boom" }]]), "t2");
  assert.equal(allFailed.status, "failed");
  assert.equal(allFailed.items[0]!.error, "boom");
  const interrupted = interrupt(queuedJob("j", ACCOUNT, PRODUCT, [{ url: "https://a.test/" }], "", "t0"), "t1");
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.error, "interrupted");
  assert.equal(interrupted.items[0]!.error, "interrupted");
  assert.deepEqual(Object.keys(publicJob(interrupted)).sort(), ["created_at", "error", "id", "items", "product_id", "status", "updated_at"]);
});

// ---- names ----

test("Names lose separators and control characters but keep Unicode", () => {
  assert.equal(safeName("../../etc/pass wd.md"), "pass-wd.md");
  assert.equal(safeName("公开资料.md"), "公开资料.md");
  assert.equal(safeName("a:b*c?.txt"), "a-b-c-.txt");
  assert.equal(safeName(".."), "item");
});

// ---- routing ----

test("Plain text never reaches the hosted engine; everything else is one hosted batch", async () => {
  const batches: string[][] = [];
  const hosted: IngestEngine = {
    accepts: () => true,
    ingest: async (_a, sources) => { batches.push(sources.map(s => s.id)); return sources.map(s => ({ id: s.id, status: "ok", markdown: "# hosted" }) as Result); },
  };
  const sources: Source[] = [
    { id: "i1", kind: "file", name: "a.md", bytes: Buffer.from("# a") },
    { id: "i2", kind: "link", url: "https://x.test/p" },
    { id: "i3", kind: "file", name: "b.pdf", bytes: Buffer.from("%PDF") },
    { id: "i4", kind: "file", name: "c", bytes: Buffer.from("t"), mimeType: "text/plain" },
  ];
  const results = await new RoutingEngine([new PlainTextEngine(), hosted]).ingest(ACCOUNT, sources, "");
  assert.deepEqual(batches, [["i2", "i3"]]);
  assert.equal(results.find(r => r.id === "i1")!.markdown, "# a");
  assert.equal(results.find(r => r.id === "i4")!.markdown, "t");
});

test("An engine that throws fails only its own items", async () => {
  const broken: IngestEngine = { accepts: () => true, ingest: async () => { throw new Error("sandbox down"); } };
  const results = await new RoutingEngine([new PlainTextEngine(), broken]).ingest(ACCOUNT, [
    { id: "i1", kind: "file", name: "a.md", bytes: Buffer.from("a") },
    { id: "i2", kind: "link", url: "https://x.test/" },
  ], "");
  assert.deepEqual(results.map(r => [r.id, r.status, r.error]), [["i1", "ok", undefined], ["i2", "failed", "sandbox down"]]);
});

test("HostedEngine maps the hosted outcome onto results", async () => {
  const { provider, tasks } = fakeHosted(() => ({ items: [{ id: "i1", status: "ok", original: "page.html", markdown: "page.md" }, { id: "i2", status: "failed", error: "login wall" }], files: { "page.html": "<p>x</p>", "page.md": "# x" } }));
  const engine = new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles()));
  const results = await engine.ingest(ACCOUNT, [{ id: "i1", kind: "link", url: "https://x.test/a" }, { id: "i2", kind: "link", url: "https://y.test/b" }], "ctx");
  assert.equal(tasks.length, 1);
  assert.deepEqual(results.map(r => [r.id, r.status, r.markdown, r.original?.name, r.error]), [["i1", "ok", "# x", "page.html", undefined], ["i2", "failed", undefined, undefined, "login wall"]]);
  assert.equal(results[0]!.original!.mediaType, "text/html");
  assert.deepEqual(results.map(r => r.session), [{ provider: "kimi_hosted_agents", id: "sesn_1" }, { provider: "kimi_hosted_agents", id: "sesn_1" }]);
});

test("A hosted run that produced no result.json still reports its session", async () => {
  const provider: HostedAgentProvider = { run: async () => ({ sessionId: "sesn_9", status: "failed", text: "", artifacts: [], error: "sandbox died" }) };
  const results = await new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles())).ingest(ACCOUNT, [{ id: "i1", kind: "link", url: "https://x.test/" }], "");
  assert.deepEqual(results.map(r => [r.status, r.error, r.session?.id]), [["failed", "sandbox died", "sesn_9"]]);
});

// ---- sink ----

test("Manual Markdown gets the first free name and never overwrites a different file", async () => {
  const files = new MemoryManual();
  assert.equal(await placeManual(files, "notes", Buffer.from("one")), "input/manual/notes.md");
  assert.equal(await placeManual(files, "notes", Buffer.from("two")), "input/manual/notes-2.md");
  assert.equal(await placeManual(files, "notes", Buffer.from("three")), "input/manual/notes-3.md");
  assert.equal(await placeManual(files, "notes", Buffer.from("two")), "input/manual/notes-2.md", "the same bytes are reused, not duplicated");
  assert.equal(files.files.get("input/manual/notes.md")!.toString(), "one");
  assert.equal(files.files.size, 3);
});

test("The sink writes Markdown to input/manual and the original under the product prefix", async () => {
  const { service, manual, objects, settle } = await harness();
  const job = await service.submit(ACCOUNT, PRODUCT, [{ name: "My Notes.md", content_base64: b64("# hi"), media_type: "text/markdown" }]);
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  const [item] = done.items;
  assert.equal(item!.markdown_path, "input/manual/My-Notes.md");
  assert.equal(manual.files.get("input/manual/My-Notes.md")!.toString(), "# hi");
  assert.equal(item!.original_ref, `creator-products/${ACCOUNT}/${PRODUCT}/ingest/${job.id}/i1/My-Notes.md`);
  assert.equal((await objects.get(item!.original_ref!)).toString(), "# hi");
});

// ---- service ----

test("Submit validates count, size, URLs, names and shape", async () => {
  const { service } = await harness();
  const rejects = (items: unknown, status: number, pattern: RegExp, context?: unknown) =>
    assert.rejects(service.submit(ACCOUNT, PRODUCT, items, context), (error: any) => error.status === status && pattern.test(error.message));
  await rejects(undefined, 400, /non-empty/);
  await rejects([], 400, /non-empty/);
  await rejects(Array.from({ length: 51 }, () => ({ url: "https://a.test/" })), 400, /At most 50/);
  await rejects([{ url: "ftp://a.test/x" }], 400, /http and https/);
  await rejects([{ url: "javascript:alert(1)" }], 400, /http and https/);
  await rejects([{ url: "not a url" }], 400, /not a valid url/);
  await rejects([{ name: "///", content_base64: b64("x") }], 400, /needs a name/);
  await rejects([{ name: "a.txt", content_base64: "***" }], 400, /base64/);
  await rejects([{ name: "a.txt", content_base64: "" }], 400, /empty/);
  await rejects([{}], 400, /url, or a name/);
  await rejects(["x"], 400, /object/);
  await rejects([{ url: "https://a.test/" }], 400, /context/, 5);
  const big = Buffer.alloc(MAX_INLINE_BYTES / 2 + 1).toString("base64");
  await rejects([{ name: "a.bin", content_base64: big }, { name: "b.bin", content_base64: big }], 413, /30 MB/);
});

test("Submit persists a queued job and returns it before the work runs; completion writes items and status", async () => {
  const { service, jobs, settle } = await harness();
  const job = await service.submit(ACCOUNT, PRODUCT, [{ name: "../a.txt", content_base64: b64("alpha") }], "  about alpha ");
  assert.equal(job.status, "queued");
  assert.equal(job.context, "about alpha");
  assert.deepEqual(job.items[0]!.input, { name: "a.txt", bytes: 5 });
  assert.equal(jobs.jobs.get(job.id)!.status === "done", false, "returned before it finished");
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.equal(done.status, "done");
  assert.equal(done.items[0]!.status, "ok");
  assert.equal(await service.get(OTHER, PRODUCT, job.id), undefined, "another account cannot read it");
  assert.equal(await service.get(ACCOUNT, "other-product", job.id), undefined);
  assert.equal((await service.recent(ACCOUNT, PRODUCT)).length, 1);
});

test("Without the hosted agent, hosted items fail with a clear error while plain text still works", async () => {
  const { service, settle } = await harness();
  const job = await service.submit(ACCOUNT, PRODUCT, [{ url: "https://x.test/a" }, { name: "n.md", content_base64: b64("# n") }]);
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.items.map(item => [item.status, item.error]), [["failed", "Hosted ingest is not configured"], ["ok", undefined]]);
});

test("A hosted run lands its Markdown and original; a sink failure fails only that item", async () => {
  const { provider } = fakeHosted(() => ({ items: [{ id: "i1", status: "ok", original: "r.pdf", markdown: "r.md" }, { id: "i2", status: "partial", markdown: "s.md", error: "no audio" }], files: { "r.pdf": "%PDF", "r.md": "# r", "s.md": "# s" } }));
  const hosted = new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles()));
  const { service, manual, settle } = await harness({ hosted });
  const job = await service.submit(ACCOUNT, PRODUCT, [{ name: "r.pdf", content_base64: b64("%PDF") }, { url: "https://x.test/video" }]);
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.deepEqual(done.items.map(item => [item.status, item.markdown_path, item.error]), [["ok", "input/manual/r.md", undefined], ["partial", "input/manual/x.test-video.md", "no audio"]]);
  assert.match(done.items[0]!.original_ref!, /\/ingest\/.+\/i1\/r\.pdf$/);
  assert.deepEqual(done.items.map(item => item.session?.id), ["sesn_1", "sesn_1"]);
  assert.deepEqual(publicJob(done).items.map(item => item.session?.provider), ["kimi_hosted_agents", "kimi_hosted_agents"]);
  assert.equal(manual.files.size, 2);

  const broken = new ProductWorkspaceSink(async () => { throw new Error("workspace gone"); }, new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "hatch-ingest-"))), () => "p");
  const second = await harness({ sink: broken });
  const failed = await second.service.submit(ACCOUNT, PRODUCT, [{ name: "a.md", content_base64: b64("a") }]);
  await second.settle();
  const outcome = (await second.service.get(ACCOUNT, PRODUCT, failed.id))!;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.items[0]!.error, "workspace gone");
});

test("An engine that crashes outright fails the job with its message", async () => {
  const service = new IngestService({
    jobs: new MemoryIngestJobs(), engine: { accepts: () => true, ingest: async () => { throw new Error("kaput"); } },
    sink: { store: async () => ({}) }, inBackground: work => { void work(); },
  });
  const job = await service.submit(ACCOUNT, PRODUCT, [{ url: "https://x.test/" }]);
  await new Promise(resolve => setImmediate(resolve));
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.equal(done.status, "failed");
  assert.equal(done.error, "kaput");
});

test("Jobs a dead process left running or queued are marked interrupted on boot", async () => {
  const { service, jobs } = await harness();
  const queued = queuedJob("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ACCOUNT, PRODUCT, [{ url: "https://x.test/" }], "", "t0");
  const running = start(queuedJob("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ACCOUNT, PRODUCT, [{ url: "https://x.test/" }], "", "t0"), "t1");
  const finished = finish(start(queuedJob("cccccccc-cccc-4ccc-8ccc-cccccccccccc", ACCOUNT, PRODUCT, [{ url: "https://x.test/" }], "", "t0"), "t1"), new Map([["i1", { status: "ok" as const, markdown_path: "m" }]]), "t2");
  for (const job of [queued, running, finished]) await jobs.create(job);
  assert.equal(await service.recoverInterrupted(), 2);
  assert.deepEqual([queued, running, finished].map(job => jobs.jobs.get(job.id)!.status), ["failed", "failed", "done"]);
  assert.equal(jobs.jobs.get(queued.id)!.error, "interrupted");
});

test("Originals keep the name the user gave, with the stored file's extension", async () => {
  const { originalName } = await import("./sink.js");
  assert.equal(originalName("speech.aiff", "i3.original.m4a"), "speech.m4a");
  assert.equal(originalName("paulgraham.com-greatwork.html", "i2.original.pdf"), "paulgraham.com-greatwork.pdf");
  assert.equal(originalName("讲座 录音.mov", "i1.original.mp4"), "讲座-录音.mp4");
  assert.equal(originalName("notes.md", "notes.md"), "notes.md");
});
