import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentCorpus, AgentCorpusResolver } from "../agentCorpus.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { createRuntimeServer, type RuntimeServer } from "../index.js";
import { RuntimeStore, localRuntimeAuthority } from "../store.js";
import type { Connection } from "../surfaces/contract.js";
import { SentMessageLimits } from "./contactBinding.js";
import { principalKey } from "./principal.js";

const productId = "33333333-3333-4333-8333-333333333333";
const creatorId = "22222222-2222-4222-8222-222222222222";
const alice = { kind: "contact" as const, connectionId: "conn-1", contactId: "alice" };
const thread = { kind: "thread" as const, connectionId: "conn-1", threadId: "t1" };
const text = (value: string) => [{ type: "text" as const, text: value }];

async function gatewayFixture(options: { localTools?: boolean; maxMessages?: number } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-chat-gateway-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  const corpus = {
    root: "", digest: `sha256:${"b".repeat(64)}`,
    corpus: {
      agent_id: productId, creator: { id: creatorId, name: "Creator" },
      product: { id: productId, name: "Product", boundaries: [], presentation: {} },
      knowledge: { documents: [] },
      tools: options.localTools ? [{ id: "local", kind: "local_harness" }] : [{ id: "web", kind: "http_function" }]
    } as unknown as AgentCorpus
  };
  const connections = new Map<string, Connection>([["conn-1", {
    id: "conn-1", ownerAccountId: creatorId, channel: "instagram", client: "dm",
    target: { kind: "product", productId }, audience: "public", taskSpecific: false, state: "active"
  }]]);
  const runtime: RuntimeServer = createRuntimeServer({
    conversationStore: store,
    conversationRepository: repository,
    agentCorpusResolver: { resolve: async () => corpus, resolveByProduct: async () => corpus, list: async () => [] } as unknown as AgentCorpusResolver,
    connectionDirectory: { get: async (id) => connections.get(id) },
    ...(options.maxMessages ? { principalLimits: new SentMessageLimits(repository, options.maxMessages) } : {}),
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: `echo: ${input.message.content}` } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  await new Promise<void>((resolve) => (runtime.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  return { runtime, repository };
}

test("the channel layer sends a customer's message and awaits one final reply, with no transport", async () => {
  const { runtime } = await gatewayFixture();
  try {
    const sent = await runtime.chat.send(alice, thread, { client: "dm" }, "evt-1", text("hi"));
    assert.equal(sent.outcome, "started");
    assert.deepEqual(await runtime.chat.finalReply(sent), { runId: sent.runId, status: "completed", text: "echo: hi" });
    // The platform redelivers the event: same key, no second Run.
    const again = await runtime.chat.send(alice, thread, { client: "dm" }, "evt-1", text("hi"));
    assert.deepEqual([again.outcome, again.runId, again.conversationId], ["replayed", sent.runId, sent.conversationId]);
    await assert.rejects(runtime.chat.send(alice, thread, { client: "dm" }, "evt-1", text("changed")), { code: "client_message_conflict" });
    // The same thread of another contact is another conversation.
    const other = await runtime.chat.send({ ...alice, contactId: "bob" }, thread, { client: "dm" }, "evt-2", text("hello"));
    assert.notEqual(other.conversationId, sent.conversationId);
    await runtime.chat.finalReply(other);
    await assert.rejects(runtime.chat.send({ ...alice, contactId: "bob" }, { kind: "conversation", id: sent.conversationId }, { client: "dm" }, "evt-3", text("let me in")), { code: "conversation_not_found" });
    await assert.rejects(runtime.chat.send(alice, thread, { client: "dm" }, "evt-4", [{ type: "image", assetId: "asset" }]), { code: "parts_unsupported" });
  } finally {
    await runtime.close();
  }
});

test("a contact's follow-up while a Run is active joins it, and the channel gets that Run's one reply", async () => {
  const { runtime, repository } = await gatewayFixture();
  try {
    const first = await runtime.chat.send(alice, thread, { client: "dm" }, "evt-a", text("one"));
    const second = await runtime.chat.send(alice, thread, { client: "dm" }, "evt-b", text("two"));
    // Whether the follow-up arrived mid-Run or just after it, no message is lost or answered twice per Run.
    const replies = [await runtime.chat.finalReply(first), await runtime.chat.finalReply(second)];
    assert.ok(replies.every((reply) => reply.status === "completed"));
    const runs = await repository.listRuns(first.conversationId);
    assert.ok(runs.length >= 1 && runs.length <= 2);
    assert.equal(runs.reduce((count, run) => count + 1 + run.steeredCount, 0), 2);
  } finally {
    await runtime.close();
  }
});

test("a Product that needs local tools is unavailable on dm instead of silently degrading", async () => {
  const { runtime, repository } = await gatewayFixture({ localTools: true });
  try {
    await assert.rejects(runtime.chat.send(alice, thread, { client: "dm" }, "evt-1", text("hi")), { code: "product_requires_local_tools" });
    await assert.rejects(runtime.chat.send(alice, thread, { client: "im" }, "evt-2", text("hi")), { code: "product_requires_local_tools" });
    assert.equal(await repository.countSentMessages({ ownerAccountId: principalKey(alice), creatorId, agentId: productId }), 0);
  } finally {
    await runtime.close();
  }
});

test("a contact past its message limit is refused before any Run exists", async () => {
  const { runtime } = await gatewayFixture({ maxMessages: 1 });
  try {
    const sent = await runtime.chat.send(alice, thread, { client: "dm" }, "evt-1", text("one"));
    await runtime.chat.finalReply(sent);
    await assert.rejects(runtime.chat.send(alice, thread, { client: "dm" }, "evt-2", text("two")), { code: "contact_limit_reached" });
  } finally {
    await runtime.close();
  }
});
