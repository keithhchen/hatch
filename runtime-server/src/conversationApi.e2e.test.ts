import assert from "node:assert/strict";
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
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION, type OutboundMessage } from "./protocol.js";
import { RuntimeStore } from "./store.js";

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

test("WebSocket retries use client_message_id without creating a second run or replaying tools", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-ws-"));
  const repository = new InMemoryConversationRepository();
  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
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
  await waitForSocket(messages, (message) => message.type === "tool_call.request" && message.run_id === "run_transport_first");

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
  assert.ok(!messages.some((message) => message.type === "tool_call.request" && message.run_id === "run_transport_retry"));
  socket.close();
});

test("Runtime startup interrupts a carried active Run instead of reclaiming or replaying it", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-startup-recovery-"));
  const repository = new InMemoryConversationRepository();
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
  const repository = new InMemoryConversationRepository();
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
  await waitForSocket(firstMessages, (message) => message.type === "tool_call.request" && message.run_id === "run_recovery_first");
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
  assert.ok(!secondMessages.some((message) => message.type === "tool_call.request" && message.run_id === "run_recovery_retry"));

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
    (message.type === "tool_call.request" || message.type === "turn.failed")
    && message.run_id === "run_recovery_replacement"
  ));
  assert.equal(replacement.type, "tool_call.request");
  const replacementRun = await repository.getRun(durableId, "run_recovery_replacement");
  assert.ok(replacementRun?.executorId?.startsWith("executor_"));
  assert.notEqual(replacementRun?.executorId, firstRun?.executorId);
  secondSocket.close();
});

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
