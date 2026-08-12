import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactRef,
  FactoryExecutionMetadata,
  FactoryPromptFailureTelemetry,
  FactoryExecutionStatus,
  FactoryExecutionTiming,
  FactoryRunState
} from "./types.js";

export class FactoryFileStore {
  readonly runId: string;
  private readonly runDirectory: string;

  constructor(
    private readonly root: string,
    runId?: string,
    private readonly beforeCommit?: () => Promise<void>,
    readonly signal?: AbortSignal
  ) {
    this.runId = runId ?? randomUUID();
    this.runDirectory = containedPath(root, this.runId);
  }

  get directory(): string {
    return this.runDirectory;
  }

  get statePath(): string {
    return path.join(this.runDirectory, "state.json");
  }

  async initialize(): Promise<void> {
    await this.guardCommit();
    await mkdir(this.root, { recursive: true });
    await this.guardCommit();
    try {
      // This directory creation is the run-id ownership boundary. Recursive
      // mkdir would silently reuse and overwrite an existing or partial run.
      await mkdir(this.runDirectory);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new Error(`Factory run ${this.runId} already exists; refusing to overwrite its directory`);
      }
      throw error;
    }
    await mkdir(path.join(this.runDirectory, "artifacts"), { recursive: true });
    await mkdir(path.join(this.runDirectory, "sealed"), { recursive: true });
    await mkdir(path.join(this.runDirectory, "candidate"), { recursive: true });
  }

  /**
   * Persist `running` before an external execution starts. The returned record
   * is also the opaque settlement handle; every attempt receives a fresh id.
   */
  async beginExecution(input: {
    startedAt: string;
    sealed: boolean;
    metadata: FactoryExecutionMetadata;
  }): Promise<FactoryExecutionTiming> {
    const timing: FactoryExecutionTiming = {
      contractVersion: "1",
      executionId: randomUUID(),
      runId: this.runId,
      status: "running",
      startedAt: input.startedAt,
      sealed: input.sealed,
      metadata: input.metadata
    };
    validateExecutionTiming(timing);
    await this.writeExecutionTiming(timing, false);
    return timing;
  }

  /**
   * Atomically replace a running sidecar after the call settles. An aborted
   * signal does not itself block this final write: the lease fence still runs,
   * so a stale worker cannot settle an execution after losing ownership.
   */
  async settleExecution(
    running: FactoryExecutionTiming,
    settlement: {
      status: Exclude<FactoryExecutionStatus, "running">;
      completedAt: string;
      elapsedMs: number;
      failureTelemetry?: FactoryPromptFailureTelemetry;
    }
  ): Promise<FactoryExecutionTiming> {
    if (running.runId !== this.runId || running.status !== "running") {
      throw new Error("Factory execution settlement requires this run's running sidecar");
    }
    const current = await this.readExecutionTiming(running.executionId, running.sealed);
    if (current.status !== "running" || current.executionId !== running.executionId) {
      throw new Error(`Factory execution ${running.executionId} is no longer running`);
    }
    const settled: FactoryExecutionTiming = {
      ...current,
      status: settlement.status,
      completedAt: settlement.completedAt,
      elapsedMs: settlement.elapsedMs,
      ...(settlement.failureTelemetry ? { failureTelemetry: settlement.failureTelemetry } : {})
    };
    validateExecutionTiming(settled);
    await this.writeExecutionTiming(settled, true);
    return settled;
  }

  async listExecutionTimings(): Promise<FactoryExecutionTiming[]> {
    const rows = (await Promise.all([
      this.listExecutionNamespace(false),
      this.listExecutionNamespace(true)
    ])).flat();
    return rows.sort((left, right) => (
      left.startedAt.localeCompare(right.startedAt)
      || left.executionId.localeCompare(right.executionId)
    ));
  }

  async writeArtifact(relativePath: string, content: string, sealed = false): Promise<ArtifactRef> {
    const namespace = sealed ? "sealed" : "artifacts";
    const relative = path.posix.join(namespace, safeRelative(relativePath));
    const destination = containedPath(this.runDirectory, relative);
    await this.guardCommit();
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, content);
    return {
      path: relative,
      sha256: sha256(content),
      createdAt: new Date().toISOString(),
      ...(sealed ? { sealed: true as const } : {})
    };
  }

  async writeCandidate(relativePath: string, content: string): Promise<ArtifactRef> {
    const relative = path.posix.join("candidate", safeRelative(relativePath));
    const destination = containedPath(this.runDirectory, relative);
    await this.guardCommit();
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, content);
    return { path: relative, sha256: sha256(content), createdAt: new Date().toISOString() };
  }

  async readArtifact(reference: ArtifactRef): Promise<string> {
    const content = await readFile(containedPath(this.runDirectory, reference.path), "utf8");
    if (sha256(content) !== reference.sha256) throw new Error(`Artifact digest mismatch: ${reference.path}`);
    return content;
  }

  async saveState(state: FactoryRunState): Promise<void> {
    const updated = { ...state, updatedAt: new Date().toISOString() };
    await this.guardCommit();
    await atomicWrite(this.statePath, `${JSON.stringify(updated, null, 2)}\n`);
  }

  async loadState(): Promise<FactoryRunState> {
    const state = JSON.parse(await readFile(this.statePath, "utf8")) as FactoryRunState;
    // Runs created before canonical Agent Corpus packaging did not persist an
    // agent/product identity. Upgrade them deterministically at the storage
    // boundary so resume/retry can still reach the same verified ready gate.
    if (!state.agentId) {
      state.agentId = `agent-${createHash("sha256")
        .update(`${state.creator.id}\u0000${state.taskName.trim()}`)
        .digest("hex")
        .slice(0, 16)}`;
    }
    if (!state.product) {
      state.product = { id: state.agentId, name: state.taskName };
    }
    return state;
  }

  async recordEvent(event: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.guardCommit();
    try {
      await mkdir(this.runDirectory, { recursive: true });
      await appendFile(path.join(this.runDirectory, "events.jsonl"), `${JSON.stringify({
        at: new Date().toISOString(),
        event,
        ...details
      })}\n`, "utf8");
    } catch {
      // state.json and content-addressed artifacts are the recovery truth.
      // A diagnostic journal append must never turn an already valid
      // waiting/ready checkpoint into an unrecoverable workflow failure.
    }
  }

  private async guardCommit(): Promise<void> {
    if (this.signal?.aborted) throw abortError(this.signal);
    await this.beforeCommit?.();
    if (this.signal?.aborted) throw abortError(this.signal);
  }

  private async writeExecutionTiming(timing: FactoryExecutionTiming, settling: boolean): Promise<void> {
    if (settling) {
      // Do not consult signal here: an explicitly cancelled call still needs
      // an `aborted` settlement. The ownership/lease fence remains mandatory.
      await this.beforeCommit?.();
    } else {
      await this.guardCommit();
    }
    const destination = this.executionTimingPath(timing.executionId, timing.sealed);
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, `${JSON.stringify(timing, null, 2)}\n`);
  }

  private async readExecutionTiming(executionId: string, sealed: boolean): Promise<FactoryExecutionTiming> {
    const parsed = JSON.parse(await readFile(this.executionTimingPath(executionId, sealed), "utf8")) as unknown;
    return validateExecutionTiming(parsed);
  }

  private async listExecutionNamespace(sealed: boolean): Promise<FactoryExecutionTiming[]> {
    const directory = path.dirname(this.executionTimingPath("placeholder", sealed));
    let names: string[];
    try {
      names = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissingPath(error)) return [];
      throw error;
    }
    return Promise.all(names.map(async (name) => {
      const executionId = name.slice(0, -".json".length);
      const timing = await this.readExecutionTiming(executionId, sealed);
      if (timing.sealed !== sealed) {
        throw new Error(`Factory execution timing namespace mismatch: ${name}`);
      }
      return timing;
    }));
  }

  private executionTimingPath(executionId: string, sealed: boolean): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(executionId)) {
      throw new Error(`Invalid Factory execution id: ${executionId}`);
    }
    return containedPath(
      this.runDirectory,
      path.posix.join(sealed ? "sealed" : "artifacts", "executions", `${executionId}.json`)
    );
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Creator Factory execution was aborted");
}

async function atomicWrite(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, destination);
}

function safeRelative(value: string): string {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Factory artifact path must be a safe relative path: ${value}`);
  }
  return value.replaceAll("\\", "/");
}

function containedPath(root: string, relative: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, safeRelative(relative));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Factory path escapes its root: ${relative}`);
  }
  return resolved;
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function validateExecutionTiming(value: unknown): FactoryExecutionTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Factory execution timing sidecar");
  }
  const row = value as Record<string, unknown>;
  const status = row.status;
  const metadata = row.metadata;
  if (
    row.contractVersion !== "1"
    || typeof row.executionId !== "string"
    || typeof row.runId !== "string"
    || !["running", "completed", "failed", "aborted"].includes(String(status))
    || typeof row.startedAt !== "string"
    || typeof row.sealed !== "boolean"
    || !metadata
    || typeof metadata !== "object"
    || Array.isArray(metadata)
  ) {
    throw new Error("Invalid Factory execution timing sidecar");
  }
  const allowedTopLevel = new Set([
    "contractVersion",
    "executionId",
    "runId",
    "status",
    "startedAt",
    "completedAt",
    "elapsedMs",
    "sealed",
    "metadata",
    "failureTelemetry"
  ]);
  if (Object.keys(row).some((key) => !allowedTopLevel.has(key))) {
    throw new Error("Invalid Factory execution timing sidecar field");
  }
  const details = metadata as Record<string, unknown>;
  const validMetadata = details.boundary === "factory_llm"
    ? (
      ["evidence.extract", "eval.generate_questions", "eval.judge_result", "eval.audit_corpus", "corpus.compile"]
        .includes(String(details.purpose))
      && typeof details.promptVersion === "string"
      && typeof details.provider === "string"
      && typeof details.model === "string"
      && Object.keys(details).every((key) => ["boundary", "purpose", "promptVersion", "provider", "model"].includes(key))
    )
    : (
      details.boundary === "hatch_product_runtime"
      && details.purpose === "hatch.candidate"
      && Number.isInteger(details.corpusVersion)
      && typeof details.corpusDigest === "string"
      && Object.keys(details).every((key) => ["boundary", "purpose", "corpusVersion", "corpusDigest"].includes(key))
    );
  if (!validMetadata) throw new Error("Invalid Factory execution timing metadata");
  const isRunning = status === "running";
  if (isRunning && (row.completedAt !== undefined || row.elapsedMs !== undefined)) {
    throw new Error("Running Factory execution timing cannot contain a completion");
  }
  if (!isRunning && (
    typeof row.completedAt !== "string"
    || typeof row.elapsedMs !== "number"
    || !Number.isFinite(row.elapsedMs)
    || row.elapsedMs < 0
  )) {
    throw new Error("Settled Factory execution timing requires a non-negative elapsedMs");
  }
  if (row.failureTelemetry !== undefined) {
    if (
      details.boundary !== "factory_llm"
      || (status !== "failed" && status !== "aborted")
    ) {
      throw new Error("Factory failure telemetry is only valid for failed/aborted Factory LLM executions");
    }
    validateFailureTelemetry(row.failureTelemetry);
  }
  return value as FactoryExecutionTiming;
}

const SUBMISSION_TOOL_NAMES = new Set([
  "restart_submission",
  "submit_evidence_section",
  "finalize_evidence",
  "submit_question",
  "finalize_questions",
  "submit_evaluation",
  "finalize_evaluation",
  "submit_corpus_audit",
  "finalize_corpus_audit",
  "submit_system_instructions",
  "submit_skill",
  "submit_reference",
  "submit_knowledge",
  "submit_corpus_audit_section",
  "finalize_corpus"
]);

function validateFailureTelemetry(value: unknown): asserts value is FactoryPromptFailureTelemetry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Factory failure telemetry");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "contractVersion",
    "code",
    "turnsObserved",
    "toolTurnsObserved",
    "toolCallsRequested",
    "toolResultsObserved",
    "toolErrorsObserved",
    "exactCycleKind",
    "lastToolTurn"
  ]);
  const codes = new Set([
    "provider_incomplete",
    "provider_quota",
    "provider_error",
    "aborted",
    "exact_submission_cycle",
    "stopped_without_finalize",
    "submission_protocol_error",
    "unknown"
  ]);
  if (
    row.contractVersion !== "1"
    || typeof row.code !== "string"
    || !codes.has(row.code)
    || Object.keys(row).some((key) => !allowed.has(key))
  ) {
    throw new Error("Invalid Factory failure telemetry envelope");
  }
  const counters = [
    row.turnsObserved,
    row.toolTurnsObserved,
    row.toolCallsRequested,
    row.toolResultsObserved,
    row.toolErrorsObserved
  ];
  if (counters.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)) {
    throw new Error("Invalid Factory failure telemetry counter");
  }
  if (
    Number(row.toolTurnsObserved) > Number(row.turnsObserved)
    || Number(row.toolResultsObserved) > Number(row.toolCallsRequested)
    || Number(row.toolErrorsObserved) > Number(row.toolResultsObserved)
  ) {
    throw new Error("Inconsistent Factory failure telemetry counters");
  }
  const cycleKinds = new Set([
    "missing_finalizer",
    "repeated_final_validation",
    "repeated_batch_error",
    "repeated_no_progress"
  ]);
  if (
    (row.exactCycleKind !== undefined && !cycleKinds.has(String(row.exactCycleKind)))
    || (row.code === "exact_submission_cycle" && !cycleKinds.has(String(row.exactCycleKind)))
    || (row.code !== "exact_submission_cycle" && row.exactCycleKind !== undefined)
  ) {
    throw new Error("Invalid Factory exact-cycle telemetry");
  }
  if (row.lastToolTurn === undefined) return;
  if (!row.lastToolTurn || typeof row.lastToolTurn !== "object" || Array.isArray(row.lastToolTurn)) {
    throw new Error("Invalid Factory last tool-turn telemetry");
  }
  const last = row.lastToolTurn as Record<string, unknown>;
  const allowedLast = new Set([
    "callsRequested",
    "results",
    "errors",
    "accepted",
    "idempotent",
    "rejected",
    "toolNames",
    "finalizerOutcome",
    "finalizerPosition",
    "transaction"
  ]);
  const lastCounters = [last.callsRequested, last.results, last.errors, last.accepted, last.idempotent, last.rejected];
  if (
    Object.keys(last).some((key) => !allowedLast.has(key))
    || lastCounters.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)
    || Number(last.results) > Number(last.callsRequested)
    || Number(last.errors) > Number(last.results)
    || Number(last.accepted) + Number(last.idempotent) + Number(last.rejected) > Number(last.results)
    || !Array.isArray(last.toolNames)
    || last.toolNames.length > SUBMISSION_TOOL_NAMES.size
    || new Set(last.toolNames).size !== last.toolNames.length
    || last.toolNames.some((name) => typeof name !== "string" || !SUBMISSION_TOOL_NAMES.has(name))
    || !["absent", "accepted", "rejected", "error"].includes(String(last.finalizerOutcome))
    || !["absent", "last", "not_last", "multiple"].includes(String(last.finalizerPosition))
    || !["finalized", "cleared", "rolled_back", "no_draft"].includes(String(last.transaction))
  ) {
    throw new Error("Invalid Factory last tool-turn telemetry fields");
  }
}

function isMissingPath(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
