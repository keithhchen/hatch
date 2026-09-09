import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { fileTools } from "./tools.js";
import { WorkbenchStore } from "./store.js";
import { WorkbenchRuntime } from "./runtime.js";
import { createWorkbenchServer } from "./server.js";

test("Voice is a first-class isolated workspace with its canonical Markdown output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-voice-workspace-"));
  try {
    const store = new WorkbenchStore(root);
    const voice = await store.create("voice");
    assert.equal(voice.role, "voice");
    assert.equal(voice.files[0]?.path, "output/CREATOR_PERSONA.md");
    assert.equal((await store.read(voice.id, "output/CREATOR_PERSONA.md")).bytes.toString(), "# CREATOR_PERSONA\n\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workspaces isolate files, overwrite ordinary files and retain exact expert comment anchors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-workspace-unit-"));
  try {
    const store = new WorkbenchStore(root);
    const a = await store.create("research"); const b = await store.create("evaluator");
    const original = await store.put(a.id, "input/brief.md", Buffer.from("客户原文\n"), { actor: "user" });
    await assert.rejects(store.read(b.id, original.path), /not found/);
    await assert.rejects(store.put(a.id, "input/brief.md", Buffer.from("Agent 修改"), { actor: "agent" }), /only write output/);
    await assert.rejects(store.put(a.id, "output/../escape.md", Buffer.from("escape"), { actor: "agent" }), /Invalid/);
    const first = await store.put(a.id, "output/RESEARCH.md", Buffer.from("# 第一版\n保留判断依据。\n"), { actor: "agent" });
    await store.put(a.id, first.path, Buffer.from("# 第二版\n已修改。\n"), { actor: "user" });
    await store.comment(a.id, { path: first.path, start: 0, end: 5, quote: "# 第二版", text: "请补充判断依据的来源。" });
    assert.equal((await store.read(a.id, first.path)).bytes.toString(), "# 第二版\n已修改。\n");
    await assert.rejects(store.comment(a.id, { path: first.path, start: 0, end: 5, quote: "# 第一版", text: "wrong text" }), /selected text/);
    await store.put(b.id, "output/RESULT.md", Buffer.from("真实结果的测试样本"), { actor: "host", readonly: true });
    await assert.rejects(store.put(b.id, "output/RESULT.md", Buffer.from("altered"), { actor: "agent" }), /immutable/);
    await store.update(a.id, s => { s.status = "running"; });
    await assert.rejects(store.removeInput(a.id, original.path), /idle input/);
    await assert.rejects(store.put(a.id, first.path, Buffer.from("用户编辑"), { actor: "user" }), /停止运行/);
    assert.equal((await store.read(a.id, first.path)).bytes.toString(), "# 第二版\n已修改。\n");
    await store.put(a.id, first.path, Buffer.from("Agent 完成"), { actor: "agent" });
    await store.recover();
    assert.equal((await store.get(a.id)).status, "interrupted");
    await store.put(a.id, first.path, Buffer.from("用户编辑"), { actor: "user" });
    assert.equal((await store.read(a.id, first.path)).bytes.toString(), "用户编辑");
    assert.equal((await store.get(b.id)).status, "idle");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("result comments follow the displayed original across new runs and downloaded assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-result-comment-unit-"));
  try {
    const store = new WorkbenchStore(root);
    const s = await store.create("evaluator");
    const first = "output/results/first.md";
    const asset = "output/results/asset-document.md";
    await store.put(s.id, first, Buffer.from("First result"), { actor: "host", readonly: true });
    await store.put(s.id, "output/RESULT.md", Buffer.from("First result"), { actor: "host", readonly: true, origin: { sessionId: s.id, path: first } });
    await store.update(s.id, state => { state.hatch = { conversationId: "test-conversation", lastRunId: "next", pending: true }; });
    await store.comment(s.id, { path: "output/RESULT.md", start: 0, end: 5, quote: "First", text: "Review the displayed response" });
    await store.put(s.id, asset, Buffer.from("Actual asset"), { actor: "host", readonly: true });
    await store.put(s.id, "output/RESULT.md", Buffer.from("Actual asset"), { actor: "host", readonly: true, origin: { sessionId: s.id, path: asset } });
    await store.comment(s.id, { path: "output/RESULT.md", start: 0, end: 6, quote: "Actual", text: "Review the downloaded asset" });
    const reopened = await new WorkbenchStore(root).get(s.id);
    assert.deepEqual(reopened.comments.map(c => [c.path, c.quote]), [[first, "First"], [asset, "Actual"]]);
    // Historical responses without origin metadata still resolve to the saved run.
    await store.update(s.id, state => { state.hatch!.lastRunId = "first"; });
    await store.put(s.id, "output/RESULT.md", Buffer.from("First result"), { actor: "host", readonly: true });
    assert.equal((await store.comment(s.id, { path: "output/RESULT.md", start: 0, end: 5, quote: "First", text: "Historical review" })).path, first);
    await store.put(s.id, "output/RESULT.md", Buffer.from("Different asset"), { actor: "host", readonly: true });
    await assert.rejects(store.comment(s.id, { path: "output/RESULT.md", start: 0, end: 9, quote: "Different", text: "Do not attach to another result" }), /Result changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one Pi Agent per chat reports progress without a shadow; histories and writes remain separate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-progress-unit-"));
  const store = new WorkbenchStore(root);
  let instances = 0;
  const runtime = new WorkbenchRuntime(store, { env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash" }, agentFactory: options => {
    assert.equal(options.env?.HATCH_FACTORY_LLM_PROFILE, "deepseek-v4-flash");
    const index = ++instances; let step = 0;
    return new Agent({ ...options.agentOptions, initialState: { ...options.initialState, model: createFactoryLlmModel({ env: options.env }) }, streamFn: () => {
      const actions = [
        { name: "list", arguments: { directory: "input" } },
        { name: "read", arguments: { path: "input/brief.md" } },
        { name: "write", arguments: { path: "output/CHECK.md", content: `# Automated unit test ${index}\n` } },
        { name: "report_progress", arguments: { percentage: index * 20 } },
      ];
      const action = actions[step++];
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(),
        content: action ? [{ type: "toolCall", id: `call-${index}-${step}`, ...action }] : [{ type: "text", text: `Done ${index}` }],
        stopReason: action ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: action ? "toolUse" : "stop", message }); stream.end(message); return stream;
    } });
  } });
  try {
    const a = await store.create("generation"); const b = await store.create("case-generation");
    await store.put(a.id, "input/brief.md", Buffer.from("Session A evidence"), { actor: "user" });
    await store.put(b.id, "input/brief.md", Buffer.from("Session B evidence"), { actor: "user" });
    const wait = (id: string) => new Promise<void>(resolve => { const listener = async (event: { sessionId: string; type: string }) => { if (event.sessionId === id && event.type === "state" && (await store.get(id)).status !== "running") { runtime.events.off("event", listener); resolve(); } }; runtime.events.on("event", listener); });
    const doneA = wait(a.id); const doneB = wait(b.id);
    await runtime.start(a.id, "First isolated task"); await runtime.start(b.id, "Second isolated task");
    await Promise.all([doneA, doneB]);
    assert.equal(instances, 2);
    const sa = await store.get(a.id); const sb = await store.get(b.id);
    assert.equal(sa.status, "completed"); assert.equal(sb.status, "completed");
    assert.deepEqual([sa.progress.percentage, sb.progress.percentage].sort(), [20, 40]);
    assert.equal(sa.progress.status, "ready"); assert.equal(sa.progress.turn, 1);
    assert.ok(JSON.stringify(sa.messages).includes("Session A evidence"));
    assert.ok(!JSON.stringify(sa.messages).includes("Session B evidence"));
    const old = sa.files.find(f => f.path === "output/CHECK.md")!;
    await store.put(a.id, old.path, Buffer.from("User changed requirements"), { actor: "user" });
    assert.equal((await store.get(a.id)).progress.status, "unscored");
    assert.equal((await store.get(b.id)).progress.status, "ready");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("manual transfer copies selected current file bytes, never another Agent's history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-transfer-test-"));
  const app = await createWorkbenchServer({ root, env: {} });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const a = await app.store.create("research"); const b = await app.store.create("generation");
    const file = await app.store.put(a.id, "output/RESEARCH.md", Buffer.from("# Selected version\n"), { actor: "agent" });
    await app.store.update(a.id, s => { s.messages.push({ role: "user", content: "Private conversation", timestamp: Date.now() }); });
    const address = app.server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/api/sessions/${b.id}/transfer`;
    const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromSessionId: a.id, files: [{ path: file.path }] }) });
    assert.equal((await send()).status, 200);
    const received = await app.store.read(b.id, "input/RESEARCH.md");
    assert.equal(received.bytes.toString(), "# Selected version\n"); assert.equal(received.record.origin?.sessionId, a.id);
    assert.equal((await app.store.get(b.id)).messages.length, 0);
    await app.store.put(a.id, file.path, Buffer.from("Updated source"), { actor: "agent" });
    assert.equal((await send()).status, 200);
    assert.equal((await app.store.read(b.id, "input/RESEARCH.md")).bytes.toString(), "Updated source");
    const cross = await fetch(url, { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: "{}" });
    assert.equal(cross.status, 403);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});


test("write uses ordinary paths and overwrites output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-write-version-test-"));
  try {
    const store = new WorkbenchStore(root); const session = await store.create("case-generation");
    const tools = fileTools(store, session.id);
    const read = tools.find(t => t.name === "read")!; const write = tools.find(t => t.name === "write")!;
    const first = await store.put(session.id, "output/CASE.md", Buffer.from("first"), { actor: "user" });
    await write.execute("replace", { path: first.path, content: "replacement" });
    await read.execute("read", { path: first.path });
    await store.put(session.id, first.path, Buffer.from("user edit"), { actor: "user" });

    assert.equal((await store.read(session.id, first.path)).bytes.toString(), "user edit");
    await read.execute("reread", { path: first.path });
    await write.execute("reconciled", { path: first.path, content: "user and agent edits" });
    assert.equal((await store.read(session.id, first.path)).bytes.toString(), "user and agent edits");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("model readiness follows the selected provider, not the presence of a Kimi key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-model-readiness-"));
  try {
    for (const [env, ready] of [
      [{ HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", DEEPSEEK_API_KEY: "unit-test-key" }, true],
      [{ HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", LLM_API_KEY: "unit-test-key" }, false],
      [{ HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6", LLM_API_KEY: "unit-test-key" }, true],
    ] as const) {
      const app = await createWorkbenchServer({ root, env });
      await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
      try {
        const address = app.server.address(); assert.ok(address && typeof address !== "string");
        const response = await fetch(`http://127.0.0.1:${address.port}/api/config`);
        assert.equal(response.status, 200);
        const config = await response.json() as { services: { model: boolean } };
        assert.equal(config.services.model, ready);
      } finally { await app.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
