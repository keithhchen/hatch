import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { factoryAgentTools } from "../factoryAgents/factoryTools.js";
import { WorkbenchStore } from "../factoryAgents/store.js";
import { ACCOUNT, formsHarness, schema } from "./formKit.js";
import { formTools } from "./tools.js";

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
    const reference = await run(tools, "form_reference", {});
    assert.deepEqual(Object.keys(reference), ["index.html", "app.js", "base.css"]);
    assert.match(reference["app.js"], /hatch\.save/);
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
    assert.deepEqual((await names("voice")).filter(name => name.endsWith("form") || name === "form_reference").sort(), ["form_reference", "publish_form", "read_form"]);
    assert.deepEqual((await names("research")).filter(name => name.endsWith("form") || name === "form_reference"), []);
  } finally { await h.close(); await rm(root, { recursive: true, force: true }); }
});
