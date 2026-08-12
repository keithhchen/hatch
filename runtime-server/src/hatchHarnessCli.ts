import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { AgentRuntime } from "./agentRuntime.js";
import { AgentCorpusResolver } from "./agentCorpus.js";
import { FileConversationRepository } from "./conversationRepository.js";
import type { EntitlementBinding, EntitlementLookup, EntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { createOutputGuardFromEnvironment } from "./outputGuard.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { installCurrentCorpus, verifyAgentCorpus } from "./registryCorpus.js";
import { RuntimeStore } from "./store.js";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_EVENTS = 2_000;

export type HatchHarnessCliInput = {
  corpusRoot: string;
  creatorId: string;
  agentId: string;
  corpusDigest: string;
  question: string;
  timeoutMs?: number;
};

export type HatchHarnessCliResult = {
  ok: true;
  output: string;
  runId: string;
  corpusDigest: string;
  finishReason: "stop";
  terminalStatus: "completed";
  protocolEvents: Array<{ type: string; status?: string; name?: string }>;
  protocolTraceTruncated: boolean;
};

type HarnessDependencies = {
  createRuntime?: () => AgentRuntime;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

/**
 * Execute exactly one candidate through Hatch's existing product Runtime.
 * This wrapper owns transport and isolation only; createRuntimeServer still
 * owns Corpus materialization, the Agent loop, tools, output guard, and turn
 * lifecycle. No Creator Factory model setting is accepted by this boundary.
 */
export async function runHatchHarness(
  input: HatchHarnessCliInput,
  dependencies: HarnessDependencies = {}
): Promise<HatchHarnessCliResult> {
  validateInput(input);
  if (dependencies.signal?.aborted) throw abortError(dependencies.signal);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "hatch-full-harness-"));
  const runtimeData = path.join(scratch, "runtime");
  const corpusStore = path.join(scratch, "corpora");
  let runtime: RuntimeServer | undefined;
  try {
    const verifiedSource = await verifyAgentCorpus(input.corpusRoot, input.creatorId, input.agentId);
    throwIfAborted(dependencies.signal);
    if (verifiedSource.digest !== input.corpusDigest) {
      throw new Error(`Candidate Agent Corpus digest mismatch: expected ${input.corpusDigest}, got ${verifiedSource.digest}`);
    }
    await installCurrentCorpus(verifiedSource, corpusStore);
    throwIfAborted(dependencies.signal);

    const store = new RuntimeStore(runtimeData);
    runtime = createRuntimeServer({
      ...(dependencies.createRuntime ? { createRuntime: dependencies.createRuntime } : {}),
      conversationStore: store,
      conversationRepository: new FileConversationRepository(runtimeData),
      entitlementResolver: factoryHarnessEntitlementResolver(input, verifiedSource.product.id),
      agentCorpusResolver: new AgentCorpusResolver(corpusStore),
      outputGuard: createOutputGuardFromEnvironment(dependencies.environment ?? process.env)
    });
    const endpoint = await listen(runtime.server);
    throwIfAborted(dependencies.signal);
    return await executeOneTurn(endpoint, input, dependencies.signal);
  } finally {
    if (runtime) {
      const closing = runtime.close().catch(() => undefined);
      // Full Hatch Runtime currently owns its own request cancellation. When
      // the Factory child is terminated, do not let that product boundary
      // prevent this isolated process from removing its scratch snapshot.
      if (dependencies.signal?.aborted) await Promise.race([closing, delay(500)]);
      else await closing;
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function executeOneTurn(
  endpoint: string,
  input: HatchHarnessCliInput,
  signal?: AbortSignal
): Promise<HatchHarnessCliResult> {
  const socket = new WebSocket(endpoint);
  const runId = `factory_eval_${randomUUID().replaceAll("-", "")}`;
  const conversationId = `factory_eval_conversation_${randomUUID().replaceAll("-", "")}`;
  const installationId = `factory_eval_installation_${randomUUID().replaceAll("-", "")}`;
  const chunks: string[] = [];
  const protocolEvents: HatchHarnessCliResult["protocolEvents"] = [];
  let protocolTraceTruncated = false;
  let outputBytes = 0;
  let messageSent = false;
  let completed = false;
  let terminalCompleted = false;
  let finishReason: string | undefined;

  try {
    return await new Promise<HatchHarnessCliResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cancel("Factory Hatch harness timed out");
      fail(new Error(`Hatch Runtime did not complete within ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeedIfComplete = () => {
      if (settled || !completed || !terminalCompleted) return;
      const output = chunks.join("");
      if (finishReason !== "stop") return fail(new Error(`Hatch Runtime finished with ${finishReason ?? "no finish reason"}`));
      if (!output.trim()) return fail(new Error("Hatch Runtime returned an empty result"));
      settled = true;
      cleanup();
      resolve({
        ok: true,
        output,
        runId,
        corpusDigest: input.corpusDigest,
        finishReason: "stop",
        terminalStatus: "completed",
        protocolEvents,
        protocolTraceTruncated
      });
    };
    const cancel = (reason: string) => {
      if (messageSent && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "turn.cancel", run_id: runId, reason }));
      }
    };
    const onAbort = () => {
      cancel("Creator Factory lease or execution was cancelled");
      fail(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the precheck/listener race: a lease can be lost between entering
    // executeOneTurn and registering the listener above.
    if (signal?.aborted) onAbort();

    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "client.hello",
        protocol_version: PROTOCOL_VERSION,
        installation_id: installationId,
        license_token: "factory-harness-local",
        entitlement_id: "factory-harness-entitlement",
        creator_id: input.creatorId,
        agent_id: input.agentId,
        user_id: "creator-factory-evaluator",
        local_tools: []
      }));
    });
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        const type = typeof message.type === "string" ? message.type : "invalid";
        if (protocolEvents.length < MAX_TRACE_EVENTS) {
          protocolEvents.push({
            type,
            ...(typeof message.status === "string" ? { status: message.status } : {}),
            ...(typeof message.name === "string" ? { name: message.name } : {})
          });
        } else protocolTraceTruncated = true;
        if (type === "session.ready") {
          if (messageSent) throw new Error("Hatch Runtime emitted session.ready more than once");
          if (message.creator_id !== input.creatorId || message.agent_id !== input.agentId) {
            throw new Error("Hatch Runtime bound a different Creator Agent");
          }
          if (message.corpus_digest !== input.corpusDigest) {
            throw new Error(`Hatch Runtime loaded unexpected Corpus digest: ${String(message.corpus_digest)}`);
          }
          messageSent = true;
          socket.send(JSON.stringify({
            type: "client.message",
            run_id: runId,
            client_message_id: runId,
            conversation_id: conversationId,
            message: { role: "user", content: input.question }
          }));
          return;
        }
        const matchingRun = message.run_id === runId;
        if (type === "assistant.delta" && matchingRun) {
          const delta = message.delta as Record<string, unknown> | undefined;
          if (delta?.kind === "text" && typeof delta.content === "string") {
            outputBytes += Buffer.byteLength(delta.content);
            if (outputBytes > MAX_RESULT_BYTES) throw new Error("Hatch Runtime result exceeded the harness output limit");
            chunks.push(delta.content);
          }
        } else if (type === "tool_call.request" && matchingRun) {
          throw new Error(`Hatch Runtime requested unavailable buyer-local tool ${String(message.name)}`);
        } else if (type === "turn.completed" && matchingRun) {
          completed = true;
          finishReason = typeof message.finish_reason === "string" ? message.finish_reason : undefined;
          succeedIfComplete();
        } else if (type === "turn.state" && matchingRun) {
          const status = String(message.status ?? "");
          if (status === "completed") {
            terminalCompleted = true;
            succeedIfComplete();
          } else if (["failed", "cancelled", "interrupted"].includes(status)) {
            fail(new Error(`Hatch Runtime entered terminal state ${status}: ${String(message.reason ?? "")}`));
          }
        } else if (type === "turn.failed" && (!message.run_id || matchingRun)) {
          const detail = message.error as Record<string, unknown> | undefined;
          fail(new Error(`Hatch Runtime failed: ${String(detail?.code ?? "unknown")}: ${String(detail?.message ?? "")}`));
        }
      } catch (error) {
        cancel("Factory harness rejected the Runtime response");
        fail(error);
      }
    });
    socket.on("error", () => undefined);
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("Hatch Runtime connection closed before a successful terminal state"));
    });
    });
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) await closeSocket(socket);
  }
}

function factoryHarnessEntitlementResolver(
  input: HatchHarnessCliInput,
  productId: string
): EntitlementResolver {
  const binding: EntitlementBinding = {
    entitlement_id: "factory-harness-entitlement",
    order_id: "factory-harness-order",
    user_id: "creator-factory-evaluator",
    creator_id: input.creatorId,
    product_id: productId,
    purchased_corpus_digest: input.corpusDigest,
    status: "active",
    agent_id: input.agentId
  };
  const authorized = (lookup: EntitlementLookup): boolean => (
    lookup.licenseToken === "factory-harness-local"
    && (!lookup.entitlementId || lookup.entitlementId === binding.entitlement_id)
  );
  return {
    list: async (lookup) => authorized(lookup) ? [binding] : [],
    resolve: async (lookup) => {
      if (!authorized(lookup)) throw new Error("Factory harness entitlement binding mismatch");
      return binding;
    }
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Hatch Runtime did not bind a TCP port");
  return `ws://127.0.0.1:${address.port}/runtime`;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 500);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateInput(input: HatchHarnessCliInput): void {
  if (!path.isAbsolute(input.corpusRoot)) throw new Error("corpusRoot must be an absolute path");
  if (!input.creatorId.trim() || !input.agentId.trim()) throw new Error("creatorId and agentId are required");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.corpusDigest)) throw new Error("corpusDigest is invalid");
  if (!input.question.trim()) throw new Error("question is required");
  if (Buffer.byteLength(input.question) > MAX_STDIN_BYTES) throw new Error("question exceeds the Factory harness limit");
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 60 * 60_000)) {
    throw new Error("timeoutMs must be an integer between 1000 and 3600000");
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Factory Hatch harness aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

async function readSingleInput(): Promise<HatchHarnessCliInput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_STDIN_BYTES) throw new Error("Factory Hatch harness input exceeded the limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as HatchHarnessCliInput;
}

async function main(): Promise<void> {
  // The CLI stdout contract is one JSON document. Product diagnostics remain
  // on stderr even if a dependency happens to call console.log.
  console.log = (...values: unknown[]) => console.error(...values);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Factory Hatch harness process was terminated"));
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    const result = await runHatchHarness(await readSingleInput(), { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main();
}
