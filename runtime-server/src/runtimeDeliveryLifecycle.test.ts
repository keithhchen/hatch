import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import type { AgentRuntime } from "./agentRuntime.js";
import { AgentCorpusResolver } from "./agentCorpus.js";
import type { CommerceEventSink, CommerceEventType } from "./delivery.js";
import { DeliveryAccountingOutbox } from "./deliveryOutbox.js";
import type { EntitlementBinding, EntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION, type OutboundMessage } from "./protocol.js";
import { RuntimeStore } from "./store.js";

const temporaryDirectories: string[] = [];
const activeServers: RuntimeServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("entitlement runs reserve, consume, release, and replay idempotently", async () => {
  const fixture = await productFixture();

  const successfulSink = new MemoryCommerceSink();
  const successful = await startRuntime(fixture, successfulSink, () => ({
    async *run(input) {
      yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "text", content: "Delivery complete." } };
      yield {
        type: "tool_call.delta",
        run_id: input.run_id,
        tool_call_id: "write-local-artifact",
        name: "file_write",
        locality: "client",
        approval: "ask",
        status: "completed",
        arguments: { path: "/Users/buyer/private-workspace/delivery.md", content: "private delivery" }
      };
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  }));
  successful.socket.send(JSON.stringify(clientMessage("run_success")));
  const deliveryReady = await waitForMessage(successful.messages, (message) => message.type === "delivery.ready" && message.run_id === "run_success");
  await waitForMessage(successful.messages, (message) => message.type === "turn.completed" && message.run_id === "run_success");
  assert.deepEqual(successfulSink.calls.map((call) => call.kind), [
    "reserve",
    "append:task.started",
    "append:artifact.created",
    "complete"
  ]);
  const artifactEvent = successfulSink.calls.find((call) => call.kind === "append:artifact.created");
  assert.ok(artifactEvent);
  assert.equal(Object.hasOwn(artifactEvent.payload, "artifact_path"), false);
  assert.equal(Object.hasOwn(deliveryReady, "artifact_path"), false);

  const successfulCallCount = successfulSink.calls.length;
  successful.socket.send(JSON.stringify(clientMessage("run_success")));
  await waitForMessage(successful.messages, (message) => (
    message.type === "turn.state"
    && message.run_id === "run_success"
    && message.reason === "Idempotent client message replay"
  ));
  assert.equal(successfulSink.calls.length, successfulCallCount);
  successful.socket.close();

  // A fresh Runtime repository still recovers the completed commerce receipt
  // and must not reserve or deliver the same run twice.
  const recovered = await startRuntime(fixture, successfulSink, () => ({
    async *run(input) {
      yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "text", content: "must not execute" } };
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  }));
  recovered.socket.send(JSON.stringify(clientMessage("run_success")));
  await waitForMessage(recovered.messages, (message) => message.type === "delivery.ready" && message.run_id === "run_success");
  await waitForMessage(recovered.messages, (message) => message.type === "turn.completed" && message.run_id === "run_success");
  assert.equal(successfulSink.calls.length, successfulCallCount);
  recovered.socket.close();

  const failedSink = new MemoryCommerceSink();
  const failed = await startRuntime(fixture, failedSink, () => ({
    async *run(): AsyncIterable<OutboundMessage> {
      throw new Error("model failed");
    }
  }));
  failed.socket.send(JSON.stringify(clientMessage("run_failed")));
  await waitForMessage(failed.messages, (message) => message.type === "turn.failed" && message.run_id === "run_failed");
  await waitFor(() => failedSink.calls.some((call) => call.kind === "release") ? true : undefined);
  assert.deepEqual(failedSink.calls.map((call) => call.kind), ["reserve", "release"]);
  assert.equal(failedSink.calls.at(-1)?.payload.reason, "run_failed");
  failed.socket.close();

  const cancelledSink = new MemoryCommerceSink();
  const cancelled = await startRuntime(fixture, cancelledSink, () => ({
    async *run(input, context) {
      while (context.state.status !== "cancelled") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "assistant.delta", run_id: input.run_id, delta: { kind: "status", content: "working" } };
      }
    }
  }));
  cancelled.socket.send(JSON.stringify(clientMessage("run_cancelled")));
  await waitFor(() => cancelledSink.calls.some((call) => call.kind === "reserve") ? true : undefined);
  cancelled.socket.send(JSON.stringify({ type: "turn.cancel", run_id: "run_cancelled", reason: "buyer cancelled" }));
  await waitForMessage(cancelled.messages, (message) => (
    message.type === "turn.failed"
    && message.run_id === "run_cancelled"
    && message.error.code === "run_cancelled"
  ));
  await waitFor(() => cancelledSink.calls.some((call) => call.kind === "release") ? true : undefined);
  assert.deepEqual(cancelledSink.calls.map((call) => call.kind), ["reserve", "release"]);
  assert.equal(cancelledSink.calls.at(-1)?.payload.reason, "run_cancelled");
  cancelled.socket.close();
});

test("saved artifact completes while Commerce receipt syncs durably across Runtime restart", async () => {
  const fixture = await productFixture();
  const outboxRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-delivery-outage-"));
  temporaryDirectories.push(outboxRoot);
  const outboxFile = path.join(outboxRoot, "delivery-outbox.json");
  const sink = new OutageCommerceSink();
  const firstOutbox = new DeliveryAccountingOutbox(outboxFile);
  const first = await startRuntime(fixture, sink, () => ({
    async *run(input) {
      yield {
        type: "tool_call.delta",
        run_id: input.run_id,
        tool_call_id: "write-before-outage",
        name: "file_write",
        locality: "client",
        approval: "ask",
        status: "completed",
        arguments: { path: "/Users/buyer/Private Workspace/result.md", content: "private artifact body" }
      };
      sink.accountingAvailable = false;
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" };
    }
  }), firstOutbox);
  first.socket.send(JSON.stringify(clientMessage("run_outage")));
  const syncingReceipt = await waitForMessage(first.messages, (message) => (
    message.type === "delivery.ready"
    && message.run_id === "run_outage"
    && message.receipt_status === "syncing"
  ));
  const completed = await waitForMessage(first.messages, (message) => (
    message.type === "turn.completed"
    && message.run_id === "run_outage"
  ));
  assert.equal(completed.type === "turn.completed" ? completed.receipt_status : undefined, "syncing");
  assert.equal(Object.hasOwn(syncingReceipt, "artifact_path"), false);
  assert.equal(sink.calls.some((call) => call.kind === "release"), false);
  assert.equal((await firstOutbox.list()).length, 1);
  const serialized = await readFile(outboxFile, "utf8");
  assert.doesNotMatch(serialized, /Private Workspace|private artifact body|artifact_path|"content"/);

  first.socket.close();
  await first.runtime.close();
  const firstRuntimeIndex = activeServers.indexOf(first.runtime);
  if (firstRuntimeIndex >= 0) activeServers.splice(firstRuntimeIndex, 1);

  sink.accountingAvailable = true;
  const restartedOutbox = new DeliveryAccountingOutbox(outboxFile);
  const restarted = createRuntimeServer({
    createRuntime: () => ({ async *run(): AsyncIterable<OutboundMessage> { throw new Error("must not run"); } }),
    conversationStore: new RuntimeStore(path.join(outboxRoot, "restarted-runtime")),
    agentCorpusResolver: new AgentCorpusResolver(fixture.corpusRoot),
    entitlementResolver: fixture.entitlementResolver,
    commerceEventSink: sink,
    deliveryAccountingOutbox: restartedOutbox,
    deliveryReconcileIntervalMs: 20
  });
  activeServers.push(restarted);
  await new Promise<void>((resolve) => restarted.server.listen(0, "127.0.0.1", resolve));
  await waitFor(() => sink.calls.some((call) => call.kind === "complete") ? true : undefined);
  await waitForAsync(async () => (await restartedOutbox.list()).length === 0 ? true : undefined);
  assert.equal(sink.calls.some((call) => call.kind === "release"), false);
});

class MemoryCommerceSink implements CommerceEventSink {
  readonly calls: Array<{ kind: string; payload: Record<string, unknown>; idempotencyKey: string }> = [];
  readonly events = new Map<string, Record<string, unknown>>();

  async append(
    type: CommerceEventType,
    payload: Record<string, unknown>,
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    this.calls.push({ kind: `append:${type}`, payload, idempotencyKey: options.idempotencyKey });
    this.events.set(options.idempotencyKey, structuredClone(payload));
    return payload;
  }

  findByIdempotencyKey(key: string): unknown {
    return this.events.get(key);
  }

  async authorizeAndReserve(
    input: Parameters<NonNullable<CommerceEventSink["authorizeAndReserve"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    this.calls.push({ kind: "reserve", payload: input, idempotencyKey: options.idempotencyKey });
    return input;
  }

  async releaseReservation(
    input: Parameters<NonNullable<CommerceEventSink["releaseReservation"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    this.calls.push({ kind: "release", payload: input, idempotencyKey: options.idempotencyKey });
    return input;
  }

  async completeDelivery(
    input: Parameters<NonNullable<CommerceEventSink["completeDelivery"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    this.calls.push({ kind: "complete", payload: input, idempotencyKey: options.idempotencyKey });
    this.events.set(`${options.idempotencyKey}:delivery`, structuredClone(input));
    return input;
  }
}

class OutageCommerceSink extends MemoryCommerceSink {
  accountingAvailable = true;

  override async append(
    type: CommerceEventType,
    payload: Record<string, unknown>,
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    if (!this.accountingAvailable) throw new Error("Commerce unavailable after artifact write");
    return super.append(type, payload, options);
  }

  override async completeDelivery(
    input: Parameters<NonNullable<CommerceEventSink["completeDelivery"]>>[0],
    options: { idempotencyKey: string }
  ): Promise<unknown> {
    if (!this.accountingAvailable) throw new Error("Commerce unavailable after artifact write");
    return super.completeDelivery(input, options);
  }
}

type ProductFixture = {
  corpusRoot: string;
  entitlementResolver: EntitlementResolver;
  entitlement: EntitlementBinding;
};

async function productFixture(): Promise<ProductFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-delivery-lifecycle-"));
  temporaryDirectories.push(root);
  const corpusRoot = path.join(root, "corpora");
  const creatorId = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
  const productId = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
  const agentRoot = path.join(corpusRoot, creatorId, productId);
  await mkdir(path.join(agentRoot, "instructions"), { recursive: true });
  await mkdir(path.join(agentRoot, "evals"), { recursive: true });
  const system = "Complete the requested delivery.";
  const evaluations = "[]";
  await writeFile(path.join(agentRoot, "instructions/system.md"), system, "utf8");
  await writeFile(path.join(agentRoot, "evals/evals.json"), evaluations, "utf8");
  const asset = (assetPath: string, content: string, id: string) => ({
    id,
    path: assetPath,
    sha256: digest(content)
  });
  await writeFile(path.join(agentRoot, "agent.json"), JSON.stringify({
    contract_version: "1",
    creator: { id: creatorId, name: "Commerce Creator" },
    product: { id: productId, name: "Commerce Product" },
    instructions: { system: asset("instructions/system.md", system, "system") },
    skills: [],
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: {
      synthetic_qa: [asset("evals/evals.json", evaluations, "synthetic")],
      held_out: [asset("evals/evals.json", evaluations, "held-out")]
    }
  }), "utf8");
  const purchasedCorpus = await new AgentCorpusResolver(corpusRoot).resolve(creatorId, productId);
  const entitlement: EntitlementBinding = {
    entitlement_id: "7ce5faf8-0849-413d-8aa0-ac5a371e0a81",
    order_id: "8ce5faf8-0849-413d-8aa0-ac5a371e0a81",
    user_id: "buyer-commerce",
    creator_id: creatorId,
    agent_id: productId,
    product_id: productId,
    purchased_corpus_digest: purchasedCorpus.digest,
    status: "active"
  };
  const entitlementResolver: EntitlementResolver = {
    async list(input) {
      return input.licenseToken === "license-commerce" ? [entitlement] : [];
    },
    async resolve(input) {
      if (input.licenseToken !== "license-commerce" || input.entitlementId !== entitlement.entitlement_id) {
        throw new Error("not entitled");
      }
      return entitlement;
    }
  };
  return { corpusRoot, entitlementResolver, entitlement };
}

async function startRuntime(
  fixture: ProductFixture,
  commerceEventSink: CommerceEventSink,
  createRuntime: () => AgentRuntime,
  deliveryAccountingOutbox?: DeliveryAccountingOutbox
): Promise<{ socket: WebSocket; messages: OutboundMessage[]; runtime: RuntimeServer }> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-delivery-state-"));
  temporaryDirectories.push(dataRoot);
  const runtime = createRuntimeServer({
    createRuntime,
    conversationStore: new RuntimeStore(dataRoot),
    agentCorpusResolver: new AgentCorpusResolver(fixture.corpusRoot),
    entitlementResolver: fixture.entitlementResolver,
    commerceEventSink,
    deliveryAccountingOutbox,
    deliveryReconcileIntervalMs: 60_000
  });
  activeServers.push(runtime);
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
  const messages: OutboundMessage[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data)) as OutboundMessage));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    license_token: "license-commerce",
    entitlement_id: fixture.entitlement.entitlement_id,
    creator_id: fixture.entitlement.creator_id,
    product_id: fixture.entitlement.product_id,
    local_tools: []
  }));
  await waitForMessage(messages, (message) => message.type === "session.ready");
  return { socket, messages, runtime };
}

function clientMessage(runId: string): Record<string, unknown> {
  return {
    type: "client.message",
    run_id: runId,
    conversation_id: `conversation-${runId}`,
    message: { role: "user", content: "Create the delivery." }
  };
}

async function waitForMessage(
  messages: OutboundMessage[],
  predicate: (message: OutboundMessage) => boolean
): Promise<OutboundMessage> {
  return waitFor(() => messages.find(predicate));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Runtime lifecycle state");
}

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for asynchronous Runtime lifecycle state");
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
