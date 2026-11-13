import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { factoryAgentTools } from "../factoryAgents/factoryTools.js";
import { WorkbenchStore } from "../factoryAgents/store.js";
import { ACCOUNT, formsHarness, schema } from "./formKit.js";
import { fileTools } from "../factoryAgents/tools.js";
import { REFERENCE_PATH, formTools, provideFormReference } from "./tools.js";

const run = async (tools: ReturnType<typeof formTools>, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await tools.find(tool => tool.name === name)!.execute("c", args as never)).content[0] as { text: string }).text);

test("the interview agent publishes a page, reads it back, and the origin remembers its Assistant task", async () => {
  const h = await formsHarness();
  let taskId: string | undefined = "task-1";
  const tools = formTools(h.forms, { accountId: ACCOUNT, productId: "p1", sessionId: "s1", taskId: async () => taskId });
  try {
    const published = await run(tools, "publish_form", { title: "审阅", html: "<html><head></head><body>x</body></html>", schema: schema("C01") });
    assert.match(published.url, /^https:\/\/hatch\.test\/f\/form_[a-f0-9]{20}\?t=/);
    await h.forms.save(published.form_id, h.tokenOf(published.url), "C01", "好", 0);
    assert.deepEqual(await run(tools, "read_form", { form_id: published.form_id }), { status: "open", answers: { C01: "好" } });
    await h.forms.submit(published.form_id, h.tokenOf(published.url));
    assert.deepEqual(h.submitted[0]!.origin, { productId: "p1", sessionId: "s1", taskId: "task-1" });
    // An invalid schema is the agent's to fix: the call fails with the reason.
    await assert.rejects(() => run(tools, "publish_form", { title: "x", html: "<p>x</p>", schema: schema("C01", "C01") }), /unique/);
    taskId = undefined;
  } finally { await h.close(); }
});

test("only the interview session is granted the form tools, whatever its stored definition lists", async () => {
  const h = await formsHarness();
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-form-tools-"));
  try {
    const store = new WorkbenchStore(root, { creatorId: ACCOUNT, productId: "p1" });
    const extraTools = formTools(h.forms, { accountId: ACCOUNT, productId: "p1", sessionId: "s1", taskId: async () => undefined });
    const names = async (role: string) => (await factoryAgentTools({ store, id: "s1", definition: { role, tools: ["update_todo"] }, signal: new AbortController().signal, changed: () => undefined, extraTools })).map(tool => tool.name);
    assert.deepEqual((await names("voice")).filter(name => name.endsWith("_form")).sort(), ["publish_form", "read_form"]);
    assert.deepEqual((await names("research")).filter(name => name.endsWith("_form")), []);
  } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
});

test("the voice session's read tool opens the reference page at the path publish_form names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-form-reference-"));
  try {
    const store = new WorkbenchStore(root, { creatorId: ACCOUNT, productId: "p1" });
    const { id } = await store.create("voice");
    await provideFormReference(store, id);
    await provideFormReference(store, id);
    const read = fileTools(store, id).find(tool => tool.name === "read")!;
    const out = JSON.parse(((await read.execute("c", { path: REFERENCE_PATH, limit: 24000 } as never)).content[0] as { text: string }).text);
    assert.equal(out.representation, "original_text");
    assert.match(out.content, /<!doctype html>/);
    assert.match(out.content, /hatch\.save/);
    assert.ok(!/<style[\s>]/.test(out.content.replace(/<!--[\s\S]*?-->/g, "")), "the reference carries no CSS of its own");
    const tools = formTools(await (await formsHarness()).forms, { accountId: ACCOUNT, productId: "p1", sessionId: id, taskId: async () => undefined });
    assert.ok(tools.find(tool => tool.name === "publish_form")!.description.includes(REFERENCE_PATH));
  } finally { await rm(root, { recursive: true, force: true }); }
});
