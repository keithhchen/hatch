import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { createRuntimeServer } from "../index.js";
import { RuntimeStore, localRuntimeAuthority } from "../store.js";

const scope = new URLSearchParams({
  creator_id: "22222222-2222-4222-8222-222222222222", user_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "33333333-3333-4333-8333-333333333333", product_id: "33333333-3333-4333-8333-333333333333", corpus_digest: `sha256:${"b".repeat(64)}`
}).toString();

const frames = (text: string) => text.split("\n\n").filter(Boolean).map((frame) => {
  const field = (name: string) => frame.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  return { event: field("event")!, data: JSON.parse(field("data")!) as Record<string, any> };
});

test("a replayed send of a finished Run streams its result and ends, instead of waiting for an end that already happened", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-replay-stream-"));
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: new InMemoryConversationRepository(localRuntimeAuthority(dataDir)),
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "the answer" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  await new Promise<void>((resolve) => (runtime.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${((runtime.server as http.Server).address() as { port: number }).port}`;
  try {
    const call = (route: string, init: RequestInit = {}) => fetch(`${base}${route}${route.includes("?") ? "&" : "?"}${scope}`, { signal: AbortSignal.timeout(5_000), ...init });
    const conversation = (await (await call("/v1/conversations", { method: "POST", body: JSON.stringify({ client_request_id: "c1" }) })).json() as any).conversation.id as string;
    const stream = () => call(`/v1/conversations/${conversation}/messages`, { method: "POST", headers: { accept: "text/event-stream" }, body: JSON.stringify({ client_message_id: "m1", content: "hi" }) });
    const first = frames(await (await stream()).text());
    assert.equal(first.find((frame) => frame.event === "message.accepted")!.data.outcome, "started");
    // The same key again, after the Run ended: it must end by itself, with the Run's reply and its end.
    const again = frames(await (await stream()).text());
    assert.equal(again[0]!.data.outcome, "replayed");
    assert.equal(again.filter((frame) => frame.event === "assistant.delta").map((frame) => frame.data.delta.content).join(""), "the answer");
    assert.equal(again.at(-1)!.event, "journal.event");
    assert.deepEqual([again.at(-1)!.data.journal_type, again.at(-1)!.data.payload.status], ["run.state", "completed"]);
  } finally { await runtime.close(); }
});
