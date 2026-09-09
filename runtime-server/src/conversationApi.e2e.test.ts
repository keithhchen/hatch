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
import { InMemoryConversationRepository } from "./conversationRepository.js";
import type { AuthIdentityResolver, EntitlementBinding, EntitlementResolver } from "./entitlements.js";
import { RuntimeAssetStore } from "./assetStore.js";
import { createRuntimeServer, durableConversationId, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION, type OutboundMessage } from "./protocol.js";
import { RuntimeStore, localRuntimeAuthority } from "./store.js";

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
  runtime = createRuntimeServer({ conversationStore: new RuntimeStore(dataDir) });
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
  runtime = createRuntimeServer({ conversationStore: store });
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
  runtime = createRuntimeServer({ conversationStore: store, assetStore });
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
  const entitlementResolver: EntitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const authIdentityResolver: AuthIdentityResolver = {
    resolveIdentity: async () => ({ sub: entitlement.user_id, role: "user" })
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
  runtime = createRuntimeServer({ conversationStore: new RuntimeStore(dataDir) });
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

test("Run HTTP API rejects a detached reservation instead of occupying an executor slot", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-runs-"));
  runtime = createRuntimeServer({ conversationStore: new RuntimeStore(dataDir) });
  const base = await listen(runtime.server);
  const scope = new URLSearchParams(binding).toString();
  const conversation = (await json(base, `/v1/conversations?${scope}`, {
    method: "POST",
    body: { title: "Run target", client_request_id: "run_target" }
  })).body as { conversation: { id: string } };
  const pathPrefix = `/v1/conversations/${encodeURIComponent(conversation.conversation.id)}`;

  const first = await json(base, `${pathPrefix}/runs?${scope}`, {
    method: "POST",
    body: { client_message_id: "message_1" }
  });
  assert.equal(first.response.status, 409);
  assert.equal((first.body as { error: { code: string } }).error.code, "executor_attach_required");

  const listed = await json(base, `${pathPrefix}/runs?${scope}`);
  assert.equal(listed.response.status, 200);
  assert.deepEqual((listed.body as { runs: unknown[] }).runs, []);
});

test("GET run returns canonical submission receipts or null without writing on repeated reads", async () => {
  const store = new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-run-receipt-http-")));
  const repository = new InMemoryConversationRepository(store.localAuthority);
  runtime = createRuntimeServer({ conversationStore: store, conversationRepository: repository });
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
    await repository.transitionRun(id, "interrupted", "Test executor disconnected");
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
  runtime = createRuntimeServer({
    conversationStore: store,
    conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime()
  });
  const base = await listen(runtime.server);
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
    license_token: "retry-license",
    local_tools: ["file_search"]
  }));
  await waitForSocket(messages, (message) => message.type === "session.ready");
  socket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_transport_first",
    client_message_id: "message_stable_once",
    conversation_id: conversationId,
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

test("local attachments commit references and fixed image bytes without using the asset store", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-local-attachment-submit-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const store = new RuntimeStore(dataDir);
  const assetStore = new RuntimeAssetStore(path.join(dataDir, "assets"));
  const put = t.mock.method(assetStore, "put", async () => { throw new Error("OSS disabled"); });
  const read = t.mock.method(assetStore, "readBase64", async () => { throw new Error("OSS disabled"); });
  runtime = createRuntimeServer({ conversationStore: store, conversationRepository: repository, assetStore,
    createRuntime: () => ({ async *run(input) {
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } }) });
  const base = await listen(runtime.server);
  const conversationId = "conversation_local_attachments";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, "local-attachment-test", messages);
  const imageBytes = Buffer.from("fixed-image-input");
  const document = { kind: "local_file", attachment_id: "drop_document", display_name: "brief.pdf",
    host_id: "f780570c-7e50-4c14-bbd0-8a6c06d3302b", local_path: "/managed/brief.pdf",
    media_type: "application/pdf", source_bytes: 10, sha256: "a".repeat(64) };
  const image = { ...document, attachment_id: "drop_image", display_name: "image.png", local_path: "/managed/image.png",
    media_type: "image/png", source_bytes: imageBytes.length,
    sha256: createHash("sha256").update(imageBytes).digest("hex"), data_base64: imageBytes.toString("base64") };
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "local-run", client_message_id: "local-message",
      conversation_id: conversationId, message: { role: "user", content: "Read attachments", attachments: [document, image] } }));
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
  runtime = createRuntimeServer({ conversationStore: store, conversationRepository: repository,
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id,
        delta: { kind: "text" as const, content: "The document is ready for review." } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } }) });
  const base = await listen(runtime.server);
  const conversationId = "conversation_canonical_terminal";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, "canonical-test", messages);
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "canonical-run",
      client_message_id: "canonical-message", conversation_id: conversationId,
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
  runtime = createRuntimeServer({ conversationStore: store, conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime() });
  const base = await listen(runtime.server);
  const conversationId = "conversation_compact_acceptance";
  await repository.createConversation({ id: conversationId, publicId: conversationId,
    ownerAccountId: "local-development", creatorId: "local-development", agentId: "local-agent",
    productId: "local-product", corpusDigest: `sha256:${"0".repeat(64)}` });
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(base, "compact-acceptance", messages);
  try {
    socket.send(JSON.stringify({ type: "client.message", run_id: "compact-run",
      client_message_id: "compact-message", conversation_id: conversationId,
      message: { role: "user", content: "/compact" } }));
    // The provider failure is injected; this test never calls a live model.
    await waitForSocket(messages, (message) => message.type === "turn.failed");
    const accepted = messages.findIndex((message) => message.type === "message.accepted");
    assert.ok(accepted >= 0);
    assert.ok(accepted < messages.findIndex((message) => message.type === "turn.failed"));
    assert.equal((await store.readSubmissionReceipt(conversationId, "compact-run"))?.client_message_id, "compact-message");
    assert.deepEqual((await store.readConversation(conversationId)).filter((message) => message.role === "user"),
      [{ role: "user", content: "/compact", model_images: [] }]);
  } finally { socket.close(); }
});

test("Runtime startup interrupts a carried active Run instead of reclaiming or replaying it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-startup-recovery-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  const conversation = (await repository.createConversation({
    id: "conversation_startup_recovery",
    publicId: "conversation_startup_recovery",
    ownerAccountId: binding.user_id,
    creatorId: binding.creator_id,
    agentId: binding.agent_id,
    productId: binding.product_id,
    corpusDigest: binding.corpus_digest
  })).conversation;
  await repository.createRun({
    id: "run_startup_recovery",
    conversationId: conversation.id,
    clientMessageId: "message_startup_recovery",
    inputDigest: `sha256:${"a".repeat(64)}`,
    corpusDigest: binding.corpus_digest,
    executorId: "executor_lost_process"
  });

  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: repository
  });
  await listen(runtime.server);
  await waitForCondition(async () => (await repository.getRun(conversation.id, "run_startup_recovery"))?.status === "interrupted");

  const snapshot = await repository.snapshot(conversation.id);
  assert.equal(snapshot.runs[0]?.status, "interrupted");
  assert.ok(snapshot.events.some((event) => (
    event.type === "run.state"
    && event.payload.status === "interrupted"
    && event.payload.reason === "Runtime restarted; the executor connection was lost."
  )));
  assert.ok(!snapshot.events.some((event) => event.type === "message.created"));
});

test("two windows get distinct executor leases; disconnect is Interrupted and recovery is observer-only", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-recovery-"));
  const repository = new InMemoryConversationRepository(localRuntimeAuthority(dataDir));
  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
    conversationRepository: repository,
    createRuntime: () => new DeterministicAgentRuntime()
  });
  const base = await listen(runtime.server);
  const conversationId = "conversation_recovery";
  // Resolver-free test mode stores the raw public ID; product mode uses the
  // same repository path after deriving its binding server-side.
  const durableId = conversationId;
  await repository.createConversation({
    id: durableId,
    publicId: conversationId,
    ownerAccountId: "local-development",
    creatorId: "local-development",
    agentId: "local-agent",
    productId: "local-product",
    corpusDigest: `sha256:${"0".repeat(64)}`
  });

  const firstMessages: OutboundMessage[] = [];
  const firstSocket = await openRuntimeSocket(base, "same-installation", firstMessages);
  firstSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_recovery_first",
    client_message_id: "message_recovery_first",
    conversation_id: conversationId,
    message: { role: "user", content: "Find Hatch." }
  }));
  await waitForSocket(firstMessages, (message) => message.type === "tool_call.delta" && message.run_id === "run_recovery_first");
  const beforeDisconnect = await repository.snapshot(durableId);
  const beforeCursor = beforeDisconnect.cursor;
  const firstRun = await repository.getRun(durableId, "run_recovery_first");
  assert.ok(firstRun?.executorId?.startsWith("executor_"));
  assert.notEqual(firstRun?.executorId, "same-installation");

  const secondMessages: OutboundMessage[] = [];
  const secondSocket = await openRuntimeSocket(base, "same-installation", secondMessages);
  secondSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_recovery_parallel",
    client_message_id: "message_recovery_parallel",
    conversation_id: conversationId,
    message: { role: "user", content: "Start another product." }
  }));
  const busy = await waitForSocket(secondMessages, (message) => (
    message.type === "turn.failed" && message.run_id === "run_recovery_parallel"
  ));
  assert.equal(busy.type, "turn.failed");
  if (busy.type === "turn.failed") assert.equal(busy.error.code, "conversation_busy");

  firstSocket.close();
  await waitForCondition(async () => (await repository.getRun(durableId, "run_recovery_first"))?.status === "interrupted");

  const replay = await repository.snapshot(durableId, beforeCursor);
  const replayEvents = replay.events;
  assert.ok(replayEvents.some((event) => (
    event.type === "run.state"
    && event.payload.status === "interrupted"
    && event.payload.reason === "Client disconnected"
  )));

  // Same intent is an observer/retry acknowledgement only. It never takes the
  // lost lease or repeats its outstanding local-tool call.
  secondSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_recovery_retry",
    client_message_id: "message_recovery_first",
    conversation_id: conversationId,
    message: { role: "user", content: "Find Hatch." }
  }));
  const retry = await waitForSocket(secondMessages, (message) => (
    message.type === "turn.state"
    && message.run_id === "run_recovery_first"
    && message.status === "interrupted"
    && message.reason === "Idempotent client message replay"
  ));
  assert.equal(retry.type, "turn.state");
  assert.ok(!secondMessages.some((message) => message.type === "tool_call.delta" && message.run_id === "run_recovery_retry"));

  // A fresh user intent can start a replacement Run after the old executor is
  // interrupted. The new window receives its own server-generated lease.
  secondSocket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_recovery_replacement",
    client_message_id: "message_recovery_replacement",
    conversation_id: conversationId,
    message: { role: "user", content: "Find Hatch again." }
  }));
  const replacement = await waitForSocket(secondMessages, (message) => (
    (message.type === "tool_call.delta" || message.type === "turn.failed")
    && message.run_id === "run_recovery_replacement"
  ));
  assert.equal(replacement.type, "tool_call.delta");
  const replacementRun = await repository.getRun(durableId, "run_recovery_replacement");
  assert.ok(replacementRun?.executorId?.startsWith("executor_"));
  assert.notEqual(replacementRun?.executorId, firstRun?.executorId);
  secondSocket.close();
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
  runtime = createRuntimeServer({ conversationStore: store, conversationRepository: repository, assetStore,
    createRuntime: () => ({ async *run(input, context) {
      executions += 1;
      assert.deepEqual(context.messages[0]?.model_images, [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }]);
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } }) });
  const messages: OutboundMessage[] = [];
  const socket = await openRuntimeSocket(await listen(runtime.server), "atomic-image", messages);
  const request = { type: "client.message", conversation_id: "atomic-image", run_id: "image-run", client_message_id: "image-message",
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
  test(`socket loss ${boundary} atomic acceptance never strands a key or replays work`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hatch-atomic-socket-"));
    const store = new RuntimeStore(root);
    const repository = new InMemoryConversationRepository(store.localAuthority);
    let executions = 0;
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
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
    runtime = createRuntimeServer({ conversationStore: store, conversationRepository: repository,
      createRuntime: () => ({ async *run(input, context) {
        executions += 1;
        assert.equal(context.messages.filter((message) => message.role === "user").length, 1);
        yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
      } }) });
    const base = await listen(runtime.server);
    const messages: OutboundMessage[] = [];
    const socket = await openRuntimeSocket(base, "atomic-disconnect", messages);
    const request = { type: "client.message", conversation_id: "atomic-socket", run_id: "first",
      client_message_id: "stable", message: { role: "user", content: "accepted exactly once" } };
    socket.send(JSON.stringify(request));
    try {
      await waitForCondition(() => reached);
      socket.terminate();
      await waitForCondition(() => runtime!.wss.clients.size === 0);
      release();
      if (boundary === "after") {
        await waitForCondition(async () => (await repository.getRun("atomic-socket", "first"))?.status === "interrupted");
        assert.ok(await store.readSubmissionReceipt("atomic-socket", "first"));
      } else {
        assert.deepEqual(await repository.listRuns("atomic-socket"), []);
        assert.equal(await store.readSubmissionReceipt("atomic-socket", "first"), undefined);
      }
      assert.equal(executions, 0);
      assert.equal(messages.some((message) => message.type === "message.accepted"), false);
      const retryMessages: OutboundMessage[] = [];
      const retry = await openRuntimeSocket(base, "atomic-retry", retryMessages);
      try {
        retry.send(JSON.stringify({ ...request, run_id: "retry" }));
        const accepted = await waitForSocket(retryMessages, (message) => message.type === "message.accepted");
        assert.equal(accepted.type, "message.accepted");
        if (accepted.type !== "message.accepted") throw new Error("Expected acceptance receipt");
        assert.equal(accepted.run_id, boundary === "after" ? "first" : "retry");
        if (boundary === "after") {
          await waitForSocket(retryMessages, (message) => message.type === "turn.state" && message.reason === "Idempotent client message replay");
          assert.equal(executions, 0);
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

async function openRuntimeSocket(base: string, _testLabel: string, messages: OutboundMessage[]): Promise<WebSocket> {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/runtime");
  socket.on("message", (value) => messages.push(JSON.parse(String(value)) as OutboundMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    license_token: "recovery-license",
    local_tools: ["file_search"]
  }));
  await waitForSocket(messages, (message) => message.type === "session.ready");
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
