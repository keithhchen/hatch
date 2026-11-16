import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingAnalytics } from "../analytics/recording.js";
import { FlatAttachmentFiles } from "../assets/flatFiles.js";
import { harness, scopeA } from "../assets/kit.test.js";
import { ChatRuntime } from "../chat/chatRuntime.js";
import type { ConversationRecord } from "../conversationRepository.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { clientMessageInputDigest } from "../protocol.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { InMemoryArtifactConfigRepository } from "./config.js";
import { ArtifactMode } from "./mode.js";
import { ARTIFACT_RETRY_MESSAGE } from "./prompt.js";
import { ArtifactRetrier } from "./retrier.js";
import { InMemoryReportRepository } from "./repositories.js";
import type { ReportRenderer } from "./ports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const binding = { ownerAccountId: "buyer", creatorId: "creator", agentId: "p1", productId: "p1", corpusDigest: "corpus" };
const PDF = Buffer.from("%PDF-1.7 ok");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("data")]);
const html = `<!doctype html><html><head><style>p{}</style></head><body><section data-access="free"><h2>A</h2><p>a</p></section><section data-access="paid"><h2>B</h2><p>SECRET</p></section></body></html>`;

type Behavior = "fail" | "complete" | "slow-publish";

/** The real Chat runtime over in-memory storage and a scripted agent; nothing is attached to its events. */
async function world(script: Behavior[]) {
  const kit = await harness();
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  const reports = new InMemoryReportRepository();
  const clock = { now: new Date("2026-01-01T00:00:00Z") };
  const analytics = new RecordingAnalytics();
  const renderer: ReportRenderer = { render: async () => ({ fullPdf: PDF, freePdf: PDF, preview: PNG }) };
  const artifact = new ArtifactMode({ configs: new InMemoryArtifactConfigRepository(), reports, renderer, blobs: kit.blobs, assets: { uploadedCount: async () => 0 }, analytics, clock: () => clock.now,
    publishing: { sleep: async () => undefined, pausesMs: [0, 0] } });
  const runs: string[] = [];
  const chat = new ChatRuntime<object>({
    repository, store, scopes: { resolve: async () => ({}) }, admission: { reserve: () => () => undefined }, toolTimeoutMs: 1000,
    compactionStrategy: (() => { throw new Error("not used"); }) as never, artifacts: artifact.lifecycle,
    runner: { async run(turn) {
      runs.push(turn.run.id);
      await turn.state.start().catch(() => undefined);
      const behavior = script.shift() ?? "fail";
      if (behavior === "fail") return turn.state.fail({ code: "model_error", message: "model down" });
      if (behavior === "slow-publish") {
        await sleep(30);
        const report = (await reports.get(turn.conversation.id))!;
        await reports.ready(turn.conversation.id, report.attempt, { fullHtml: "a", freeHtml: "b", fullPdf: "c", freePdf: "d", preview: "e" }, clock.now);
      }
      await turn.state.complete({ message: { role: "assistant", content: "done" }, finishReason: "stop", visibleParts: [] });
    } }
  });
  await chat.start();
  const id = "conversation:x:conv_1";
  const { conversation } = await repository.createConversation({ ...binding, id, publicId: "conv_1" });
  await reports.create({ conversationId: id, productId: "p1", ownerAccountId: "buyer" });
  const submit = (conv: ConversationRecord, clientMessageId: string, runId: string, content: string) => chat.service.submit({
    principal: { kind: "account", accountId: "buyer" } as never, conversation: conv, scope: {}, client: { client: "web" }, clientMessageId,
    message: async () => ({ role: "user", content }), digest: clientMessageInputDigest({ content }), runId, corpusDigest: "corpus", requiresLocalTools: false, mode: "start_only"
  });
  const retrier = new ArtifactRetrier({ reports, lifecycle: artifact.lifecycle, clock: () => clock.now,
    start: async (record, runId) => { await submit((await repository.getConversation(record.conversationId))!, `artifact-retry-${runId}`, runId, ARTIFACT_RETRY_MESSAGE); } });
  const settled = async (n: number) => { for (let i = 0; i < 200; i++) { const all = await repository.listRuns(id); if (all.length >= n && all.every((r) => ["completed", "failed", "cancelled", "interrupted"].includes(r.status))) return all; await sleep(10); } throw new Error("runs did not end"); };
  return { repository, reports, clock, analytics, chat, conversation, id, submit, retrier, runs, settled, artifact, kit };
}

test("the first message starts one Run even when it is sent twice; the report follows it", async () => {
  const w = await world(["fail"]);
  const [a, b] = await Promise.all([w.submit(w.conversation, "first", "run-a", "the form"), w.submit(w.conversation, "first", "run-b", "the form").catch((error) => error)]);
  assert.equal(a.outcome, "started");
  assert.ok(b instanceof Error || b.outcome === "replayed", "the resent message starts nothing");
  await w.settled(1);
  const again = await w.submit(w.conversation, "first", "run-c", "the form");
  assert.equal(again.outcome, "replayed");
  assert.equal((await w.repository.listRuns(w.id)).length, 1);
  assert.equal(w.runs.length, 1);
  await w.chat.stop();
});

test("a Run that ends without a report is not a failure: the conversation continues 5 s later, up to 5 Runs; only the last end fails it", async () => {
  const w = await world(["fail", "complete", "fail", "complete", "fail"]);
  await w.submit(w.conversation, "first", "run-1", "the form");
  await w.settled(1);
  let report = (await w.reports.get(w.id))!;
  assert.deepEqual([report.status, report.attempt, report.error], ["generating", 1, undefined], "still generating, no error shown");
  assert.equal(report.retryAt, "2026-01-01T00:00:05.000Z");
  assert.equal(await w.retrier.tick(), 0, "not due yet");

  w.clock.now = new Date("2026-01-01T00:00:05Z");
  const [t1, t2] = await Promise.all([w.retrier.tick(), w.retrier.tick()]);
  assert.equal(t1 + t2, 1, "two instances claim one continuation");
  await w.settled(2);
  const second = (await w.reports.get(w.id))!;
  assert.deepEqual([second.status, second.attempt, second.error], ["generating", 2, undefined]);
  await w.artifact.lifecycle.runEnded({ id: "run-1" }, { status: "failed", failure: { code: "x", message: "late" } } as never);
  assert.equal((await w.reports.get(w.id))?.retryAt, second.retryAt, "an older Run's end changes nothing");

  for (const [n, at] of [[3, "00:00:10"], [4, "00:00:15"], [5, "00:00:20"]] as const) {
    w.clock.now = new Date(`2026-01-01T${at}Z`);
    assert.equal(await w.retrier.tick(), 1, `Run ${n} continues the conversation`);
    await w.settled(n);
  }
  report = (await w.reports.get(w.id))!;
  assert.deepEqual([report.status, report.stage, report.attempt, report.error, report.retryAt], ["failed", "failed", 5, "model down", undefined]);
  assert.equal(w.analytics.names().filter((n) => n === "report_failed").length, 1);
  w.clock.now = new Date("2026-01-01T01:00:00Z");
  assert.equal(await w.retrier.tick(), 0, "nothing more to start");
  assert.equal(w.runs.length, 5);
  await w.chat.stop();
});

test("a claim is a compare-and-set on the attempt", async () => {
  const w = await world([]);
  await w.reports.begin(w.id, "r1", w.clock.now);
  await w.reports.runEnded("r1", "boom", w.clock.now);
  w.clock.now = new Date("2026-01-01T00:01:00Z");
  assert.equal((await w.reports.claim(w.id, 1, "r2", w.clock.now, 1000))?.attempt, 2);
  assert.equal(await w.reports.claim(w.id, 1, "r3", w.clock.now, 1000), undefined);
  assert.equal((await w.reports.get(w.id))?.runId, "r2");
  // the publish of the older attempt is refused
  assert.equal(await w.reports.ready(w.id, 1, { fullHtml: "a", freeHtml: "b", fullPdf: "c", freePdf: "d", preview: "e" }, w.clock.now), undefined);
  await w.chat.stop();
});

test("a Run keeps going and publishes with no client connected", async () => {
  const w = await world(["slow-publish"]);
  await w.submit(w.conversation, "first", "run-1", "the form");
  assert.equal((await w.reports.get(w.id))?.status, "generating");
  const [run] = await w.settled(1);
  assert.equal(run!.status, "completed");
  assert.equal((await w.reports.get(w.id))?.status, "ready");
  await w.chat.stop();
});

test("a draft stays a draft until a message; chat conversations have no report", async () => {
  const w = await world([]);
  assert.equal((await w.reports.get(w.id))?.status, "draft");
  assert.equal(await w.reports.get("conversation:x:a-chat-conversation"), undefined);
  assert.equal(await w.reports.runEnded("no-such-run", "x", w.clock.now), undefined);
  await w.chat.stop();
});

test("creating twice with one request key is one conversation and one report; uploads of the same file are one file", async () => {
  const w = await world([]);
  const once = await w.repository.createConversation({ ...binding, id: "conversation:x:conv_k1", publicId: "conv_k1", clientRequestId: "key-1" });
  const twice = await w.repository.createConversation({ ...binding, id: "conversation:x:conv_k2", publicId: "conv_k2", clientRequestId: "key-1" });
  assert.deepEqual([once.created, twice.created, twice.conversation.id], [true, false, once.conversation.id]);
  await w.reports.create({ conversationId: once.conversation.id, productId: "p1", ownerAccountId: "buyer" });
  await w.reports.create({ conversationId: twice.conversation.id, productId: "p1", ownerAccountId: "buyer" });
  assert.equal((await w.reports.list("buyer", "p1")).filter((r) => r.conversationId === once.conversation.id).length, 1);

  const files = new FlatAttachmentFiles(w.kit.repository, w.kit.blobs, { render: async () => { throw new Error("unused"); } });
  const first = await w.kit.pipeline.accept(scopeA, { name: "notes.txt", bytes: Buffer.from("same") });
  const retried = await w.kit.pipeline.accept(scopeA, { name: "notes.txt", bytes: Buffer.from("same") });
  assert.equal(first.id, retried.id);
  assert.equal(await files.count(scopeA), 1);
  assert.ok(!(await files.ls(scopeA)).includes("(2)"));
  await w.kit.pipeline.accept(scopeA, { name: "notes.txt", bytes: Buffer.from("different") });
  assert.match(await files.ls(scopeA), /notes \(2\)\.txt/);
  await w.chat.stop();
});

test("publishing replaces the report as one unit; a failed publish leaves the previous complete set", async () => {
  const w = await world([]);
  const render: { fail?: boolean; bad?: boolean } = {};
  (w.artifact.deps as { renderer: ReportRenderer }).renderer.render = async () => {
    if (render.fail) throw new Error("render down");
    return render.bad ? { fullPdf: Buffer.from("junk"), freePdf: PDF, preview: PNG } : { fullPdf: PDF, freePdf: PDF, preview: PNG };
  };
  await w.reports.begin(w.id, "r1", w.clock.now);
  const publish = () => w.artifact.publisher.publish({ conversation: w.conversation, attempt: 1, html, startedAt: Date.now() });
  assert.equal(await publish(), "Report published.");
  const first = (await w.reports.get(w.id))!;
  const blobs = w.artifact.blobs;
  for (const key of Object.values(first.keys!)) assert.ok((await blobs.get(key)).length > 0);

  render.bad = true;
  await assert.rejects(publish(), /invalid full\.pdf/);
  render.bad = false; render.fail = true;
  await assert.rejects(publish(), /render down/);
  assert.deepEqual((await w.reports.get(w.id))?.keys, first.keys, "readers still see the previous complete set");

  render.fail = false;
  assert.equal(await publish(), "Report published.");
  const second = (await w.reports.get(w.id))!;
  assert.notEqual(second.keys!.fullPdf, first.keys!.fullPdf);
  assert.equal(new Set(Object.values(second.keys!).map((k) => k.split("/").slice(0, -1).join("/"))).size, 1, "five files under one fresh prefix");
  assert.ok((await blobs.get(first.keys!.fullPdf)).length > 0, "the old set may stay");
  assert.equal(second.status, "ready");
  await w.chat.stop();
});

test("progress follows the Run's own tool calls: stages, safe details, the last twenty steps", async () => {
  const w = await world([]);
  (w.artifact.deps.configs as InMemoryArtifactConfigRepository).set("p1", { fields: [{ id: "a", label: "A", type: "text" }] }, "T");
  await w.reports.begin(w.id, "r1", w.clock.now);
  const turn = (await w.artifact.turnFor(w.conversation, { createdAt: w.clock.now.toISOString() }))!;
  turn.onTool("attachments.read", { path: "/attachments/a.pdf" });
  turn.onTool("creator.nas_search", { query: "private" });
  turn.onTool("hatch.web_search", { query: "a child's name" });
  turn.onTool("some.other", {});
  turn.onTool("artifact.publish_report", { html: "SECRET" });
  await sleep(10);
  assert.deepEqual((await w.reports.get(w.id))!.steps.map((s) => [s.stage, s.detail]), [["reading", "read /attachments/a.pdf"], ["consulting", "creator.nas_search"], ["researching", "web_search"], ["rendering", "publish_report"]]);
  assert.ok(!JSON.stringify((await w.reports.get(w.id))!.steps).includes("child"));
  for (let i = 0; i < 30; i++) turn.onTool("attachments.ls", { path: `/attachments/${i}` });
  await sleep(20);
  const steps = (await w.reports.get(w.id))!.steps;
  assert.equal(steps.length, 20);
  assert.equal(steps.at(-1)?.detail, "ls /attachments/29");
  await w.chat.stop();
});
