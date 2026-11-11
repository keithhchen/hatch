import assert from "node:assert/strict";
import { test } from "node:test";
import { withPartialOutput } from "./partialOutput.js";

test("every text delta says where it sits in the Run's text", async () => {
  const published: Record<string, unknown>[] = [];
  const saved: string[] = [];
  const partial = withPartialOutput((message) => published.push(message), async (text) => { saved.push(text); });
  partial.publish({ type: "assistant.delta", run_id: "r", delta: { kind: "text", content: "Hello " } });
  partial.publish({ type: "assistant.delta", run_id: "r", delta: { kind: "thinking_delta", content: "hm" } });
  partial.publish({ type: "assistant.delta", run_id: "r", delta: { kind: "text", content: "world" } });
  await partial.flush();
  assert.deepEqual(published.map((message) => (message.delta as { offset?: number }).offset), [0, undefined, 6]);
  assert.equal(saved.at(-1), "Hello world");
});
