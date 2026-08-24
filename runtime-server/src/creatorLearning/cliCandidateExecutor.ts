import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HatchHarnessCliInput, HatchHarnessCliResult } from "../hatchHarnessCli.js";
import type { HatchCandidateExecutor } from "./types.js";

const MAX_CHILD_STDOUT_BYTES = 18 * 1024 * 1024;
const MAX_CHILD_STDERR_BYTES = 2 * 1024 * 1024;

export type HatchCliCandidateExecutorOptions = {
  cliPath?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
};

/** Spawn the one-shot wrapper; the child itself reuses the full Hatch Runtime. */
export function createHatchCliCandidateExecutor(
  options: HatchCliCandidateExecutorOptions = {}
): HatchCandidateExecutor {
  // The child runs from a hermetic working directory. Resolve an optional
  // relative wrapper while it still has the Factory worker's cwd.
  const cliPath = path.resolve(options.cliPath ?? fileURLToPath(new URL("../hatchHarnessCli.js", import.meta.url)));
  return async (execution) => {
    if (execution.signal?.aborted) throw abortError(execution.signal);
    const input: HatchHarnessCliInput = {
      corpusRoot: execution.agentCorpusRoot,
      creatorId: execution.creatorId,
      agentId: execution.agentId,
      corpusDigest: execution.corpusDigest,
      question: execution.question,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    };
    const result = await runChild(cliPath, input, execution.signal, options.environment);
    return {
      output: result.output,
      runtimeRunId: result.runId,
      corpusDigest: result.corpusDigest,
      finishReason: result.finishReason,
      terminalStatus: result.terminalStatus,
      protocolEvents: result.protocolEvents,
      protocolTraceTruncated: result.protocolTraceTruncated
    };
  };
}

async function runChild(
  cliPath: string,
  input: HatchHarnessCliInput,
  signal?: AbortSignal,
  environment: NodeJS.ProcessEnv = process.env
): Promise<HatchHarnessCliResult> {
  const ownedTempRoot = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-child-"));
  try {
    // index.ts imports the root env loader. Pin it to an owned empty file so neither
    // the worker's cwd nor an inherited DOTENV_CONFIG_PATH can restore a
    // deployment connection after the environment below has removed it.
    const safeDotenvPath = path.join(ownedTempRoot, "factory-child.env");
    await writeFile(safeDotenvPath, "", { encoding: "utf8", flag: "wx" });
    return await runChildProcess(cliPath, input, signal, environment, ownedTempRoot, safeDotenvPath);
  } finally {
    // Parent owns this outer directory, so even SIGKILL cannot strand the
    // child's nested hatch-full-harness-* snapshot.
    await rm(ownedTempRoot, { recursive: true, force: true });
  }
}

async function runChildProcess(
  cliPath: string,
  input: HatchHarnessCliInput,
  signal: AbortSignal | undefined,
  environment: NodeJS.ProcessEnv,
  ownedTempRoot: string,
  safeDotenvPath: string
): Promise<HatchHarnessCliResult> {
  return new Promise<HatchHarnessCliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ownedTempRoot,
      env: isolatedChildEnvironment(environment, ownedTempRoot, safeDotenvPath)
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let hardKill: NodeJS.Timeout | undefined;
    let wallClock: NodeJS.Timeout | undefined;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (hardKill) clearTimeout(hardKill);
      if (wallClock) clearTimeout(wallClock);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    wallClock = setTimeout(onAbort, (input.timeoutMs ?? 15 * 60_000) + 10_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CHILD_STDOUT_BYTES) {
        child.kill("SIGKILL");
        return fail(new Error("Factory Hatch harness stdout exceeded the limit"));
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_CHILD_STDERR_BYTES) stderr.push(chunk);
    });
    child.once("error", fail);
    child.once("close", (code, terminationSignal) => {
      if (settled) return;
      if (signal?.aborted) return fail(abortError(signal));
      let payload: { ok?: boolean; error?: string } | HatchHarnessCliResult;
      try {
        payload = JSON.parse(Buffer.concat(stdout).toString("utf8").trim()) as typeof payload;
      } catch {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        return fail(new Error(`Factory Hatch harness returned invalid JSON${diagnostic ? `: ${diagnostic}` : ""}`));
      }
      if (code !== 0 || !isHarnessSuccess(payload)) {
        return fail(new Error(
          payload.ok === false && typeof payload.error === "string"
            ? payload.error
            : `Factory Hatch harness exited with ${code ?? terminationSignal ?? "unknown status"}`
        ));
      }
      if (payload.corpusDigest !== input.corpusDigest) {
        return fail(new Error("Factory Hatch harness child returned an unexpected Corpus digest"));
      }
      if (!payload.output.trim()) return fail(new Error("Factory Hatch harness child returned an empty result"));
      const completed = payload.protocolEvents.some((event) => event.type === "turn.completed");
      const terminal = payload.protocolEvents.some((event) => event.type === "turn.state" && event.status === "completed");
      if (!completed || !terminal) return fail(new Error("Factory Hatch harness child omitted successful Runtime terminal events"));
      settled = true;
      cleanup();
      resolve(payload);
    });
    child.stdin.on("error", (error) => fail(signal?.aborted ? abortError(signal) : error));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Creator Factory execution was aborted");
}

function isolatedChildEnvironment(
  environment: NodeJS.ProcessEnv,
  ownedTempRoot: string,
  safeDotenvPath: string
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...environment };
  // The candidate receives its binding, Corpus snapshot, transcript store,
  // and conversation repository explicitly. Never let inherited deployment
  // state redirect an eval into Registry, shared databases, commerce, or a
  // Creator tool/knowledge control plane. Runtime model and ordinary Hatch
  // server-tool credentials remain product-owned and intact. The output guard
  // is set below to off for this private, non-delivery evaluation boundary.
  const isolatedKeys = new Set([
    "HATCH_ENTITLEMENTS_FILE",
    "HATCH_AGENT_CORPUS_ROOT",
    "HATCH_RUNTIME_DATA_DIR",
    "HATCH_DELIVERY_OUTBOX_FILE",
    "HATCH_AUTH_SIGNING_SECRET",
    "HATCH_KNOWLEDGE_MODE",
    "HATCH_DASHSCOPE_API_KEY",
    "HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN",
    // Remove the obsolete near-match too; it must not hide a regression back
    // to filtering this name instead of the Registry credential above.
    "HATCH_RUNTIME_SERVICE_TOKEN",
    // Factory uses its own model process. The evaluated product Runtime must
    // select its normal K2.6 profile while retaining only the shared API
    // credential and endpoint (LLM_API_KEY and OPENAI_BASE_URL).
    "HATCH_CREATOR_MODEL",
    "HATCH_REVIEWER_MODEL",
    "HATCH_COMPACTION_MODEL"
  ]);
  for (const key of Object.keys(child)) {
    if (
      isolatedKeys.has(key)
      || key === "DATABASE_URL"
      || key.endsWith("_DATABASE_URL")
      || key.startsWith("HATCH_REGISTRY_")
      || key.startsWith("HATCH_COMMERCE_")
      || key.startsWith("HATCH_CREATOR_FACTORY_")
      || key.startsWith("HATCH_QDRANT_")
      || key.startsWith("DASHSCOPE_")
      || key === "DOTENV_KEY"
      || key.startsWith("DOTENV_CONFIG_")
    ) delete child[key];
  }
  child.TMPDIR = ownedTempRoot;
  child.PWD = ownedTempRoot;
  child.DOTENV_CONFIG_PATH = safeDotenvPath;
  child.DOTENV_CONFIG_QUIET = "true";
  // Factory candidate execution is a private evaluation boundary: its output
  // is never delivered to a buyer or persisted as a Runtime message. The
  // Alibaba output-disclosure guard belongs at the real buyer delivery
  // boundary; running it here turns a safe refusal/normal candidate response
  // into a false Factory execution failure before Eval can judge behavior.
  // Keep the full Runtime transport, model, state machine, and Corpus path,
  // but do not let delivery-only filtering become a quality gate.
  child.HATCH_OUTPUT_GUARD = "off";
  // Candidate knowledge has not been published or indexed yet. Exercise the
  // existing full Runtime against the verified staged Corpus through its
  // explicit corpus-backed knowledge adapter, without touching production
  // Qdrant namespaces or changing Runtime code.
  child.HATCH_KNOWLEDGE_MODE = "corpus-test";
  return child;
}

function isHarnessSuccess(
  value: { ok?: boolean; error?: string } | HatchHarnessCliResult
): value is HatchHarnessCliResult {
  return value.ok === true
    && typeof (value as Partial<HatchHarnessCliResult>).output === "string"
    && typeof (value as Partial<HatchHarnessCliResult>).runId === "string"
    && typeof (value as Partial<HatchHarnessCliResult>).corpusDigest === "string"
    && (value as Partial<HatchHarnessCliResult>).finishReason === "stop"
    && (value as Partial<HatchHarnessCliResult>).terminalStatus === "completed"
    && Array.isArray((value as Partial<HatchHarnessCliResult>).protocolEvents)
    && typeof (value as Partial<HatchHarnessCliResult>).protocolTraceTruncated === "boolean";
}
