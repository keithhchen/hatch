import { endingOf } from "./testSupport.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import type { AgentCorpus, AgentCorpusResolver } from "./agentCorpus.js";
import { DeterministicAgentRuntime } from "./agentRuntime.js";
import { useSearchFixture } from "./searchFixture.testkit.js";
import { InMemoryConversationRepository } from "./conversationRepository.js";
import { chatCompactionAdapter } from "./compaction.js";
import { CompactionStrategy, policyFor } from "./compactionStrategy.js";
import type { AuthIdentityResolver, EntitlementBinding, EntitlementResolver } from "./entitlements.js";
import { RuntimeAssetStore } from "./assetStore.js";
import { createRuntimeServer, durableConversationId, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION, type OutboundMessage } from "./protocol.js";
import { RuntimeStore, localRuntimeAuthority } from "./store.js";

useSearchFixture();

let runtime: RuntimeServer | undefined;

const binding = {
  creator_id: "22222222-2222-4222-8222-222222222222",
  user_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "33333333-3333-4333-8333-333333333333",
  product_id: "33333333-3333-4333-8333-333333333333",
  corpus_digest: `sha256:${"b".repeat(64)}`
};

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

test("Conversation HTTP API owns metadata, pagination, versions, and cursor snapshots", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-api-"));
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: new RuntimeStore(dataDir) });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();

  const created = await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "Research brief", client_request_id: "create_research_brief" }
  });
  assert.equal(created.response.status, 201);
  const first = created.body as { conversation: { id: string; version: number; title: string }; created: boolean };
  assert.equal(first.created, true);
  assert.equal(first.conversation.title, "Research brief");
  assert.equal(first.conversation.version, 1);

  const retried = await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "This title must not replace the original", client_request_id: "create_research_brief" }
  });
  assert.equal(retried.response.status, 200);
  const retryBody = retried.body as { conversation: { id: string; title: string }; created: boolean };
  assert.equal(retryBody.created, false);
  assert.equal(retryBody.conversation.id, first.conversation.id);
  assert.equal(retryBody.conversation.title, "Research brief");

  const secondCreated = await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "Second conversation", client_request_id: "create_second" }
  });
  assert.equal(secondCreated.response.status, 201);

  const listed = await json(base, `/v1/conversations?${scope}&limit=1`);
  assert.equal(listed.response.status, 200);
  const listedBody = listed.body as { conversations: Array<{ id: string }>; next_cursor?: string };
  assert.equal(listedBody.conversations.length, 1);
  assert.ok(listedBody.next_cursor);
  const pageTwo = await json(base, `/v1/conversations?${scope}&limit=1&cursor=${encodeURIComponent(listedBody.next_cursor!)}`);
  assert.equal((pageTwo.body as { conversations: unknown[] }).conversations.length, 1);

  const updated = await json(base, `/v1/conversations/${encodeURIComponent(first.conversation.id)}?${scope}`, {
    method: "PATCH",
    body: { title: "Renamed brief", version: 1 }
  });
  assert.equal(updated.response.status, 200);
  assert.equal((updated.body as { conversation: { version: number; title: string } }).conversation.version, 2);
  const stale = await json(base, `/v1/conversations/${encodeURIComponent(first.conversation.id)}?${scope}`, {
    method: "PATCH",
    body: { title: "Stale", version: 1 }
  });
  assert.equal(stale.response.status, 409);
  assert.equal((stale.body as { error: { code: string } }).error.code, "version_conflict");

  const snapshot = await json(base, `/v1/conversations/${encodeURIComponent(first.conversation.id)}/snapshot?${scope}`);
  assert.equal(snapshot.response.status, 200);
  const snapshotBody = snapshot.body as { cursor: number; events: Array<{ cursor: number; type: string }>; conversation: { title: string } };
  assert.equal(snapshotBody.conversation.title, "Renamed brief");
  assert.deepEqual(snapshotBody.events.map((event) => event.type), ["conversation.created", "conversation.updated"]);
  assert.equal(snapshotBody.cursor, snapshotBody.events.at(-1)?.cursor);
  const firstCursor = snapshotBody.events[0]?.cursor;
  const replay = await json(base, `/v1/conversations/${encodeURIComponent(first.conversation.id)}/events?${scope}&after_cursor=${firstCursor}`);
  assert.deepEqual((replay.body as { events: Array<{ cursor: number }> }).events.map((event) => event.cursor), [snapshotBody.cursor]);

  const crossAgentScope = new URLSearchParams({ ...binding, product_id: "44444444-4444-4444-8444-444444444444" }).toString();
  const denied = await json(base, `/v1/conversations/${encodeURIComponent(first.conversation.id)}?${crossAgentScope}`);
  assert.equal(denied.response.status, 404);

  const upgradedCorpusScope = new URLSearchParams({
    ...binding,
    corpus_digest: `sha256:${"c".repeat(64)}`
  }).toString();
  const afterAgentUpdate = await json(base, `/v1/conversations/${encodeURIComponent(first.conversation.id)}?${upgradedCorpusScope}`);
  assert.equal(afterAgentUpdate.response.status, 200);
  assert.equal((afterAgentUpdate.body as { conversation: { id: string } }).conversation.id, first.conversation.id);
});

test("paged history keeps stable complete turns while new messages arrive", async () => {
  const store = new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-history-pages-")));
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const created = await json(base, `/v1/conversations?${scope}`, {
    method: "POST", body: { title: "Paged history", client_request_id: "pages" }
  });
  const id = (created.body as { conversation: { id: string } }).conversation.id;
  const durableId = durableConversationId({ creatorId: binding.creator_id, userId: binding.user_id, productId: binding.product_id }, id);
  const appendTurn = async (turn: number) => {
    for (const role of ["user", "assistant"] as const) {
      await store.append({ type: "message.created", conversation_id: durableId,
        run_id: `run_page_${turn}`, role, content: `${role}-${turn}` });
    }
  };
  for (let turn = 0; turn < 30; turn++) await appendTurn(turn);
  const first = await json(base, `/v1/conversations/${id}/snapshot?${scope}&view=page`);
  assert.equal(first.response.status, 200);
  const page = first.body as { messages: Array<{ id: string; content: string }>; events: unknown[]; has_more: boolean; before_cursor: string };
  assert.equal(page.messages.length, 50);
  assert.equal(page.has_more, true);
  assert.deepEqual(page.events, []);
  assert.ok(page.messages.every((message) => message.id));
  await appendTurn(30);
  const older = await json(base, `/v1/conversations/${id}/history?${scope}&before_cursor=${encodeURIComponent(page.before_cursor)}`);
  assert.equal(older.response.status, 200);
  const olderPage = older.body as typeof page;
  assert.equal(olderPage.messages.length, 10);
  assert.equal(olderPage.has_more, false);
  const all = [...olderPage.messages, ...page.messages];
  assert.equal(new Set(all.map((message) => message.id)).size, 60);
  assert.equal(all[0]?.content, "user-0");
  assert.equal(all.at(-1)?.content, "assistant-29");
  const badCursor = await json(base, `/v1/conversations/${id}/history?${scope}&before_cursor=broken`);
  assert.equal(badCursor.response.status, 400);
  const foreign = await json(base, `/v1/conversations?${scope}`, {
    method: "POST", body: { title: "Other", client_request_id: "other_pages" }
  });
  const foreignId = (foreign.body as { conversation: { id: string } }).conversation.id;
  const foreignCursor = await json(base, `/v1/conversations/${foreignId}/history?${scope}&before_cursor=${encodeURIComponent(page.before_cursor)}`);
  assert.equal(foreignCursor.response.status, 400);

  await store.append({ type: "tool.call", conversation_id: durableId, run_id: "run_page_29", tool_call_id: "large_tool",
    name: "shell_exec", locality: "client", status: "completed", arguments: { command: "echo test" }, result: { output: "x".repeat(1024 * 1024) } });
  const reduced = await json(base, `/v1/conversations/${id}/snapshot?${scope}&view=page`);
  assert.equal(reduced.response.status, 200);
  assert.ok(JSON.stringify(reduced.body).length < 100_000);
  const details = await json(base, `/v1/conversations/${id}/tools/run_page_29/large_tool?${scope}`);
  assert.equal(details.response.status, 200);
  assert.equal((details.body as { tool: { result: { output: string } } }).tool.result.output.length, 1024 * 1024);
  const deniedTool = await json(base, `/v1/conversations/${foreignId}/tools/run_page_29/large_tool?${scope}`);
  assert.equal(deniedTool.response.status, 404);
});

test("Conversation snapshot preserves attachment references and serves only bound assets", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-api-assets-"));
  const store = new RuntimeStore(dataDir);
  const assetStore = new RuntimeAssetStore(dataDir);
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, assetStore });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const created = await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "Attachment task", client_request_id: "attachment_task" }
  });
  assert.equal(created.response.status, 201);
  const conversationId = (created.body as { conversation: { id: string } }).conversation.id;
  const durableId = durableConversationId({
    creatorId: binding.creator_id,
    userId: binding.user_id,
    productId: binding.product_id
  }, conversationId);
  const bytes = Buffer.from("stored in the asset volume", "utf8");
  const reference = await assetStore.put({
    kind: "asset",
    attachment_id: "drop_snapshot_asset",
    asset_id: "asset_snapshot_asset",
    display_name: "snapshot.png",
    media_type: "image/png",
    source_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data_base64: bytes.toString("base64")
  });
  await store.append({
    type: "conversation.model_message",
    conversation_id: durableId,
    run_id: "run_snapshot_asset",
    message: { role: "user", content: "Inspect this", attachments: [reference] }
  });

  const snapshot = await json(base, `/v1/conversations/${encodeURIComponent(conversationId)}/snapshot?${scope}`);
  assert.equal(snapshot.response.status, 200);
  const snapshotMessage = (snapshot.body as {
    messages: Array<{ attachments?: Array<{ asset_id?: string; storage_ref?: string; data_base64?: string }> }>;
  }).messages[0];
  assert.equal(snapshotMessage?.attachments?.[0]?.asset_id, reference.asset_id);
  assert.equal(snapshotMessage?.attachments?.[0]?.storage_ref, reference.storage_ref);
  assert.equal(snapshotMessage?.attachments?.[0]?.data_base64, undefined);

  const assetResponse = await fetch(
    `${base}/v1/conversations/${encodeURIComponent(conversationId)}/assets/${encodeURIComponent(reference.asset_id)}?${scope}`
  );
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), bytes);

  const otherConversation = await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "Other task", client_request_id: "other_attachment_task" }
  });
  const otherId = (otherConversation.body as { conversation: { id: string } }).conversation.id;
  const denied = await fetch(
    `${base}/v1/conversations/${encodeURIComponent(otherId)}/assets/${encodeURIComponent(reference.asset_id)}?${scope}`
  );
  assert.equal(denied.status, 404);
});

test("Conversation HTTP creation carries the published corpus BriefSpec into an immutable snapshot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-api-brief-"));
  const entitlement: EntitlementBinding = {
    entitlement_id: "44444444-4444-4444-8444-444444444444",
    order_id: "55555555-5555-4555-8555-555555555555",
    user_id: "11111111-1111-4111-8111-111111111111",
    creator_id: "22222222-2222-4222-8222-222222222222",
    agent_id: "33333333-3333-4333-8333-333333333333",
    product_id: "33333333-3333-4333-8333-333333333333",
    status: "active"
  };
  const briefSpec = {
    contract_version: "1" as const,
    fields: [{ id: "goal", label: "What should Hatch help you accomplish?", required: true }]
  };
  entitlement.brief_spec = { contract_version: "1", fields: [{ id: "obsolete", label: "Old purchase form", required: true }] };
  const entitlementResolver: EntitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const authIdentityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => ({ sub: entitlement.user_id })
  };
  const agentCorpusResolver = {
    resolve: async () => ({
      root: "",
      digest: `sha256:${"b".repeat(64)}`,
      corpus: {
        agent_id: entitlement.agent_id,
        creator: { id: entitlement.creator_id, name: "Brief Creator" },
        product: {
          id: entitlement.product_id,
          name: "Brief Product",
          boundaries: [],
          brief_spec: briefSpec,
          presentation: {}
        },
        knowledge: { documents: [] },
        tools: []
      } as unknown as AgentCorpus
    })
  } as unknown as AgentCorpusResolver;
  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
    entitlementResolver,
    authIdentityResolver,
    agentCorpusResolver
  });
  const base = await listen(runtime.server);
  const query = new URLSearchParams({
    entitlement_id: entitlement.entitlement_id,
    creator_id: entitlement.creator_id,
    product_id: entitlement.product_id
  }).toString();
  const created = await json(base, `/v1/conversations?${query}`, {
    method: "POST",
    headers: { authorization: "Bearer brief-session" },
    body: {
      title: "Brief task",
      client_request_id: "brief_task_create",
      brief_answers: [{ field_id: "goal", value: "Ship the first release" }]
    }
  });
  assert.equal(created.response.status, 201);
  const conversation = (created.body as { conversation: { brief_snapshot?: { spec_digest: string; fields: Array<{ id: string; value: string | null }> } } }).conversation;
  assert.equal(conversation.brief_snapshot?.fields[0]?.id, "goal");
  assert.equal(conversation.brief_snapshot?.fields[0]?.value, "Ship the first release");
  assert.match(conversation.brief_snapshot?.spec_digest ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("Conversation Library keeps three Agent A and two Agent B conversations in separate scopes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-library-hierarchy-"));
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: new RuntimeStore(dataDir) });
  const base = await listen(runtime.server);
  const agentA = new URLSearchParams(binding).toString();
  const agentBBinding = {
    ...binding,
    creator_id: "55555555-5555-4555-8555-555555555555",
    agent_id: "66666666-6666-4666-8666-666666666666",
    product_id: "66666666-6666-4666-8666-666666666666"
  };
  const agentB = new URLSearchParams(agentBBinding).toString();

  const createMany = async (scope: string, prefix: string, count: number) => {
    const created = [] as Array<{ id: string; creator_id: string; product_id_at_creation: string }>;
    for (let index = 1; index <= count; index += 1) {
      const response = await json(base, `/v1/conversations?${scope}`, {
        method: "POST",
        body: {
          title: `${prefix} conversation ${index}`,
          client_request_id: `${prefix}_${index}`
        }
      });
      assert.ok(response.response.status === 201 || response.response.status === 200);
      created.push((response.body as { conversation: typeof created[number] }).conversation);
    }
    return created;
  };

  const conversationsA = await createMany(agentA, "agent_a", 3);
  const conversationsB = await createMany(agentB, "agent_b", 2);
  assert.equal(new Set(conversationsA.map((conversation) => conversation.id)).size, 3);
  assert.equal(new Set(conversationsB.map((conversation) => conversation.id)).size, 2);

  const listedA = await json(base, `/v1/conversations?${agentA}&limit=100`);
  const listedB = await json(base, `/v1/conversations?${agentB}&limit=100`);
  const idsA = (listedA.body as { conversations: Array<{ id: string; creator_id: string; product_id_at_creation: string }> }).conversations;
  const idsB = (listedB.body as { conversations: Array<{ id: string; creator_id: string; product_id_at_creation: string }> }).conversations;
  assert.equal(idsA.length, 3);
  assert.equal(idsB.length, 2);
  assert.ok(idsA.every((conversation) => conversation.creator_id === binding.creator_id && conversation.product_id_at_creation === binding.product_id));
  assert.ok(idsB.every((conversation) => conversation.creator_id === agentBBinding.creator_id && conversation.product_id_at_creation === agentBBinding.product_id));

  const crossAgentRead = await json(
    base,
    `/v1/conversations/${encodeURIComponent(conversationsA[0]!.id)}?${agentB}`
  );
  assert.equal(crossAgentRead.response.status, 404);
});

test("HTTP starts a Run with POST messages; the old POST runs reservation is gone", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-runs-"));
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: `echo: ${input.message.content}` } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const conversation = (await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "Run target", client_request_id: "run_target" }
  })).body as { conversation: { id: string } };
  const pathPrefix = `/v1/conversations/${encodeURIComponent(conversation.conversation.id)}`;

  const reservation = await json(base, `${pathPrefix}/runs?${scope}`, { method: "POST", body: { client_message_id: "message_1" } });
  assert.equal(reservation.response.status, 405);

  const answered = await json(base, `${pathPrefix}/messages?${scope}&wait=5`, { method: "POST", body: { client_message_id: "http-1", content: "hello" } });
  assert.equal(answered.response.status, 200);
  const result = answered.body as { outcome: string; reply: string; run: { id: string; status: string } };
  assert.deepEqual([result.outcome, result.run.status, result.reply], ["started", "completed", "echo: hello"]);

  // The same client message is idempotent: no second Run, the same result.
  const replay = await json(base, `${pathPrefix}/messages?${scope}&wait=5`, { method: "POST", body: { client_message_id: "http-1", content: "hello" } });
  assert.deepEqual([replay.response.status, (replay.body as typeof result).outcome, (replay.body as typeof result).run.id], [200, "replayed", result.run.id]);
  const conflict = await json(base, `${pathPrefix}/messages?${scope}&wait=5`, { method: "POST", body: { client_message_id: "http-1", content: "different" } });
  assert.equal(conflict.response.status, 409);
  const runs = (await json(base, `${pathPrefix}/runs?${scope}`)).body as { runs: unknown[] };
  assert.equal(runs.runs.length, 1);

  // Without an asset service on this Runtime, a part that refers to an asset is refused, not dropped.
  const image = await json(base, `${pathPrefix}/messages?${scope}`, { method: "POST", body: { client_message_id: "http-2", parts: [{ type: "image", assetId: "asset-1" }] } });
  assert.equal(image.response.status, 501);
  assert.equal((image.body as { error: { code: string } }).error.code, "attachments_unavailable");
});

test("HTTP answers a failed Run again with POST retry: one new Run over the same transcript, idempotent by retry_id, refused when there is nothing to answer", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-retry-"));
  let calls = 0;
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    createRuntime: () => ({ async *run(input) {
      if (++calls === 1) throw new Error("fetch failed");
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "second try" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const conversation = (await json(base, `/v1/conversations?${scope}`, { method: "POST", body: { client_request_id: "retry_target" } })).body as { conversation: { id: string } };
  const prefix = `/v1/conversations/${encodeURIComponent(conversation.conversation.id)}`;
  const statuses = async () => ((await json(base, `${prefix}/runs?${scope}`)).body as { runs: Array<{ id: string; status: string }> }).runs;

  const failed = await json(base, `${prefix}/messages?${scope}&wait=5`, { method: "POST", body: { client_message_id: "m-1", content: "hello" } });
  assert.equal((failed.body as { run: { status: string } }).run.status, "failed");

  const retried = await json(base, `${prefix}/retry?${scope}`, { method: "POST", body: { retry_id: "retry-1" } });
  assert.equal(retried.response.status, 202);
  const started = retried.body as { run_id: string; outcome: string };
  assert.equal(started.outcome, "started");
  const deadline = Date.now() + 5_000;
  while ((await statuses()).find((run) => run.id === started.run_id)?.status !== "completed" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual((await statuses()).map((run) => run.status), ["failed", "completed"]);
  assert.equal(calls, 2);

  const replay = await json(base, `${prefix}/retry?${scope}`, { method: "POST", body: { retry_id: "retry-1" } });
  assert.deepEqual([replay.response.status, (replay.body as typeof started).run_id, (replay.body as typeof started).outcome], [202, started.run_id, "replayed"]);
  // The latest Run completed: another key has nothing to answer again.
  const refused = await json(base, `${prefix}/retry?${scope}`, { method: "POST", body: { retry_id: "retry-2" } });
  assert.equal(refused.response.status, 409);
  assert.equal((refused.body as { error: { code: string } }).error.code, "run_not_retryable");
  assert.equal((await json(base, `${prefix}/retry?${scope}`, { method: "GET" })).response.status, 405);
  assert.equal((await json(base, `${prefix}/retry?${scope}`, { method: "POST", body: {} })).response.status, 400);
  assert.equal((await statuses()).length, 2);
  // Pinned contract: a malformed tool result is a 500 with a generic message, never the validator's text.
  const malformed = await json(base, `${prefix}/tool-results?${scope}`, { method: "POST", body: {} });
  assert.equal(malformed.response.status, 500);
  assert.deepEqual(malformed.body, { error: { code: "conversation_request_failed", message: "The Runtime could not complete this request." } });
});

test("HTTP without wait returns 202 with the run id, and a stream delivers the Run's events then ends", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-stream-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    createRuntime: () => ({ async *run(input) {
      await gate;
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "streamed" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const conversation = (await json(base, `/v1/conversations?${scope}`, { method: "POST", body: { client_request_id: "stream_target" } })).body as { conversation: { id: string } };
  const pathPrefix = `/v1/conversations/${encodeURIComponent(conversation.conversation.id)}`;

  const accepted = await json(base, `${pathPrefix}/messages?${scope}&wait=0`, { method: "POST", body: { client_message_id: "s-1", content: "go" } });
  assert.equal(accepted.response.status, 202);
  const runId = (accepted.body as { run_id: string }).run_id;
  const waited = await json(base, `${pathPrefix}/messages?${scope}&wait=1`, { method: "POST", body: { client_message_id: "s-2", content: "and this" } });
  // Slower than the wait: still the one Run, now carrying a steered message.
  assert.deepEqual([waited.response.status, (waited.body as { run_id: string; outcome: string }).run_id, (waited.body as { outcome: string }).outcome], [202, runId, "steered"]);

  const stream = await fetch(`${base}${pathPrefix}/events?${scope}&after_cursor=0`, { headers: { accept: "text/event-stream" } });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const reader = stream.body!.getReader();
  release();
  let text = "";
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5_000;
  while (!text.includes('"status":"completed"') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  assert.match(text, /event: journal\.event/);
  assert.match(text, /"journal_type":"message\.created"/);
  assert.match(text, /"status":"completed"/);
  // Leaving the stream earlier or later never decides the Run: it completed on its own.
  const finished = (await json(base, `${pathPrefix}/runs/${runId}?${scope}`)).body as { run: { status: string; steered_messages: number } };
  assert.deepEqual([finished.run.status, finished.run.steered_messages], ["completed", 1]);
});

test("GET run returns canonical submission receipts or null without writing on repeated reads", async () => {
  const store = new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-run-receipt-http-")));
  const repository = new InMemoryConversationRepository(store.localAuthority);
  await repository.initialize();
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const created = await json(base, `/v1/conversations?${scope}`, {
    method: "POST", body: { title: "Submission receipts", client_request_id: "receipt_http" }
  });
  assert.equal(created.response.status, 201);
  const publicId = (created.body as { conversation: { id: string } }).conversation.id;
  const conversationId = durableConversationId({
    creatorId: binding.creator_id, productId: binding.product_id, userId: binding.user_id
  }, publicId);
  const pathPrefix = `/v1/conversations/${encodeURIComponent(publicId)}/runs`;
  for (const id of ["accepted_run", "unaccepted_run"]) {
    await repository.createRun({
      id, conversationId, clientMessageId: `message_${id}`,
      inputDigest: `sha256:${"a".repeat(64)}`, corpusDigest: binding.corpus_digest
    });
    // Identical terminal run states must not determine message acceptance.
    await repository.endRun(id, endingOf("interrupted", "Test executor disconnected"));
  }
  await store.append({
    type: "conversation.model_message", conversation_id: conversationId,
    run_id: "accepted_run", client_message_id: "message_accepted_run",
    message: { role: "user", content: "A durably accepted message" }
  });
  const eventsBefore = await store.readEvents();
  const canonicalUser = eventsBefore.find((event) =>
    event.type === "conversation.model_message" && event.run_id === "accepted_run");
  assert.ok(canonicalUser);
  const snapshotBefore = await repository.snapshot(conversationId);
  const responses = new Map<string, unknown>();
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const id of ["accepted_run", "unaccepted_run"]) {
      const result = await json(base, `${pathPrefix}/${id}?${scope}`);
      assert.equal(result.response.status, 200);
      const body = result.body as { run: { id: string; status: string }; submission: unknown };
      assert.equal(body.run.id, id);
      assert.equal(body.run.status, "interrupted");
      assert.deepEqual(body.submission, id === "accepted_run" ? {
        run_id: id, client_message_id: "message_accepted_run", accepted_at: canonicalUser.timestamp
      } : null);
      if (attempt === 0) responses.set(id, body);
      else assert.deepEqual(body, responses.get(id));
    }
    const missing = await json(base, `${pathPrefix}/missing_run?${scope}`);
    assert.equal(missing.response.status, 404);
    assert.equal((missing.body as { error: { code: string } }).error.code, "run_not_found");
    assert.deepEqual(await store.readEvents(), eventsBefore, "GET must not append canonical history or receipts");
    assert.deepEqual(await repository.snapshot(conversationId), snapshotBefore, "GET must not mutate runs or the journal");
  }
});

test("WebSocket retries use client_message_id without creating a second run or replaying tools", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-ws-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  await repository.initialize();
  const conversationId = "conversation_retry";
  await repository.createConversation({
    id: conversationId,
    publicId: conversationId,
    ownerAccountId: "local-development",
    creatorId: "local-development",
    agentId: "local-agent",
    productId: "local-product",
    corpusDigest: `sha256:${"0".repeat(64)}`
  });
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: store,
    conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime()
  });
  const base = await listen(runtime.server);
  const socket = new WebSocket(base.replace("http:", "ws:") + "/runtime");
  const messages: OutboundMessage[] = [];
  socket.on("message", (value) => messages.push(JSON.parse(String(value)) as OutboundMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    conversation_id: conversationId,
    license_token: "retry-license",
    local_tools: []
  }));
  await waitForSocket(messages, (message) => message.type === "session.ready");
  socket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_transport_first",
    client_message_id: "message_stable_once",
    conversation_id: conversationId,
    local_tools: ["file_search"],
    message: { role: "user", content: "Find Hatch." }
  }));
  await waitForSocket(messages, (message) => message.type === "tool_call.delta" && message.run_id === "run_transport_first");
  const acceptedIndex = messages.findIndex((message) => message.type === "message.accepted"
    && message.run_id === "run_transport_first" && message.client_message_id === "message_stable_once");
  assert.ok(acceptedIndex >= 0, "the user message must be accepted before tools execute");
  assert.ok(acceptedIndex < messages.findIndex((message) => message.type === "tool_call.delta"));
  // Reopen the file store: receipt lookup must survive process-local state loss.
  const reopenedStore = new RuntimeStore(dataDir);
  const receipt = await reopenedStore.readSubmissionReceipt(conversationId, "run_transport_first");
  assert.equal(receipt?.client_message_id, "message_stable_once");
  assert.equal(await reopenedStore.readSubmissionReceipt(conversationId, "run_transport_retry"), undefined);

  socket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_transport_retry",
    client_message_id: "message_stable_once",
    conversation_id: conversationId,
    local_tools: ["file_search"],
    message: { role: "user", content: "Find Hatch." }
  }));
  const replay = await waitForSocket(messages, (message) => (
    message.type === "turn.state" && message.run_id === "run_transport_first" && message.reason === "Idempotent client message replay"
  ));
  assert.equal(replay.type, "turn.state");
  assert.ok(!messages.some((message) => message.type === "turn.failed" && message.run_id === "run_transport_retry"));
  assert.ok(!messages.some((message) => message.type === "tool_call.delta" && message.run_id === "run_transport_retry"));
  assert.equal(messages.filter((message) => message.type === "message.accepted"
    && message.run_id === "run_transport_first").length, 2, "retry replays the existing acceptance receipt");
  const committedUsers = (await reopenedStore.readEvents()).filter((event) =>
    event.type === "conversation.model_message" && event.conversation_id === conversationId
    && event.message.role === "user");
  assert.equal(committedUsers.length, 1, "transport retry must not append a second user message");
  socket.close();
});

test("a conversation-bound socket rejects a mismatched message before persistence or execution", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-bound-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  let executions = 0;
  await repository.initialize();
  for (const conversationId of ["conversation-bound", "conversation-other"]) {
    await repository.createConversation({
      id: conversationId,
      publicId: conversationId,
      ownerAccountId: "local-development",
      creatorId: "local-development",
      agentId: "local-agent",
      productId: "local-product",
      corpusDigest: `sha256:${"0".repeat(64)}`
    });
  }
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: store,
    conversationRepository: repository,
    createRuntime: () => ({
      async *run(input) {
        executions += 1;
        yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
      }
    })
  });
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(await listen(runtime.server), "conversation-bound", messages);
  try {
    socket.send(JSON.stringify({
      type: "client.message",
      run_id: "mismatched-run",
      client_message_id: "mismatched-message",
      conversation_id: "conversation-other",
      local_tools: [],
      message: { role: "user", content: "Must never run." }
    }));
    const failed = await waitForSocket(messages, (message) => (
      message.type === "turn.failed" && message.run_id === "mismatched-run"
    ));
    assert.equal(failed.type === "turn.failed" ? failed.error.code : undefined, "conversation_mismatch");
    assert.deepEqual(await repository.listRuns("conversation-bound"), []);
    assert.deepEqual(await repository.listRuns("conversation-other"), []);
    assert.deepEqual(await store.readConversation("conversation-bound"), []);
    assert.deepEqual(await store.readConversation("conversation-other"), []);
    assert.equal(executions, 0);
    assert.equal(messages.some((message) => message.type === "message.accepted"), false);
  } finally {
    socket.close();
  }
});

test("local attachments commit references and fixed image bytes without using the asset store", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-local-attachment-submit-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  const assetStore = new RuntimeAssetStore(path.join(dataDir, "assets"));
  const put = t.mock.method(assetStore, "put", async () => { throw new Error("OSS disabled"); });
  const read = t.mock.method(assetStore, "readBase64", async () => { throw new Error("OSS disabled"); });
  await repository.initialize();
  const conversationId = "conversation_local_attachments";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository, assetStore,
    createRuntime: () => ({ async *run(input) {
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } }) });
  const base = await listen(runtime.server);
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, conversationId, messages);
  const imageBytes = Buffer.from("fixed-image-input");
  const document = { kind: "local_file", attachment_id: "drop_document", display_name: "brief.pdf",
    host_id: "f780570c-7e50-4c14-bbd0-8a6c06d3302b", local_path: "/managed/brief.pdf",
    media_type: "application/pdf", source_bytes: 10, sha256: "a".repeat(64) };
  const image = { ...document, attachment_id: "drop_image", display_name: "image.png", local_path: "/managed/image.png",
    media_type: "image/png", source_bytes: imageBytes.length,
    sha256: createHash("sha256").update(imageBytes).digest("hex"), data_base64: imageBytes.toString("base64") };
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "local-run", client_message_id: "local-message",
      conversation_id: conversationId, local_tools: [], message: { role: "user", content: "Read attachments", attachments: [document, image] } }));
    await waitForSocket(messages, (message) => message.type === "message.accepted");
    const committed = (await new RuntimeStore(dataDir).readConversation(conversationId))[0]!;
    const { data_base64: _bytes, ...imageReference } = image;
    assert.deepEqual(committed.attachments, [document, imageReference]);
    assert.deepEqual(committed.model_images, [{ type: "image", data: image.data_base64, mimeType: "image/png" }]);
    assert.equal(put.mock.callCount(), 0);
    assert.equal(read.mock.callCount(), 0);
    await waitForSocket(messages, (message) => message.type === "turn.completed");
    const journal = await repository.snapshot(conversationId);
    assert.ok(!JSON.stringify(journal).includes(image.data_base64), "journal must not duplicate model image bytes");
    const visible = await store.readVisibleConversation(conversationId);
    assert.deepEqual(visible[0]?.attachments, [document, imageReference]);
    assert.ok(!JSON.stringify(visible).includes(image.data_base64), "UI history must not return model image bodies");
    assert.deepEqual(await new RuntimeStore(dataDir).readVisibleConversation(conversationId), visible);
  } finally { socket.close(); }
});

test("completed assistant body is stored once and journal carries only one notification", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-canonical-terminal-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  await repository.initialize();
  const conversationId = "conversation_canonical_terminal";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository,
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id,
        delta: { kind: "text" as const, content: "The document is ready for review." } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } }) });
  const base = await listen(runtime.server);
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, conversationId, messages);
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "canonical-run",
      client_message_id: "canonical-message", conversation_id: conversationId, local_tools: [],
      message: { role: "user", content: "Review my document." } }));
    await waitForSocket(messages, (message) => message.type === "turn.completed");
    const journal = await repository.snapshot(conversationId);
    const notifications = journal.events.filter((event) => event.type === "message.created" && event.payload.role === "assistant");
    assert.equal(notifications.length, 1);
    assert.ok(!Object.hasOwn(notifications[0]!.payload, "content"));
    const history = await store.readConversation(conversationId);
    assert.equal(history.filter((message) => message.role === "assistant").length, 1);
    assert.equal(history.at(-1)?.content, "The document is ready for review.");
  } finally { socket.close(); }
});

test("a failed manual compaction does not lose the already accepted user command", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: {
    message: "Injected compaction provider failure", type: "invalid_request_error"
  } }), { status: 400, headers: { "content-type": "application/json" } }));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-compact-acceptance-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  await repository.initialize();
  const conversationId = "conversation_compact_acceptance";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime() });
  const base = await listen(runtime.server);
  const messages: OutboundMessage[] = [];
  // Something older than the last turn exists to be summarized, so the injected provider failure is reached.
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: "earlier", message: { role: "user", content: "an earlier question" } });
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: "earlier", message: { role: "assistant", content: "an earlier answer" } });
  const socket = await openRuntimeSocket(base, conversationId, messages);
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "compact-run",
      client_message_id: "compact-message", conversation_id: conversationId, local_tools: [],
      message: { role: "user", content: "/compact" } }));
    // The provider failure is injected; this test never calls a live model.
    await waitForSocket(messages, (message) => message.type === "turn.failed");
    const accepted = messages.findIndex((message) => message.type === "message.accepted");
    assert.ok(accepted >= 0);
    assert.ok(accepted < messages.findIndex((message) => message.type === "turn.failed"));
    assert.equal((await store.readSubmissionReceipt(conversationId, "compact-run"))?.client_message_id, "compact-message");
    assert.deepEqual((await store.readConversation(conversationId)).filter((message) => message.role === "user").at(-1),
      { role: "user", content: "/compact", model_images: [] });
  } finally { socket.close(); }
});

test("a provider overflow is answered by compacting and continuing, once, and the turn completes", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-overflow-recovery-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  await repository.initialize();
  const conversationId = "conversation_overflow";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: "earlier", message: { role: "user", content: "an earlier question" } });
  await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: "earlier", message: { role: "assistant", content: "an earlier answer" } });
  const summarized: string[] = [];
  let attempts = 0;
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: store, conversationRepository: repository,
    // A test-only summarizer: no real model is called.
    compactionStrategy: () => new CompactionStrategy(chatCompactionAdapter(async () => { summarized.push("asked"); return "## Goal\nan earlier question"; }), policyFor(262_144)),
    createRuntime: () => ({ async *run(input) {
      attempts += 1;
      if (attempts === 1) throw new Error("Your input exceeds the context window of this model");
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "answered after compacting" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  const base = await listen(runtime.server);
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, conversationId, messages);
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "overflow-run", client_message_id: "overflow-message",
      conversation_id: conversationId, local_tools: [], message: { role: "user", content: "a new question" } }));
    await waitForSocket(messages, (message) => message.type === "turn.completed");
    assert.equal(attempts, 2);
    assert.deepEqual(summarized, ["asked"]);
    const compacted = messages.find((message) => message.type === "session.compacted") as { phase?: string; compaction_id?: string } | undefined;
    assert.equal(compacted?.phase, "overflow_recovery");
    assert.match(compacted?.compaction_id ?? "", /^cmp_/);
    assert.equal(messages.some((message) => message.type === "turn.failed"), false);
  } finally { socket.close(); }
});

test("Runtime startup ends a Run whose owner's lease lapsed as interrupted, keeps its partial reply, and never executes it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-startup-recovery-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  await repository.initialize();
  const conversationBinding = {
    ownerAccountId: binding.user_id, creatorId: binding.creator_id, agentId: binding.agent_id,
    productId: binding.product_id, corpusDigest: binding.corpus_digest
  };
  const lapsed = new Date(Date.now() - 1_000).toISOString();
  const carried = async (name: string) => {
    const conversation = (await repository.createConversation({ ...conversationBinding, id: `conversation_${name}`, publicId: `conversation_${name}` })).conversation;
    const accepted = await repository.acceptSubmission({
      binding: conversationBinding,
      run: { id: `run_${name}`, conversationId: conversation.id, clientMessageId: `message_${name}`, inputDigest: `sha256:${"a".repeat(64)}`, corpusDigest: binding.corpus_digest, executorId: "executor_lost_process", executorLeaseExpiresAt: lapsed },
      canonicalUser: { role: "user", content: `question ${name}` }
    });
    return { conversation, run: accepted.run };
  };
  const reading = await carried("reading");
  const waiting = await carried("waiting");
  // The dead process had streamed part of a reply to the first Run, and asked a local tool in the second.
  await repository.savePartialOutput(reading.run.id, "partial reading");
  const asked = new RuntimeStore(dataDir);
  await asked.append({ type: "conversation.model_message", conversation_id: waiting.conversation.id, run_id: waiting.run.id,
    message: { role: "assistant", content: null, tool_calls: [{ id: "call_lost", type: "function", function: { name: "file_search", arguments: "{}" } }] } });
  await repository.requestToolCall({ runId: waiting.run.id, toolCallId: "call_lost", name: "file_search", arguments: { query: "x" }, approval: "none",
    requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await repository.transitionRun(waiting.run.id, "waiting_for_tool");

  const executed: string[] = [];
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: repository,
    createRuntime: () => ({ async *run(input) {
      executed.push(input.run_id);
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  await listen(runtime.server);
  for (const carriedRun of [reading, waiting]) {
    await waitForCondition(async () => (await repository.getRun(carriedRun.conversation.id, carriedRun.run.id))?.status === "interrupted");
    assert.equal((await repository.getRun(carriedRun.conversation.id, carriedRun.run.id))?.failure?.code, "run_interrupted");
  }
  assert.deepEqual(executed, [], "no Run was resumed");

  const restarted = new RuntimeStore(dataDir);
  assert.equal((await restarted.readConversation(reading.conversation.id)).at(-1)?.content, "partial reading");
  assert.deepEqual((await restarted.readConversation(waiting.conversation.id)).slice(-1).map((message) => [message.role, message.tool_call_id]), [["tool", "call_lost"]]);
});

test("closing every client never stops a Run: it waits for its local tool and a later client finishes it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-abandon-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  await repository.initialize();
  const conversationId = "conversation_abandon";
  await repository.createConversation({
    id: conversationId, publicId: conversationId, ownerAccountId: "local-development", creatorId: "local-development",
    agentId: "local-agent", productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}`
  });
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime()
  });
  const base = await listen(runtime.server);

  const firstMessages: OutboundMessage[] = [];
  const first = await openRuntimeSocket(base, conversationId, firstMessages, ["file_search"]);
  first.send(JSON.stringify({
    type: "client.message", run_id: "run_abandon", client_message_id: "message_abandon", conversation_id: conversationId,
    local_tools: ["file_search"], message: { role: "user", content: "Find Hatch." }
  }));
  const request = await waitForSocket(firstMessages, (message) => message.type === "tool_call.request");
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Nobody is connected, and the Run is neither interrupted nor failed: it waits, durably.
  assert.equal((await repository.getRun(conversationId, "run_abandon"))?.status, "waiting_for_tool");

  const secondMessages: OutboundMessage[] = [];
  const second = await openRuntimeSocket(base, conversationId, secondMessages, ["file_search"]);
  // A client that arrives later is shown the call that is still waiting, and may answer it.
  const replayed = await waitForSocket(secondMessages, (message) => message.type === "tool_call.request");
  assert.equal(replayed.type === "tool_call.request" && replayed.tool_call_id, request.type === "tool_call.request" && request.tool_call_id);
  second.send(JSON.stringify({ type: "tool_call.result", run_id: "run_abandon", tool_call_id: (replayed as { tool_call_id: string }).tool_call_id, status: "ok", result: { matches: [] } }));
  await waitForCondition(async () => (await repository.getRun(conversationId, "run_abandon"))?.status === "completed");
  second.close();
});

test("a tool result sent through another conversation never reaches the Run that asked", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-foreign-result-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  await repository.initialize();
  for (const id of ["conversation_victim", "conversation_attacker"]) {
    await repository.createConversation({
      id, publicId: id, ownerAccountId: "local-development", creatorId: "local-development",
      agentId: "local-agent", productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}`
    });
  }
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: new RuntimeStore(dataDir), conversationRepository: repository, createRuntime: () => new DeterministicAgentRuntime() });
  const base = await listen(runtime.server);

  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, "conversation_victim", messages, ["file_search"]);
  socket.send(JSON.stringify({
    type: "client.message", run_id: "run_victim", client_message_id: "message_victim", conversation_id: "conversation_victim",
    local_tools: ["file_search"], message: { role: "user", content: "Find Hatch." }
  }));
  const request = await waitForSocket(messages, (message) => message.type === "tool_call.request") as { tool_call_id: string };

  const attackerMessages: OutboundMessage[] = [];
  const attacker = await openRuntimeSocket(base, "conversation_attacker", attackerMessages, ["file_search"]);
  attacker.send(JSON.stringify({ type: "tool_call.result", run_id: "run_victim", tool_call_id: request.tool_call_id, status: "ok", result: { matches: [] } }));
  await waitForSocket(attackerMessages, (message) => message.type === "turn.failed");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await repository.getRun("conversation_victim", "run_victim"))?.status, "waiting_for_tool");
  assert.equal((await repository.listToolCalls("run_victim"))[0]?.outcome, undefined);
  socket.close();
  attacker.close();
});

test("a message sent during a Run joins it, from any client, and is idempotent per message", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-steer-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  await repository.initialize();
  const conversationId = "conversation_steer";
  await repository.createConversation({
    id: conversationId, publicId: conversationId, ownerAccountId: "local-development", creatorId: "local-development",
    agentId: "local-agent", productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}`
  });
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime()
  });
  const base = await listen(runtime.server);
  const firstMessages: OutboundMessage[] = [];
  const secondMessages: OutboundMessage[] = [];
  const first = await openRuntimeSocket(base, conversationId, firstMessages, ["file_search"]);
  const second = await openRuntimeSocket(base, conversationId, secondMessages, []);
  first.send(JSON.stringify({
    type: "client.message", run_id: "run_steer", client_message_id: "message_one", conversation_id: conversationId,
    local_tools: ["file_search"], message: { role: "user", content: "Find Hatch." }
  }));
  await waitForSocket(firstMessages, (message) => message.type === "tool_call.request");
  const steer = JSON.stringify({
    type: "client.message", run_id: "run_other", client_message_id: "message_two", conversation_id: conversationId,
    message: { role: "user", content: "Also check the docs." }
  });
  second.send(steer);
  second.send(steer);
  // The second window's message joins the Run it did not start; there is no conversation_busy.
  const accepted = await waitForSocket(secondMessages, (message) => message.type === "message.accepted" && message.client_message_id === "message_two");
  assert.equal(accepted.type === "message.accepted" && accepted.run_id, "run_steer");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(secondMessages.filter((message) => message.type === "turn.failed"), []);
  assert.equal((await repository.listRuns(conversationId)).length, 1);
  assert.equal((await repository.getRun(conversationId, "run_steer"))?.steeredCount, 1);

  const answer = async (nth: number) => {
    await waitForCondition(async () => firstMessages.filter((message) => message.type === "tool_call.request").length === nth);
    const request = firstMessages.filter((message) => message.type === "tool_call.request")[nth - 1] as { tool_call_id: string };
    first.send(JSON.stringify({ type: "tool_call.result", run_id: "run_steer", tool_call_id: request.tool_call_id, status: "ok", result: { matches: [] } }));
  };
  await answer(1);
  // The Deterministic runtime does not take messages mid-turn, so the Run answers the first message,
  // finds the second unclaimed, and the supervisor runs it again from there instead of completing.
  await answer(2);
  await waitForCondition(async () => (await repository.getRun(conversationId, "run_steer"))?.status === "completed");
  const users = (await new RuntimeStore(dataDir).readConversation(conversationId)).filter((message) => message.role === "user").map((message) => message.content);
  assert.deepEqual(users, ["Find Hatch.", "Also check the docs."]);
  // The reply to both messages is one Run's one final answer. The Run is stored completed before its end reaches the socket.
  await waitForSocket(firstMessages, (message) => message.type === "turn.completed");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(firstMessages.filter((message) => message.type === "turn.completed").length, 1);
  first.close();
  second.close();
});

test("WebSocket subscribe: stream false gets durable events only, stream true also the live deltas, same cursors", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-subscribe-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  await repository.initialize();
  const conversationId = "conversation_subscribe";
  await repository.createConversation({
    id: conversationId, publicId: conversationId, ownerAccountId: "local-development", creatorId: "local-development",
    agentId: "local-agent", productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}`
  });
  runtime = createRuntimeServer({ insecureLocalMode: true,
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: repository,
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "live words" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  const base = await listen(runtime.server);
  const starterMessages: OutboundMessage[] = [];
  const quietMessages: OutboundMessage[] = [];
  const loudMessages: OutboundMessage[] = [];
  const starter = await openRuntimeSocket(base, conversationId, starterMessages);
  const quiet = await openRuntimeSocket(base, conversationId, quietMessages);
  const loud = await openRuntimeSocket(base, conversationId, loudMessages);
  quiet.send(JSON.stringify({ type: "conversation.subscribe", conversation_id: conversationId, stream: false, after_cursor: 0 }));
  loud.send(JSON.stringify({ type: "conversation.subscribe", conversation_id: conversationId, stream: true, after_cursor: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  starter.send(JSON.stringify({
    type: "client.message", run_id: "run_subscribe", client_message_id: "message_subscribe", conversation_id: conversationId,
    message: { role: "user", content: "Say something." }
  }));
  const done = (messages: OutboundMessage[]) => messages.some((message) => (message as { journal_type?: string; payload?: { status?: string } }).journal_type === "run.state"
    && (message as { payload?: { status?: string } }).payload?.status === "completed");
  await waitForCondition(async () => done(quietMessages) && done(loudMessages));
  const kinds = (messages: OutboundMessage[]) => messages.map((message) => message.type);
  assert.ok(!kinds(quietMessages).includes("assistant.delta"));
  assert.ok(kinds(loudMessages).includes("assistant.delta"));
  const cursors = (messages: OutboundMessage[]) => messages.flatMap((message) => message.type as string === "journal.event" ? [(message as { cursor?: number }).cursor] : []);
  assert.deepEqual(cursors(quietMessages), cursors(loudMessages));
  assert.ok(cursors(quietMessages).length >= 4);
  // Resuming from the last cursor replays nothing already seen.
  const last = cursors(quietMessages).at(-1)!;
  const resumedMessages: OutboundMessage[] = [];
  const resumed = await openRuntimeSocket(base, conversationId, resumedMessages);
  resumed.send(JSON.stringify({ type: "conversation.subscribe", conversation_id: conversationId, stream: false, after_cursor: last }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(cursors(resumedMessages), []);
  for (const socket of [starter, quiet, loud, resumed]) socket.close();
});

test("missing image fails before accepting, and retry uses fixed committed bytes without materializing again", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-atomic-image-"));
  const store = new RuntimeStore(root);
  const repository = new InMemoryConversationRepository(store.localAuthority);
  const assetStore = new RuntimeAssetStore(path.join(root, "assets"));
  const bytes = Buffer.from("immutable model image");
  const attachment = { kind: "asset" as const, attachment_id: "image", asset_id: "image", display_name: "image.png",
    media_type: "image/png", source_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  let executions = 0;
  await repository.initialize();
  await repository.createConversation({ id: "atomic-image", publicId: "atomic-image",
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository, assetStore,
    createRuntime: () => ({ async *run(input, context) {
      executions += 1;
      assert.deepEqual(context.messages[0]?.model_images, [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } }) });
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(await listen(runtime.server), "atomic-image", messages);
  const request = { type: "client.message", conversation_id: "atomic-image", run_id: "image-run", client_message_id: "image-message",
    local_tools: [],
    message: { role: "user", content: "look", attachments: [attachment] } };
  try {
    socket.send(JSON.stringify(request));
    await waitForSocket(messages, (message) => message.type === "turn.failed");
    assert.deepEqual(await repository.listRuns("atomic-image"), []);
    assert.equal(await store.readSubmissionReceipt("atomic-image", "image-run"), undefined);
    assert.equal(messages.some((message) => message.type === "message.accepted"), false);
    assert.equal(executions, 0);
    await assetStore.put({ ...attachment, data_base64: bytes.toString("base64") });
    socket.send(JSON.stringify(request));
    await waitForSocket(messages, (message) => message.type === "turn.completed");
    const read = t.mock.method(assetStore, "readBase64", async () => { throw new Error("image store offline after acceptance"); });
    const put = t.mock.method(assetStore, "put", async () => { throw new Error("image store offline after acceptance"); });
    socket.send(JSON.stringify({ ...request, run_id: "image-retry" }));
    await waitForSocket(messages, (message) => message.type === "turn.state" && message.reason === "Idempotent client message replay");
    assert.equal(read.mock.callCount(), 0);
    assert.equal(put.mock.callCount(), 0);
    assert.equal(executions, 1);
    assert.equal((await store.readConversation("atomic-image")).filter((message) => message.role === "user").length, 1);
  } finally { socket.terminate(); }
});

for (const boundary of ["before", "after"] as const) {
  test(`socket loss ${boundary} atomic acceptance never strands a key; an accepted Run still finishes once`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hatch-atomic-socket-"));
    const store = new RuntimeStore(root);
    const repository = new InMemoryConversationRepository(store.localAuthority);
    let executions = 0;
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await repository.initialize();
    await repository.createConversation({ id: "atomic-socket", publicId: "atomic-socket",
      ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
      productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
    const original = repository.acceptSubmission.bind(repository);
    let inject = true;
    repository.acceptSubmission = async (input) => {
      if (!inject) return original(input);
      inject = false;
      if (boundary === "before") {
        reached = true;
        await gate;
        throw new Error("injected pre-commit failure");
      }
      const committed = await original(input);
      reached = true;
      await gate;
      return committed;
    };
    runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository,
      createRuntime: () => ({ async *run(input, context) {
        executions += 1;
        assert.equal(context.messages.filter((message) => message.role === "user").length, 1);
        yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
      } }) });
    const base = await listen(runtime.server);
    const messages: OutboundMessage[] = [];
    const socket = await openRuntimeSocket(base, "atomic-socket", messages);
    const request = { type: "client.message", conversation_id: "atomic-socket", run_id: "first",
      client_message_id: "stable", local_tools: [], message: { role: "user", content: "accepted exactly once" } };
    socket.send(JSON.stringify(request));
    try {
      await waitForCondition(() => reached);
      socket.terminate();
      await waitForCondition(() => runtime!.wss.clients.size === 0);
      release();
      if (boundary === "after") {
        // The client is gone, but the accepted message belongs to the server: its Run runs to completion.
        await waitForCondition(async () => (await repository.getRun("atomic-socket", "first"))?.status === "completed");
        assert.ok(await store.readSubmissionReceipt("atomic-socket", "first"));
      } else {
        assert.deepEqual(await repository.listRuns("atomic-socket"), []);
        assert.equal(await store.readSubmissionReceipt("atomic-socket", "first"), undefined);
      }
      assert.equal(executions, boundary === "after" ? 1 : 0);
      assert.equal(messages.some((message) => message.type === "message.accepted"), false);
      const retryMessages: OutboundMessage[] = [];
      const retry = await openRuntimeSocket(base, "atomic-socket", retryMessages);
      try {
        retry.send(JSON.stringify({ ...request, run_id: "retry" }));
        const accepted = await waitForSocket(retryMessages, (message) => message.type === "message.accepted");
        assert.equal(accepted.type, "message.accepted");
        if (accepted.type !== "message.accepted") throw new Error("Expected acceptance receipt");
        assert.equal(accepted.run_id, boundary === "after" ? "first" : "retry");
        if (boundary === "after") {
          await waitForSocket(retryMessages, (message) => message.type === "turn.state" && message.reason === "Idempotent client message replay");
          assert.equal(executions, 1);
        } else {
          await waitForSocket(retryMessages, (message) => message.type === "turn.completed");
          assert.equal(executions, 1);
        }
        assert.equal((await repository.listRuns("atomic-socket")).length, 1);
        assert.equal((await store.readConversation("atomic-socket")).filter((message) => message.role === "user").length, 1);
      } finally { retry.terminate(); }
    } finally { release(); socket.terminate(); }
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime server did not bind TCP");
  return `http://127.0.0.1:${address.port}`;
}

async function json(base: string, pathname: string, init: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: init.method,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  return { response, body: await response.json() as unknown };
}

async function waitForSocket(
  messages: OutboundMessage[],
  predicate: (message: OutboundMessage) => boolean,
  timeoutMs = 3_000
): Promise<OutboundMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for WebSocket message");
}

async function openRuntimeSocket(base: string, conversationId: string, messages: OutboundMessage[], localTools: string[] = []): Promise<WebSocket> {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/runtime");
  socket.on("message", (value) => messages.push(JSON.parse(String(value)) as OutboundMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    conversation_id: conversationId,
    license_token: "recovery-license",
    local_tools: localTools
  }));
  const ready = await waitForSocket(messages, (message) => message.type === "session.ready");
  assert.equal(ready.type === "session.ready" ? ready.conversation_id : undefined, conversationId);
  return socket;
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
