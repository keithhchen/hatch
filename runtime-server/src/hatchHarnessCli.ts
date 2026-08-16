import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { AgentRuntime } from "./agentRuntime.js";
import { AgentCorpusResolver } from "./agentCorpus.js";
import type { BriefSpec } from "./brief.js";
import { FileConversationRepository } from "./conversationRepository.js";
import type { EntitlementBinding, EntitlementLookup, EntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { createOutputGuardFromEnvironment } from "./outputGuard.js";
import { requireUuidV4 } from "./identity.js";
import {
  PROTOCOL_VERSION,
  ToolCallResultSchema,
  type ClientHello,
  type ClientToolName,
  type ToolRequest,
  type ToolResult
} from "./protocol.js";
import { installCurrentCorpus, verifyAgentCorpus } from "./registryCorpus.js";
import { RuntimeStore } from "./store.js";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_STDIN_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_EVENTS = 2_000;
const MAX_LOCAL_RUNNER_LINE_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const MAX_LOCAL_RUNNER_STDERR_BYTES = 64 * 1024;
const MAX_PENDING_LOCAL_TOOL_CALLS = 64;
const LOCAL_RUNNER_SHUTDOWN_MS = 2_000;
const LOCAL_TOOLS = [
  "file_list",
  "file_search",
  "file_read",
  "file_write",
  "file_patch",
  "shell_exec",
  "git_diff"
] as const satisfies readonly ClientToolName[];
const FACTORY_HARNESS_ENTITLEMENT_ID = "77777777-7777-4777-8777-777777777777";
const FACTORY_HARNESS_ORDER_ID = "88888888-8888-4888-8888-888888888888";
const FACTORY_HARNESS_USER_ID = "99999999-9999-4999-8999-999999999999";
const FACTORY_HARNESS_BRIEF_SPEC: BriefSpec = {
  contract_version: "1",
  fields: [{ id: "evaluation-question", label: "What candidate behavior should Hatch evaluate?", required: true }]
};

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
  protocolEvents: Array<{
    type: string;
    status?: string;
    name?: string;
    acceptedProtocolVersion?: string;
  }>;
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
  const localWorkspace = path.join(scratch, "workspace");
  let runtime: RuntimeServer | undefined;
  let localRunner: LocalToolSidecar | undefined;
  try {
    const verifiedSource = await verifyAgentCorpus(input.corpusRoot, input.creatorId, input.agentId);
    throwIfAborted(dependencies.signal);
    if (verifiedSource.digest !== input.corpusDigest) {
      throw new Error(`Candidate Agent Corpus digest mismatch: expected ${input.corpusDigest}, got ${verifiedSource.digest}`);
    }
    await installCurrentCorpus(verifiedSource, corpusStore);
    throwIfAborted(dependencies.signal);

    // Candidate execution gets the same seven client-local capabilities as
    // Hatch Desktop, but their authority is an empty, one-run workspace. The
    // Corpus and Factory run directories are never mounted into this process.
    await mkdir(localWorkspace, { recursive: false });
    localRunner = await LocalToolSidecar.start(
      localWorkspace,
      dependencies.environment ?? process.env,
      dependencies.signal
    );
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
    return await executeOneTurn(endpoint, input, localRunner, dependencies.signal);
  } finally {
    if (runtime) {
      const closing = runtime.close().catch(() => undefined);
      // Full Hatch Runtime currently owns its own request cancellation. When
      // the Factory child is terminated, do not let that product boundary
      // prevent this isolated process from removing its scratch snapshot.
      if (dependencies.signal?.aborted) await Promise.race([closing, delay(500)]);
      else await closing;
    }
    await localRunner?.close(Boolean(dependencies.signal?.aborted));
    await rm(scratch, { recursive: true, force: true });
  }
}

async function executeOneTurn(
  endpoint: string,
  input: HatchHarnessCliInput,
  localRunner: LocalToolSidecar,
  signal?: AbortSignal
): Promise<HatchHarnessCliResult> {
  const conversationResponse = await fetch(
    `${endpoint.replace(/^ws:/, "http:").replace(/\/runtime$/, "")}/v1/conversations?${new URLSearchParams({
      entitlement_id: FACTORY_HARNESS_ENTITLEMENT_ID,
      creator_id: input.creatorId,
      product_id: input.agentId
    })}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer factory-harness-local",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        client_request_id: `factory-harness-${randomUUID()}`,
        brief_answers: [{ field_id: "evaluation-question", value: input.question }]
      }),
      signal
    }
  );
  const conversationBody = await conversationResponse.json() as { conversation?: { id?: string }; error?: { message?: string } };
  const conversationId = conversationBody.conversation?.id;
  if (!conversationResponse.ok || !conversationId) {
    throw new Error(`Hatch Runtime could not create the Factory evaluation task: ${conversationBody.error?.message ?? conversationResponse.status}`);
  }
  const socket = new WebSocket(endpoint);
  const runId = `factory_eval_${randomUUID().replaceAll("-", "")}`;
  const chunks: string[] = [];
  const protocolEvents: HatchHarnessCliResult["protocolEvents"] = [];
  let protocolTraceTruncated = false;
  let outputBytes = 0;
  let messageSent = false;
  let completed = false;
  let terminalCompleted = false;
  let finishReason: string | undefined;
  let lastSuccessfulFileWrite: string | undefined;

  try {
    return await new Promise<HatchHarnessCliResult>((resolve, reject) => {
    let settled = false;
    let removeSidecarFailure: () => void = () => undefined;
    const timeout = setTimeout(() => {
      cancel("Factory Hatch harness timed out");
      fail(new Error(`Hatch Runtime did not complete within ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      removeSidecarFailure();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeedIfComplete = () => {
      if (settled || !completed || !terminalCompleted) return;
      const output = lastSuccessfulFileWrite ?? chunks.join("");
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
    removeSidecarFailure = localRunner.onFailure((error) => {
      cancel("Factory local-tool sidecar failed");
      fail(error);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    // Close the precheck/listener race: a lease can be lost between entering
    // executeOneTurn and registering the listener above.
    if (signal?.aborted) onAbort();

    socket.once("open", () => {
      const hello = {
        type: "client.hello",
        protocol_version: PROTOCOL_VERSION,
        license_token: "factory-harness-local",
        entitlement_id: FACTORY_HARNESS_ENTITLEMENT_ID,
        creator_id: input.creatorId,
        product_id: input.agentId,
        user_id: FACTORY_HARNESS_USER_ID,
        local_tools: [...LOCAL_TOOLS]
      } satisfies ClientHello;
      socket.send(JSON.stringify(hello));
    });
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        const type = typeof message.type === "string" ? message.type : "invalid";
        if (protocolEvents.length < MAX_TRACE_EVENTS) {
          protocolEvents.push({
            type,
            ...(typeof message.status === "string" ? { status: message.status } : {}),
            ...(typeof message.name === "string" ? { name: message.name } : {}),
            ...(typeof message.accepted_protocol_version === "string"
              ? { acceptedProtocolVersion: message.accepted_protocol_version }
              : {})
          });
        } else protocolTraceTruncated = true;
        if (type === "session.ready") {
          if (messageSent) throw new Error("Hatch Runtime emitted session.ready more than once");
          if (message.accepted_protocol_version !== PROTOCOL_VERSION) {
            throw new Error(
              `Hatch Runtime negotiated unexpected protocol version: ${String(message.accepted_protocol_version)}`
            );
          }
          if (message.creator_id !== input.creatorId || message.product_id !== input.agentId) {
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
          const request = parseToolRequest(message);
          void localRunner.execute(request).then(async (result) => {
            if (settled) return;
            if (
              result.status === "ok"
              && request.name === "file_write"
              && typeof request.arguments.content === "string"
            ) {
              if (Buffer.byteLength(request.arguments.content) > MAX_RESULT_BYTES) {
                throw new Error("Hatch Runtime file delivery exceeded the harness output limit");
              }
              // Match Runtime delivery semantics: the last completed
              // file_write is the product artifact; the assistant text is UI
              // narration only. file_patch deliberately does not replace it.
              lastSuccessfulFileWrite = request.arguments.content;
            }
            await sendSocketJson(socket, result);
          }).catch((error) => {
            cancel("Factory local-tool bridge failed");
            fail(error);
          });
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
    entitlement_id: FACTORY_HARNESS_ENTITLEMENT_ID,
    order_id: FACTORY_HARNESS_ORDER_ID,
    user_id: FACTORY_HARNESS_USER_ID,
    creator_id: input.creatorId,
    product_id: productId,
    status: "active",
    agent_id: productId,
    brief_spec: FACTORY_HARNESS_BRIEF_SPEC
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

type PendingLocalToolCall = {
  request: ToolRequest;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
};

/**
 * Thin JSONL transport around the same hermetic Rust LocalRunner used by the
 * product client. It does not implement tools, approve paths, or interpret
 * results; those responsibilities remain in the canonical sidecar.
 */
class LocalToolSidecar {
  private readonly pending = new Map<string, PendingLocalToolCall>();
  private readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private outputBuffer = Buffer.alloc(0);
  private stderr: Buffer[] = [];
  private stderrBytes = 0;
  private writeQueue = Promise.resolve();
  private failure: Error | undefined;
  private closing = false;
  private readonly failureListeners = new Set<(error: Error) => void>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.consumeOutput(chunk));
    child.stdout.once("error", (error) => this.fail(error));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderrBytes >= MAX_LOCAL_RUNNER_STDERR_BYTES) return;
      const remaining = MAX_LOCAL_RUNNER_STDERR_BYTES - this.stderrBytes;
      const retained = chunk.subarray(0, remaining);
      this.stderr.push(retained);
      this.stderrBytes += retained.byteLength;
    });
    child.stderr.once("error", (error) => this.fail(error));
    child.stdin.once("error", (error) => {
      if (!this.closing) this.fail(error);
    });
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => {
      this.resolveClosed();
      if (!this.closing) {
        const diagnostic = Buffer.concat(this.stderr).toString("utf8").trim();
        this.fail(new Error(
          `Hatch LocalRunner exited before the harness completed (${code ?? signal ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`
        ));
      }
    });
  }

  static async start(
    workspace: string,
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal
  ): Promise<LocalToolSidecar> {
    throwIfAborted(signal);
    const binary = await resolveLocalRunnerBinary(environment);
    throwIfAborted(signal);
    const child = spawn(binary, ["--sandbox", workspace, "serve"], {
      cwd: workspace,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: localRunnerEnvironment(environment, path.dirname(workspace))
    });
    const sidecar = new LocalToolSidecar(child);
    try {
      await sidecar.waitUntilSpawned(signal);
      const probe = await sidecar.execute({
        type: "tool_call.request",
        run_id: "factory_local_runner_probe",
        tool_call_id: `probe_${randomUUID().replaceAll("-", "")}`,
        name: "file_list",
        arguments: { path: "." },
        approval: "none"
      }, signal);
      if (probe.status !== "ok") {
        throw new Error(`Hatch LocalRunner readiness probe failed: ${probe.error.message}`);
      }
      return sidecar;
    } catch (error) {
      await sidecar.close(true);
      throw error;
    }
  }

  execute(request: ToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error("Hatch LocalRunner is shutting down"));
    if (!LOCAL_TOOLS.includes(request.name as ClientToolName)) {
      return Promise.reject(new Error(`Hatch Runtime requested a non-canonical local tool: ${request.name}`));
    }
    if (this.pending.size >= MAX_PENDING_LOCAL_TOOL_CALLS) {
      return Promise.reject(new Error(
        `Hatch LocalRunner exceeded ${MAX_PENDING_LOCAL_TOOL_CALLS} pending tool calls`
      ));
    }
    const key = localToolCallKey(request.run_id, request.tool_call_id);
    if (this.pending.has(key)) {
      return Promise.reject(new Error(`Duplicate Hatch local tool call: ${request.tool_call_id}`));
    }
    const result = new Promise<ToolResult>((resolve, reject) => {
      this.pending.set(key, { request, resolve, reject });
    });
    this.writeQueue = this.writeQueue.then(() => this.writeLine(JSON.stringify(request)));
    void this.writeQueue.catch((error) => this.fail(error));
    return signal ? raceWithAbort(result, signal) : result;
  }

  onFailure(listener: (error: Error) => void): () => void {
    if (this.failure) queueMicrotask(() => listener(this.failure!));
    else this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  async close(force = false): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    const shutdownError = this.failure ?? new Error("Hatch LocalRunner was shut down");
    for (const pending of this.pending.values()) pending.reject(shutdownError);
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return this.closed;

    // The sidecar owns active OS processes. Ask it to cancel and join them
    // before EOF; SIGTERM is only a bounded fallback if its control loop is
    // itself unresponsive. Node streams preserve this frame after all writes
    // already accepted into stdin, including a just-dispatched shell call.
    if (this.child.stdin.writable) {
      this.child.stdin.end(`${JSON.stringify({ type: "sidecar.cancel", all: true })}\n`);
    }
    if (await settlesWithin(this.closed, LOCAL_RUNNER_SHUTDOWN_MS)) return;
    this.child.kill("SIGTERM");
    if (await settlesWithin(this.closed, LOCAL_RUNNER_SHUTDOWN_MS)) return;
    this.child.kill("SIGKILL");
    await this.closed;
  }

  private async waitUntilSpawned(signal?: AbortSignal): Promise<void> {
    const spawned = new Promise<void>((resolve, reject) => {
      if (this.child.pid !== undefined) return resolve();
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
    await (signal ? raceWithAbort(spawned, signal) : spawned);
    if (this.failure) throw this.failure;
  }

  private writeLine(line: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || !this.child.stdin.writable) {
      return Promise.reject(new Error("Hatch LocalRunner stdin is unavailable"));
    }
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private consumeOutput(chunk: Buffer): void {
    if (this.failure) return;
    this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);
    while (true) {
      const newline = this.outputBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.outputBuffer.subarray(0, newline);
      this.outputBuffer = this.outputBuffer.subarray(newline + 1);
      if (line.byteLength > MAX_LOCAL_RUNNER_LINE_BYTES) {
        return this.fail(new Error("Hatch LocalRunner response exceeded the JSONL envelope"));
      }
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return this.fail(new Error(`Hatch LocalRunner emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
      const parsed = ToolCallResultSchema.safeParse(raw);
      if (!parsed.success) {
        const sidecarError = raw && typeof raw === "object" && (raw as { type?: unknown }).type === "sidecar.error"
          ? String((raw as { error?: { message?: unknown } }).error?.message ?? "unknown sidecar error")
          : parsed.error.message;
        return this.fail(new Error(`Hatch LocalRunner emitted an invalid tool result: ${sidecarError}`));
      }
      const result = parsed.data;
      const key = localToolCallKey(result.run_id, result.tool_call_id);
      const pending = this.pending.get(key);
      if (!pending) {
        return this.fail(new Error(`Hatch LocalRunner returned an unknown tool call: ${result.tool_call_id}`));
      }
      this.pending.delete(key);
      pending.resolve(result);
    }
    if (this.outputBuffer.byteLength > MAX_LOCAL_RUNNER_LINE_BYTES) {
      this.fail(new Error("Hatch LocalRunner response exceeded the JSONL envelope"));
    }
  }

  private fail(error: unknown): void {
    if (this.failure || this.closing) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    for (const listener of this.failureListeners) listener(this.failure);
    this.failureListeners.clear();
    this.child.kill("SIGTERM");
  }
}

function parseToolRequest(message: Record<string, unknown>): ToolRequest {
  if (
    typeof message.run_id !== "string"
    || typeof message.tool_call_id !== "string"
    || typeof message.name !== "string"
    || !message.arguments
    || typeof message.arguments !== "object"
    || Array.isArray(message.arguments)
    || !["none", "auto", "ask"].includes(String(message.approval))
  ) {
    throw new Error("Hatch Runtime emitted an invalid local tool request");
  }
  if (!LOCAL_TOOLS.includes(message.name as ClientToolName)) {
    throw new Error(`Hatch Runtime requested an unadvertised local tool: ${message.name}`);
  }
  return message as unknown as ToolRequest;
}

async function resolveLocalRunnerBinary(environment: NodeJS.ProcessEnv): Promise<string> {
  const explicit = environment.HATCH_LOCAL_RUNNER_BIN?.trim();
  if (explicit) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
    if (await isExecutableFile(candidate)) return candidate;
    throw new Error(`HATCH_LOCAL_RUNNER_BIN is not an executable file: ${candidate}`);
  }

  const executableName = process.platform === "win32" ? "hatch-local-runner.exe" : "hatch-local-runner";
  for (const directory of (environment.PATH ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executableName);
    if (await isExecutableFile(candidate)) return candidate;
  }

  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  for (const profile of ["release", "debug"]) {
    const candidate = path.resolve(moduleDirectory, "../../local-runner/target", profile, executableName);
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    "Hatch LocalRunner is unavailable; install hatch-local-runner on PATH, set HATCH_LOCAL_RUNNER_BIN, or build local-runner"
  );
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return false;
    await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function localRunnerEnvironment(environment: NodeJS.ProcessEnv, tempRoot: string): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {
    PATH: environment.PATH ?? process.env.PATH,
    TMPDIR: tempRoot
  };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT", "WINDIR"]) {
    if (environment[key] !== undefined) selected[key] = environment[key];
  }
  return selected;
}

function localToolCallKey(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sendSocketJson(socket: WebSocket, message: unknown): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Hatch Runtime connection closed before the local tool result was delivered"));
  }
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(message), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
  requireUuidV4(input.creatorId, "creatorId");
  requireUuidV4(input.agentId, "agentId/productId");
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
