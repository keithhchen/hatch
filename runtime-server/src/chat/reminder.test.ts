import assert from "node:assert/strict";
import { test } from "node:test";
import { PiAgentRuntime } from "../piAgentRuntime.js";
import { InMemoryModelRoleResolver } from "../modelRoles.js";
import { alice, dm, ended, text, thread, withFixture } from "./kit.test.js";

const reminders = (value: unknown): number => JSON.stringify(value).split("<system-reminder>").length - 1;

/** A model that only answers: what Chat sends it is what the test inspects. */
const provider = (t: import("node:test").TestContext, requests: Array<Array<{ role: string; content: unknown }>>) => {
  const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "kimi-k3.1-pro", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).messages);
    return new Response(`${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
};

test("a system reminder ends every model call and is never persisted, so it is never in what compaction reads", async (t) => {
  const keep = { key: process.env.LLM_API_KEY };
  process.env.LLM_API_KEY = "test-only";
  t.after(() => {
    for (const [name, value] of [["LLM_API_KEY", keep.key]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const requests: Array<Array<{ role: string; content: unknown }>> = [];
  provider(t, requests);
  await withFixture({ runtime: new PiAgentRuntime({ models: new InMemoryModelRoleResolver(), toolDefinitions: [] }) }, async ({ runtime, repository, store }) => {
    const first = await runtime.chat.send(alice, thread, dm, "evt-1", text("hello"));
    assert.equal((await ended(runtime.chat, first.runId)).status, "completed");
    const second = await runtime.chat.send(alice, thread, dm, "evt-2", text("and again"));
    assert.equal((await ended(runtime.chat, second.runId)).status, "completed");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.filter((message) => reminders(message) > 0).length, 1, "exactly one reminder message, not a copy per turn");
      assert.match(String(request.at(-1)!.content), /^<system-reminder>[\s\S]*client: dm[\s\S]*<\/system-reminder>$/, "at the very end, naming the client");
    }
    // The second call carries the first turn's history, and the history holds no reminder.
    assert.match(JSON.stringify(requests[1]), /hello/);
    assert.equal(reminders(requests[1]!.slice(0, -1)), 0);
    // Nothing the conversation stores, which is all compaction ever reads, holds one.
    assert.equal(reminders(await store.readConversation(first.conversationId)), 0);
    assert.equal(reminders(await repository.snapshot(first.conversationId)), 0);
  });
});
