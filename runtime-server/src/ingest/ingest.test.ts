import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { HostedIngest } from "../hostedAgents/ingest.js";
import { MemoryBrowserProfiles } from "../hostedAgents/browserProfiles.js";
import type { HostedAgentProvider, HostedTask } from "../hostedAgents/ports.js";
import { HostedEngine, PlainTextEngine, RoutingEngine, UnavailableEngine } from "./engines.js";
import { stagedUploads } from "./boot.js";
import { fail, finish, interrupt, queuedJob, start, publicJob } from "./job.js";
import { IdempotencyKeyReused } from "../idempotency.js";
import { MemoryIngestJobs } from "./jobs.js";
import { mediaTypeOf, safeName } from "./names.js";
import type { IngestEngine, Result, Source, StagedUploads } from "./ports.js";
import { IngestService, MAX_FILE_BYTES, type InBackground } from "./service.js";
import type { ArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { ProductWorkspaceSink, placeManual, type ManualFiles } from "./sink.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const STRANGER = "88888888-8888-4888-8888-888888888888";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const PREFIX = (account: string, product: string) => `creator-products/${account}/${product}`;
let uploads = 0;
/** What a browser did: a file sitting in its upload slot. Returns the submit item and the engine's source for it. */
const stage = async (objects: ArtifactObjectStore, name: string, content: string | Buffer, media_type?: string, account = ACCOUNT) => {
  const bytes = Buffer.from(content);
  const upload_id = `00000000-0000-4000-8000-${String(++uploads).padStart(12, "0")}`;
  const objectKey = `ingest-uploads/${account}/${PRODUCT}/${upload_id}/${safeName(name)}`;
  await objects.put(objectKey, bytes, { contentType: media_type ?? mediaTypeOf(name) });
  return { item: { upload_id, name, bytes: bytes.length, ...(media_type ? { media_type } : {}) }, source: { id: "i1", kind: "file" as const, name, size: bytes.length, objectKey, ...(media_type ? { mimeType: media_type } : {}) } };
};
const fixedStore = async () => new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "hatch-ingest-")));

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
  const objects = await fixedStore();
  const pending: Promise<void>[] = [];
  const inBackground: InBackground = work => { pending.push(work()); };
  const hosted = options.hosted ?? new UnavailableEngine("Hosted ingest is not configured");
  const service = new IngestService({
    jobs, inBackground, owns: async (account, product) => [ACCOUNT, OTHER].includes(account) && [PRODUCT, "other-product"].includes(product),
    objects,
    engine: new RoutingEngine([new PlainTextEngine(stagedUploads(objects)), hosted]),
    sink: options.sink ?? new ProductWorkspaceSink(async () => manual, objects, PREFIX),
  });
  return { service, jobs, manual, objects, settle: () => Promise.all(pending), stage: (name: string, content: string | Buffer, media_type?: string) => stage(objects, name, content, media_type).then(({ item }) => item) };
}

// ---- domain ----

test("A job moves queued, running, then done; illegal moves throw", () => {
  const queued = queuedJob("j", ACCOUNT, PRODUCT, [{ url: "https://a.test/" }, { name: "n.md", bytes: 3, sha256: "h" }], "", "t0");
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
  const objects = await fixedStore();
  const file = async (id: string, name: string, text: string, mime?: string): Promise<Source> => ({ ...(await stage(objects, name, text, mime)).source, id });
  const sources: Source[] = [
    await file("i1", "a.md", "# a"),
    { id: "i2", kind: "link", url: "https://x.test/p" },
    await file("i3", "b.pdf", "%PDF"),
    await file("i4", "c", "t", "text/plain"),
  ];
  const results = await new RoutingEngine([new PlainTextEngine(stagedUploads(objects)), hosted]).ingest(ACCOUNT, sources, "");
  assert.deepEqual(batches, [["i2", "i3"]]);
  assert.equal(results.find(r => r.id === "i1")!.markdown, "# a");
  assert.equal(results.find(r => r.id === "i4")!.markdown, "t");
});

test("An engine that throws fails only its own items", async () => {
  const broken: IngestEngine = { accepts: () => true, ingest: async () => { throw new Error("sandbox down"); } };
  const objects = await fixedStore();
  const results = await new RoutingEngine([new PlainTextEngine(stagedUploads(objects)), broken]).ingest(ACCOUNT, [
    (await stage(objects, "a.md", "a")).source,
    { id: "i2", kind: "link", url: "https://x.test/" },
  ], "");
  assert.deepEqual(results.map(r => [r.id, r.status, r.error]), [["i1", "ok", undefined], ["i2", "failed", "sandbox down"]]);
});

const FAKE_STAGED: StagedUploads = { read: async () => Buffer.alloc(0), downloadUrl: async key => `https://oss.test/${key}?signature=x` };

test("HostedEngine gives the sandbox a download link, never the bytes, for an uploaded file", async () => {
  const { provider, tasks } = fakeHosted(() => ({ items: [{ id: "i1", status: "failed", error: "x" }] }));
  const sha256 = "a".repeat(64);
  await new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles()), FAKE_STAGED).ingest(ACCOUNT,
    [{ id: "i1", kind: "file", name: "talk.mp4", size: 48_800_000, sha256, mimeType: "video/mp4", objectKey: "p/ingest-uploads/u/talk.mp4" }], "");
  const manifest = JSON.parse(tasks[0]!.files.find(file => file.name === "task.json")!.bytes.toString());
  assert.deepEqual(manifest.items, [{ id: "i1", kind: "file", name: "talk.mp4", bytes: 48_800_000, sha256, download_url: "https://oss.test/p/ingest-uploads/u/talk.mp4?signature=x" }]);
  assert.deepEqual(tasks[0]!.files.map(file => file.name).sort(), ["browser-profiles.json", "task.json"], "no original is uploaded to the provider");
});

test("HostedEngine maps the hosted outcome onto results", async () => {
  const { provider, tasks } = fakeHosted(() => ({ items: [{ id: "i1", status: "ok", original: "page.html", markdown: "page.md" }, { id: "i2", status: "failed", error: "login wall" }], files: { "page.html": "<p>x</p>", "page.md": "# x" } }));
  const engine = new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles()), FAKE_STAGED);
  const results = await engine.ingest(ACCOUNT, [{ id: "i1", kind: "link", url: "https://x.test/a" }, { id: "i2", kind: "link", url: "https://y.test/b" }], "ctx");
  assert.equal(tasks.length, 1);
  assert.deepEqual(results.map(r => [r.id, r.status, r.markdown, r.original?.name, r.error]), [["i1", "ok", "# x", "page.html", undefined], ["i2", "failed", undefined, undefined, "login wall"]]);
  assert.equal(results[0]!.original!.mediaType, "text/html");
  assert.deepEqual(results.map(r => r.session), [{ provider: "kimi_hosted_agents", id: "sesn_1" }, { provider: "kimi_hosted_agents", id: "sesn_1" }]);
});

test("A hosted run that produced no result.json still reports its session", async () => {
  const provider: HostedAgentProvider = { run: async () => ({ sessionId: "sesn_9", status: "failed", text: "", artifacts: [], error: "sandbox died" }) };
  const results = await new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles()), FAKE_STAGED).ingest(ACCOUNT, [{ id: "i1", kind: "link", url: "https://x.test/" }], "");
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
  const { service, manual, objects, settle, stage } = await harness();
  const job = await service.submit(ACCOUNT, PRODUCT, [await stage("My Notes.md", "# hi", "text/markdown")]);
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
  const { service, stage, objects } = await harness();
  const rejects = (items: unknown, status: number, pattern: RegExp, context?: unknown) =>
    assert.rejects(service.submit(ACCOUNT, PRODUCT, items, context), (error: any) => error.status === status && pattern.test(error.message));
  await rejects(undefined, 400, /non-empty/);
  await rejects([], 400, /non-empty/);
  await rejects(Array.from({ length: 51 }, () => ({ url: "https://a.test/" })), 400, /At most 50/);
  await rejects([{ url: "ftp://a.test/x" }], 400, /http and https/);
  await rejects([{ url: "javascript:alert(1)" }], 400, /http and https/);
  await rejects([{ url: "not a url" }], 400, /not a valid url/);
  const good = await stage("a.txt", "alpha");
  await rejects([{ ...good, name: "///" }], 400, /needs a name/);
  await rejects([{ ...good, bytes: 0 }], 400, /above zero/);
  await rejects([{ ...good, bytes: "5" }], 400, /above zero/);
  await rejects([{ ...good, sha256: "xyz" }], 400, /sha256/);
  await rejects([{ ...good, upload_id: "../../x" }], 400, /upload_id/);
  await rejects([{}], 400, /url, or an upload_id/);
  await rejects(["x"], 400, /object/);
  await rejects([{ url: "https://a.test/" }], 400, /context/, 5);
  await assert.rejects(service.submit(ACCOUNT, PRODUCT, [{ url: "https://a.test/" }, { ...good, name: "huge.bin", bytes: MAX_FILE_BYTES + 1 }]),
    (error: any) => error.status === 413 && error.code === "file_too_large" && /huge\.bin/.test(error.message));
  assert.equal((await service.recent(ACCOUNT, PRODUCT)).length, 0, "no job was created");
  assert.equal((await service.submit(ACCOUNT, PRODUCT, [{ ...good, bytes: 5 }])).items.length, 1, "a file within the limit is accepted");
  void objects;
});

test("Submit verifies the upload: it exists, its size and type are what was declared, and it belongs to this Product", async () => {
  const { service, stage, objects } = await harness();
  const refused = (items: unknown, status: number, code: string) => assert.rejects(service.submit(ACCOUNT, PRODUCT, items), (error: any) => error.status === status && error.code === code, code);
  const good = await stage("clip.mp4", "0123456789", "video/mp4");
  await refused([{ ...good, upload_id: "11111111-1111-4111-8111-111111111111" }], 409, "upload_not_found");
  await refused([{ ...good, name: "other.mp4" }], 409, "upload_not_found");
  await refused([{ ...good, bytes: 11 }], 422, "upload_size_mismatch");
  await refused([{ ...good, media_type: "audio/mpeg" }], 422, "upload_type_mismatch");
  assert.equal((await service.submit(ACCOUNT, PRODUCT, [{ ...good, media_type: "VIDEO/MP4; codecs=x" }])).items.length, 1, "type is compared without parameters or case");
  const theirs = (await stage("x.md", "x")).upload_id;
  assert.equal(await objects.head(`ingest-uploads/${ACCOUNT}/${PRODUCT}/${theirs}/x.md`).then(found => found?.bytes), 1);
  await assert.rejects(service.submit(OTHER, PRODUCT, [{ upload_id: theirs, name: "x.md", bytes: 1 }]), (error: any) => error.code === "upload_not_found", "another account's slot is not found under its own prefix");
});

test("An upload slot is a short-lived signed link under the Product's prefix; the size limit and ownership are checked before issuing", async () => {
  const { service, objects } = await harness();
  const slot = await service.requestUpload(ACCOUNT, PRODUCT, { name: "My Talk.mp4", bytes: 48_800_000, media_type: "video/mp4" });
  assert.equal(slot.method, "PUT");
  assert.deepEqual(slot.headers, { "Content-Type": "video/mp4" });
  assert.match(slot.url, new RegExp(`^/v1/local-objects/ingest-uploads/${ACCOUNT}/${PRODUCT}/${slot.upload_id}/My-Talk\\.mp4\\?`));
  assert.ok(Date.parse(slot.expires_at) > Date.now() && Date.parse(slot.expires_at) <= Date.now() + 15 * 60_000);
  await assert.rejects(service.requestUpload(ACCOUNT, PRODUCT, { name: "huge.bin", bytes: MAX_FILE_BYTES + 1 }), (error: any) => error.status === 413 && error.code === "file_too_large");
  await assert.rejects(service.requestUpload(ACCOUNT, PRODUCT, { name: "a.txt", bytes: 0 }), (error: any) => error.status === 400);
  await assert.rejects(service.requestUpload(STRANGER, PRODUCT, { name: "a.txt", bytes: 1 }), (error: any) => error.status === 404);
  // The link is the authorization: only its own key, type, and expiry are accepted.
  const local = objects as LocalArtifactObjectStore;
  const url = new URL(slot.url, "http://registry.test");
  const key = decodeURIComponent(url.pathname.slice("/v1/local-objects/".length));
  await assert.rejects(local.receive(key, new URLSearchParams(url.search), Buffer.from("x"), "audio/mpeg"), /Content-Type/);
  await assert.rejects(local.receive(`${key}x`, new URLSearchParams(url.search), Buffer.from("x"), "video/mp4"), /invalid or expired/);
  await assert.rejects(local.receive(key, new URLSearchParams({ ...Object.fromEntries(url.searchParams), expires: "1" }), Buffer.from("x"), "video/mp4"), /invalid or expired/);
  await local.receive(key, new URLSearchParams(url.search), Buffer.from("frames"), "video/mp4");
  assert.deepEqual(await objects.head(key), { bytes: 6, contentType: "video/mp4" });
});

test("Submit persists a queued job and returns it before the work runs; completion writes items and status", async () => {
  const { service, jobs, settle, stage } = await harness();
  const job = await service.submit(ACCOUNT, PRODUCT, [{ ...(await stage("a.txt", "alpha")), name: "../a.txt", sha256: createHash("sha256").update("alpha").digest("hex") }], "  about alpha ");
  assert.equal(job.status, "queued");
  assert.equal(job.context, "about alpha");
  assert.deepEqual(job.items[0]!.input, { name: "a.txt", bytes: 5, sha256: createHash("sha256").update("alpha").digest("hex") });
  assert.equal(jobs.jobs.get(job.id)!.status === "done", false, "returned before it finished");
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.equal(done.status, "done");
  assert.equal(done.items[0]!.status, "ok");
  await assert.rejects(service.get(STRANGER, PRODUCT, job.id), (error: any) => error.status === 404 && error.code === "product_not_found", "another account cannot read it");
  assert.equal(await service.get(ACCOUNT, "other-product", job.id), undefined);
  assert.equal((await service.recent(ACCOUNT, PRODUCT)).length, 1);
});

test("Listeners hear a job once it is settled and saved; a listener that fails changes nothing", async () => {
  const { service, settle, stage } = await harness();
  const heard: Array<{ status: string; saved: string | undefined }> = [];
  service.onSettled(async () => { throw new Error("listener down"); });
  service.onSettled(async job => { heard.push({ status: job.status, saved: (await service.get(ACCOUNT, PRODUCT, job.id))?.status }); });
  const job = await service.submit(ACCOUNT, PRODUCT, [await stage("a.txt", "alpha")]);
  await settle();
  assert.deepEqual(heard, [{ status: "done", saved: "done" }]);
  assert.equal((await service.get(ACCOUNT, PRODUCT, job.id))!.status, "done");
});

test("Without the hosted agent, hosted items fail with a clear error while plain text still works", async () => {
  const { service, settle, stage } = await harness();
  const job = await service.submit(ACCOUNT, PRODUCT, [{ url: "https://x.test/a" }, await stage("n.md", "# n")]);
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.equal(done.status, "done");
  assert.deepEqual(done.items.map(item => [item.status, item.error]), [["failed", "Hosted ingest is not configured"], ["ok", undefined]]);
});

test("A hosted run lands its Markdown and original; a sink failure fails only that item", async () => {
  const { provider } = fakeHosted(() => ({ items: [{ id: "i1", status: "ok", original: "r.pdf", markdown: "r.md" }, { id: "i2", status: "partial", markdown: "s.md", error: "no audio" }], files: { "r.pdf": "RE-ENCODED", "r.md": "# r", "s.md": "# s" } }));
  const hosted = new HostedEngine(new HostedIngest(provider, new MemoryBrowserProfiles()), FAKE_STAGED);
  const { service, manual, settle, stage, objects } = await harness({ hosted });
  const job = await service.submit(ACCOUNT, PRODUCT, [await stage("r.pdf", "%PDF"), { url: "https://x.test/video" }]);
  await settle();
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.deepEqual(done.items.map(item => [item.status, item.markdown_path, item.error]), [["ok", "input/manual/r.md", undefined], ["partial", "input/manual/x.test-video.md", "no audio"]]);
  assert.match(done.items[0]!.original_ref!, /\/ingest\/.+\/i1\/r\.pdf$/);
  assert.equal((await objects.get(done.items[0]!.original_ref!)).toString(), "%PDF", "an uploaded file's original is the upload itself, copied in the store, not what the agent returned");
  assert.match(done.items[1]!.original_ref ?? "", /^$/, "a link without an original artifact has none");
  assert.deepEqual(done.items.map(item => item.session?.id), ["sesn_1", "sesn_1"]);
  assert.deepEqual(publicJob(done).items.map(item => item.session?.provider), ["kimi_hosted_agents", "kimi_hosted_agents"]);
  assert.equal(manual.files.size, 2);

  const broken = new ProductWorkspaceSink(async () => { throw new Error("workspace gone"); }, new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "hatch-ingest-"))), () => "p");
  const second = await harness({ sink: broken });
  const failed = await second.service.submit(ACCOUNT, PRODUCT, [await second.stage("a.md", "a")]);
  await second.settle();
  const outcome = (await second.service.get(ACCOUNT, PRODUCT, failed.id))!;
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.items[0]!.error, "workspace gone");
});

test("An engine that crashes outright fails the job with its message", async () => {
  const service = new IngestService({
    jobs: new MemoryIngestJobs(), engine: { accepts: () => true, ingest: async () => { throw new Error("kaput"); } },
    sink: { store: async () => ({}) }, owns: async () => true, inBackground: work => { void work(); },
    objects: await fixedStore(),
  });
  const job = await service.submit(ACCOUNT, PRODUCT, [{ url: "https://x.test/" }]);
  await new Promise(resolve => setImmediate(resolve));
  const done = (await service.get(ACCOUNT, PRODUCT, job.id))!;
  assert.equal(done.status, "failed");
  assert.equal(done.error, "kaput");
});

test("Jobs a dead process left running or queued are marked interrupted on boot; a job still touched is left alone", async () => {
  const { service, jobs } = await harness();
  const old = "2020-01-01T00:00:00.000Z";
  const fresh = new Date().toISOString();
  const input = [{ url: "https://x.test/" }];
  const queued = queuedJob("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ACCOUNT, PRODUCT, input, "", old);
  const running = start(queuedJob("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ACCOUNT, PRODUCT, input, "", old), old);
  const finished = finish(start(queuedJob("cccccccc-cccc-4ccc-8ccc-cccccccccccc", ACCOUNT, PRODUCT, input, "", old), old), new Map([["i1", { status: "ok" as const, markdown_path: "m" }]]), old);
  const live = start(queuedJob("dddddddd-dddd-4ddd-8ddd-dddddddddddd", ACCOUNT, PRODUCT, input, "", old), old);
  for (const job of [queued, running, finished, live]) await jobs.create(job);
  await jobs.touch(live.id, fresh);
  assert.equal(await service.recoverInterrupted(), 2);
  assert.deepEqual([queued, running, finished, live].map(job => jobs.jobs.get(job.id)!.status), ["failed", "failed", "done", "running"]);
  assert.equal(jobs.jobs.get(queued.id)!.error, "interrupted");
});

test("Originals keep the name the user gave, with the stored file's extension", async () => {
  const { originalName } = await import("./sink.js");
  assert.equal(originalName("speech.aiff", "i3.original.m4a"), "speech.m4a");
  assert.equal(originalName("paulgraham.com-greatwork.html", "i2.original.pdf"), "paulgraham.com-greatwork.pdf");
  assert.equal(originalName("讲座 录音.mov", "i1.original.mp4"), "讲座-录音.mp4");
  assert.equal(originalName("notes.md", "notes.md"), "notes.md");
});

test("An Idempotency-Key makes a repeated submit return the first job; a different request under the same key is refused", async () => {
  const { service, jobs, settle, stage } = await harness();
  const items = [{ url: "https://a.test/" }, await stage("a.txt", "alpha")];
  const first = await service.submit(ACCOUNT, PRODUCT, items, "ctx", "key-1");
  const [again, concurrent] = await Promise.all([service.submit(ACCOUNT, PRODUCT, items, "ctx", "key-1"), service.submit(ACCOUNT, PRODUCT, items, "ctx", "key-1")]);
  assert.equal(again.id, first.id);
  assert.equal(concurrent.id, first.id);
  assert.equal(jobs.jobs.size, 1, "one job");
  await assert.rejects(service.submit(ACCOUNT, PRODUCT, items, "other context", "key-1"), IdempotencyKeyReused);
  await assert.rejects(service.submit(ACCOUNT, PRODUCT, [{ url: "https://b.test/" }], "ctx", "key-1"), IdempotencyKeyReused);
  await assert.rejects(service.submit(ACCOUNT, PRODUCT, [items[0]!, { ...items[1]!, sha256: "b".repeat(64) }], "ctx", "key-1"), IdempotencyKeyReused, "same file, different content");
  assert.notEqual((await service.submit(ACCOUNT, PRODUCT, items, "ctx", "key-2")).id, first.id, "another key is another job");
  assert.notEqual((await service.submit(OTHER, PRODUCT, [items[0]!], "ctx", "key-1")).id, first.id, "keys are per account");
  await settle();
  assert.equal(jobs.jobs.size, 3);
});

test("Without an Idempotency-Key every submit is its own job", async () => {
  const { service, jobs } = await harness();
  const items = [{ url: "https://a.test/" }];
  assert.notEqual((await service.submit(ACCOUNT, PRODUCT, items)).id, (await service.submit(ACCOUNT, PRODUCT, items)).id);
  assert.equal(jobs.jobs.size, 2);
});

test("Ingest only makes and reads jobs for a Product the account owns, whoever calls it", async () => {
  const { service } = await harness();
  const refused = (error: any) => error.status === 404 && error.code === "product_not_found";
  await assert.rejects(service.submit(STRANGER, PRODUCT, [{ url: "https://a.test/" }]), refused, "a stranger's Product");
  await assert.rejects(service.submit(ACCOUNT, "33333333-3333-4333-8333-333333333333", [{ url: "https://a.test/" }]), refused, "an unknown Product");
  await assert.rejects(service.recent(STRANGER, PRODUCT), refused);
  await assert.rejects(service.get(STRANGER, PRODUCT, "j"), refused);
  assert.equal((await service.recent(ACCOUNT, PRODUCT)).length, 0, "no job was made for either");
});
