import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import { DeterministicAgentRuntime } from "./agentRuntime.js";
import { InMemoryConversationRepository } from "./conversationRepository.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION, type OutboundMessage } from "./protocol.js";
import { RuntimeStore } from "./store.js";

let runtime: RuntimeServer | undefined;

const binding = {
  creator_id: "creator_library",
  user_id: "account_library",
  agent_id: "agent_library",
  product_id: "product_library",
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

  const crossAgentScope = new URLSearchParams({ ...binding, agent_id: "agent_other" }).toString();
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
  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(dataDir),
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
    installation_id: "retry-installation",
    license_token: "retry-license",
    local_tools: ["file_search"]
  }));
  await waitForSocket(messages, (message) => message.type === "session.ready");
  socket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_transport_first",
    client_message_id: "message_stable_once",
    conversation_id: "conversation_retry",
    message: { role: "user", content: "Find Hatch." }
  }));
  await waitForSocket(messages, (message) => message.type === "tool_call.request" && message.run_id === "run_transport_first");

  socket.send(JSON.stringify({
    type: "client.message",
    run_id: "run_transport_retry",
    client_message_id: "message_stable_once",
    conversation_id: "conversation_retry",
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
    message: { role: "user", content: "Start another task." }
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

async function json(base: string, pathname: string, init: { method?: string; body?: Record<string, unknown> } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: init.method,
    headers: init.body ? { "content-type": "application/json" } : undefined,
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

async function openRuntimeSocket(base: string, installationId: string, messages: OutboundMessage[]): Promise<WebSocket> {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/runtime");
  socket.on("message", (value) => messages.push(JSON.parse(String(value)) as OutboundMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    installation_id: installationId,
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
