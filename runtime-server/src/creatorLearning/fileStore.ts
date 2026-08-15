import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { isObjectStoreNotFound, type ArtifactObjectStore } from "./objectStore.js";
import { graphEventKey, newGraphEventId, type DistillationGraphStore, type DistillationEventType, type DistillationNodeKind } from "./distillationGraph.js";
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
  private readonly objectStore?: ArtifactObjectStore;
  private readonly objectPrefix: string;
  private readonly graphStore?: DistillationGraphStore;
  private readonly graphContext?: { taskId?: string; runId?: string; revisionId?: string };

  constructor(
    private readonly root: string,
    runId?: string,
    private readonly beforeCommit?: () => Promise<void>,
    readonly signal?: AbortSignal,
    options: {
      objectStore?: ArtifactObjectStore;
      objectPrefix?: string;
      graphStore?: DistillationGraphStore;
      graphContext?: { taskId?: string; runId?: string; revisionId?: string };
    } = {}
  ) {
    this.runId = runId ?? randomUUID();
    this.runDirectory = containedPath(root, this.runId);
    this.objectStore = options.objectStore;
    this.objectPrefix = options.objectPrefix ?? `factory-runs/${this.runId}`;
    this.graphStore = options.graphStore;
    this.graphContext = options.graphContext;
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

  /**
   * Recover timing records left running after the previous CLI process died.
   * Their real monotonic duration is unknowable, so never manufacture one.
   */
  async abandonRunningExecutions(completedAt: string): Promise<number> {
    const rows = await this.listExecutionTimings();
    let abandoned = 0;
    for (const row of rows) {
      if (row.status !== "running") continue;
      const current = await this.readExecutionTiming(row.executionId, row.sealed);
      if (current.status !== "running") continue;
      const recovered: FactoryExecutionTiming = {
        ...current,
        status: "abandoned",
        completedAt
      };
      validateExecutionTiming(recovered);
      await this.writeExecutionTiming(recovered, true);
      abandoned += 1;
    }
    return abandoned;
  }

  async writeArtifact(relativePath: string, content: string, sealed = false): Promise<ArtifactRef> {
    const namespace = sealed ? "sealed" : "artifacts";
    const relative = path.posix.join(namespace, safeRelative(relativePath));
    const destination = containedPath(this.runDirectory, relative);
    await this.guardCommit();
    const bytes = Buffer.from(content, "utf8");
    await this.persistObject(relative, bytes, "text/plain; charset=utf-8");
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, content);
    const reference: ArtifactRef = {
      path: relative,
      sha256: sha256(content),
      createdAt: new Date().toISOString(),
      ...(sealed ? { sealed: true as const } : {})
    };
    await this.registerGraphArtifact(reference, "text/plain; charset=utf-8");
    return reference;
  }

  async writeCandidate(relativePath: string, content: string): Promise<ArtifactRef> {
    const relative = path.posix.join("candidate", safeRelative(relativePath));
    const destination = containedPath(this.runDirectory, relative);
    await this.guardCommit();
    const bytes = Buffer.from(content, "utf8");
    await this.persistObject(relative, bytes, "text/plain; charset=utf-8");
    await mkdir(path.dirname(destination), { recursive: true });
    await atomicWrite(destination, content);
    const reference: ArtifactRef = { path: relative, sha256: sha256(content), createdAt: new Date().toISOString() };
    await this.registerGraphArtifact(reference, "text/plain; charset=utf-8");
    return reference;
  }

  async readArtifact(reference: ArtifactRef): Promise<string> {
    const content = (await this.readLocalOrObject(reference.path)).toString("utf8");
    if (sha256(content) !== reference.sha256) throw new Error(`Artifact digest mismatch: ${reference.path}`);
    return content;
  }

  async saveState(state: FactoryRunState): Promise<void> {
    const updated = { ...state, updatedAt: new Date().toISOString() };
    await this.guardCommit();
    const content = `${JSON.stringify(updated, null, 2)}\n`;
    await this.persistObject("state.json", Buffer.from(content, "utf8"), "application/json; charset=utf-8", true);
    await mkdir(this.runDirectory, { recursive: true });
    await atomicWrite(this.statePath, content);
  }

  async loadState(): Promise<FactoryRunState> {
    const state = JSON.parse((await this.readLocalOrObject("state.json")).toString("utf8")) as FactoryRunState;
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
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details
    })}\n`;
    try {
      await mkdir(this.runDirectory, { recursive: true });
      await appendFile(path.join(this.runDirectory, "events.jsonl"), line, "utf8");
      if (this.objectStore) {
        const current = await this.readObjectText("events.jsonl").catch(() => "");
        await this.persistObject("events.jsonl", Buffer.from(`${current}${line}`, "utf8"), "application/x-ndjson", true);
      }
    } catch {
      // state.json and content-addressed artifacts are the recovery truth.
      // A diagnostic journal append must never turn an already valid
      // waiting/ready checkpoint into an unrecoverable workflow failure.
    }
    await this.recordGraphEvent(event, details);
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
    const content = `${JSON.stringify(timing, null, 2)}\n`;
    await this.persistObject(path.relative(this.runDirectory, destination), Buffer.from(content, "utf8"), "application/json; charset=utf-8", true);
    await atomicWrite(destination, content);
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

  /** Hydrate an object-store-backed artifact into the local execution cache. */
  async hydrate(relativePath: string): Promise<string> {
    const bytes = await this.readLocalOrObject(relativePath);
    return containedPath(this.runDirectory, relativePath);
  }

  private async readLocalOrObject(relativePath: string): Promise<Buffer> {
    const local = containedPath(this.runDirectory, relativePath);
    try {
      return await readFile(local);
    } catch (error) {
      if (!this.objectStore || !isMissingPath(error)) throw error;
      let bytes: Buffer;
      try {
        bytes = await this.objectStore.get(this.objectKey(relativePath));
      } catch (error) {
        // A brand-new run has no remote state yet. OSS reports that absence
        // as NoSuchKey/404 rather than Node's ENOENT; normalize it so the
        // worker can take the create path instead of retrying forever.
        if (!isObjectStoreNotFound(error)) throw error;
        const missing = new Error(`Factory artifact is missing: ${relativePath}`);
        Object.assign(missing, { code: "ENOENT" });
        throw missing;
      }
      await mkdir(path.dirname(local), { recursive: true });
      await atomicWrite(local, bytes);
      return bytes;
    }
  }

  private async persistObject(
    relativePath: string,
    bytes: Buffer,
    contentType: string,
    mutable = false
  ): Promise<void> {
    if (!this.objectStore) return;
    // State/timing files are mutable projections. Content artifacts use stable
    // paths and the object-store adapter enforces same-bytes idempotency.
    await this.objectStore.put(this.objectKey(relativePath), bytes, {
      contentType,
      immutable: !mutable,
      metadata: { "hatch-mutable": mutable ? "true" : "false" }
    });
  }

  private async registerGraphArtifact(reference: ArtifactRef, mediaType: string): Promise<void> {
    const context = await this.resolveGraphContext();
    if (!this.graphStore || !context?.taskId || !context.runId) return;
    const artifactId = artifactIdentity(this.runId, reference.path, reference.sha256);
    reference.artifactId = artifactId;
    await this.graphStore.registerArtifact({
      artifactId,
      taskId: context.taskId,
      runId: context.runId,
      ...(context.revisionId ? { revisionId: context.revisionId } : {}),
      kind: artifactKind(reference.path),
      objectKey: this.objectKey(reference.path),
      sha256: reference.sha256,
      bytes: Buffer.byteLength(await this.readLocalOrObject(reference.path)),
      mediaType,
      createdAt: reference.createdAt
    });
    const parents = (await this.graphStore.listEvents(context.taskId)).filter((event) => event.runId === context.runId).at(-1);
    await this.graphStore.appendEvent({
      id: newGraphEventId(),
      eventKey: `artifact:${artifactId}`,
      taskId: context.taskId,
      runId: context.runId,
      ...(context.revisionId ? { revisionId: context.revisionId } : {}),
      type: "artifact_emitted",
      node: nodeForArtifact(reference.path),
      actor: "worker",
      parentEventIds: parents ? [parents.id] : [],
      artifactIds: [artifactId],
      payload: { path: reference.path, sealed: Boolean(reference.sealed) }
    });
  }

  private async recordGraphEvent(event: string, details: Record<string, unknown>): Promise<void> {
    const context = await this.resolveGraphContext();
    if (!this.graphStore || !context?.taskId || !context.runId) return;
    const mapped = mapGraphEvent(event, details);
    if (!mapped) return;
    const parents = (await this.graphStore.listEvents(context.taskId)).filter((row) => row.runId === context.runId).at(-1);
    const payload = sanitizeGraphPayload(details);
    const eventKey = graphEventKey(mapped.type, context.runId, context.revisionId, { event, payload });
    const graphEvent = await this.graphStore.appendEvent({
      id: newGraphEventId(),
      eventKey,
      taskId: context.taskId,
      runId: context.runId,
      ...(context.revisionId ? { revisionId: context.revisionId } : {}),
      type: mapped.type,
      ...(mapped.node ? { node: mapped.node } : {}),
      actor: event.startsWith("creator_") ? "creator" : "worker",
      parentEventIds: parents ? [parents.id] : [],
      artifactIds: collectArtifactIds(details),
      payload
    });
    if (mapped.node && ["node_started", "node_completed", "node_failed"].includes(mapped.type) && context.revisionId) {
      const status = mapped.type === "node_started"
        ? "running"
        : mapped.type === "node_completed" ? "completed" : "failed";
      const startedAt = typeof details.startedAt === "string"
        ? details.startedAt
        : status === "running" ? graphEvent.occurredAt : undefined;
      const completedAt = typeof details.completedAt === "string"
        ? details.completedAt
        : status === "running" ? undefined : graphEvent.occurredAt;
      await this.graphStore.recordNodeExecution({
        id: `node_exec_${graphEvent.id}`,
        taskId: context.taskId,
        runId: context.runId,
        revisionId: context.revisionId,
        node: mapped.node,
        attempt: positiveInteger(details.attempt) ?? 1,
        status,
        inputArtifactIds: stringList(details.inputArtifactIds ?? details.input_artifact_ids),
        outputArtifactIds: collectArtifactIds(details),
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...(typeof details.errorCode === "string" ? { errorCode: details.errorCode } : {})
      });
    }
    const gate = gateForGraphEvent(event, mapped.type, mapped.node, details);
    if (gate) {
      const evidenceArtifactIds = collectArtifactIds(details);
      await this.graphStore.recordGate({
        ...gate,
        id: `gate_${graphEvent.id}`,
        gateKey: `${context.revisionId ?? this.runId}:${gate.name}`,
        taskId: context.taskId,
        runId: context.runId,
        revisionId: context.revisionId ?? this.runId,
        evidenceArtifactIds,
        assessedAt: graphEvent.occurredAt
      });
      await this.graphStore.appendEvent({
        id: newGraphEventId(),
        eventKey: `${eventKey}:gate:${gate.name}`,
        taskId: context.taskId,
        runId: context.runId,
        ...(context.revisionId ? { revisionId: context.revisionId } : {}),
        type: "gate_assessed",
        ...(mapped.node ? { node: mapped.node } : {}),
        actor: "system",
        parentEventIds: [graphEvent.id],
        artifactIds: evidenceArtifactIds,
        payload: { name: gate.name, critical: gate.critical, status: gate.status }
      });
    }
    if (event === "creator_answers_submitted" || event === "factory_retry_requested") {
      const rows = (await this.graphStore.listEvents(context.taskId))
        .filter((row) => row.runId === context.runId && (!context.revisionId || row.revisionId === context.revisionId));
      const requested = rows.filter((row) => row.type === "correction_requested").at(-1);
      const submitted = rows.filter((row) => row.type === "correction_submitted").at(-1);
      if (requested && (!submitted || requested.sequence > submitted.sequence)) {
        await this.graphStore.appendEvent({
          id: newGraphEventId(),
          eventKey: `${context.runId}:${context.revisionId ?? "legacy"}:correction_submitted:${requested.id}`,
          taskId: context.taskId,
          runId: context.runId,
          ...(context.revisionId ? { revisionId: context.revisionId } : {}),
          type: "correction_submitted",
          node: "calibration",
          actor: event === "creator_answers_submitted" ? "creator" : "worker",
          parentEventIds: [graphEvent.id],
          artifactIds: collectArtifactIds(details),
          payload: { correctionRequestEventId: requested.id }
        });
      }
    }
    if (event === "heldout_evaluated" && details.nextStage === "review_required") {
      await this.graphStore.appendEvent({
        id: newGraphEventId(),
        eventKey: `${eventKey}:correction_requested`,
        taskId: context.taskId,
        runId: context.runId,
        ...(context.revisionId ? { revisionId: context.revisionId } : {}),
        type: "correction_requested",
        node: "calibration",
        actor: "system",
        parentEventIds: [graphEvent.id],
        artifactIds: collectArtifactIds(details),
        payload: { kind: "heldout_failure", failedCount: details.failures ?? 0 }
      });
    }
    if (event === "heldout_evaluated" && details.nextStage === "ready") {
      await this.graphStore.appendEvent({
        id: newGraphEventId(),
        eventKey: `${eventKey}:revision_ready`,
        taskId: context.taskId,
        runId: context.runId,
        ...(context.revisionId ? { revisionId: context.revisionId } : {}),
        type: "revision_ready",
        node: "release",
        actor: "worker",
        parentEventIds: [graphEvent.id],
        artifactIds: collectArtifactIds(details),
        payload: { reason: "heldout_passed" }
      });
    }
  }

  private async resolveGraphContext(): Promise<{ taskId?: string; runId?: string; revisionId?: string } | undefined> {
    if (this.graphContext?.taskId && this.graphContext.runId) return this.graphContext;
    if (!this.graphStore) return undefined;
    try {
      const state = JSON.parse((await this.readLocalOrObject("state.json")).toString("utf8")) as FactoryRunState;
      if (!state.taskId) return undefined;
      return { taskId: state.taskId, runId: state.distillationRunId ?? state.runId, ...(state.revisionId ? { revisionId: state.revisionId } : {}) };
    } catch {
      return undefined;
    }
  }

  private async readObjectText(relativePath: string): Promise<string> {
    if (!this.objectStore) return "";
    return (await this.objectStore.get(this.objectKey(relativePath))).toString("utf8");
  }

  private objectKey(relativePath: string): string {
    return path.posix.join(this.objectPrefix, safeRelative(relativePath));
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Creator Factory execution was aborted");
}

async function atomicWrite(destination: string, content: string | Buffer): Promise<void> {
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

function artifactIdentity(runId: string, relativePath: string, digest: string): string {
  return `art_${createHash("sha256").update(`${runId}\u0000${relativePath}\u0000${digest}`).digest("hex").slice(0, 32)}`;
}

function artifactKind(relativePath: string): import("./distillationGraph.js").ArtifactKind {
  if (relativePath.startsWith("input/")) return relativePath.includes("source") || relativePath.includes("images") ? "source_projection" : "source_snapshot";
  if (relativePath.includes("evaluations/")) return "evaluation_report";
  if (relativePath.includes("corpus") || relativePath.includes("agent-corpus")) return "corpus_bundle";
  if (relativePath.includes("creator/") || relativePath.includes("review/")) return "correction";
  if (relativePath.includes("trace") || relativePath.includes("executions/")) return "trace";
  return "llm_output";
}

function nodeForArtifact(relativePath: string): DistillationNodeKind {
  if (relativePath.includes("review/") || relativePath.includes("correction")) return "calibration";
  if (relativePath.includes("evidence")) return "evidence";
  if (relativePath.includes("question") || relativePath.includes("qa/")) return "questions";
  if (relativePath.includes("evaluation") || relativePath.includes("heldout") || relativePath.includes("regression")) return "heldout_eval";
  if (relativePath.includes("corpus") || relativePath.includes("candidate")) return "corpus";
  if (relativePath.startsWith("input/")) return "intake";
  return "corpus";
}

function mapGraphEvent(event: string, details: Record<string, unknown>): { type: DistillationEventType; node?: DistillationNodeKind } | undefined {
  if (event === "factory_started") return { type: "run_created", node: "intake" };
  if (event === "creator_answers_requested") return { type: "creator_answers_requested", node: "questions" };
  if (event === "creator_answers_submitted") return { type: "creator_answers_submitted", node: "calibration" };
  if (event === "factory_retry_requested") return { type: "node_started", node: nodeForStage(details.stage) };
  if (event === "corpus_compiled") return { type: "node_completed", node: "corpus" };
  if (event === "corpus_completeness_failed") return { type: "node_failed", node: "corpus" };
  if (event === "corpus_release_guard_failed" || event === "corpus_release_guard_inconclusive") return { type: "node_failed", node: "corpus" };
  if (event === "development_evaluated") return { type: "node_completed", node: "development_eval" };
  if (event === "regression_evaluated") return { type: "node_completed", node: "regression_eval" };
  if (event === "heldout_evaluated") return { type: "node_completed", node: "heldout_eval" };
  if (event === "review_recorded") return { type: "review_recorded", node: "calibration" };
  if (event === "question_rejected") return { type: "question_rejected", node: "questions" };
  if (event === "judge_disputed") return { type: "judge_disputed", node: "calibration" };
  if (event === "heldout_failure_confirmed") return { type: "heldout_failure_confirmed", node: "calibration" };
  if (event === "factory_needs_attention") return { type: "correction_requested", node: "calibration" };
  if (event === "llm_call_completed") return { type: "node_completed", node: nodeForPurpose(details.purpose) };
  return undefined;
}

function nodeForStage(value: unknown): DistillationNodeKind {
  if (value === "extracting_evidence") return "evidence";
  if (value === "awaiting_creator_answers") return "questions";
  if (value === "evaluating_development") return "development_eval";
  if (value === "evaluating_regression") return "regression_eval";
  if (value === "evaluating_heldout") return "heldout_eval";
  if (value === "review_required") return "calibration";
  return "corpus";
}

function nodeForPurpose(value: unknown): DistillationNodeKind {
  if (String(value).startsWith("evidence")) return "evidence";
  if (String(value).includes("question")) return "questions";
  if (String(value).includes("eval")) return "development_eval";
  return "corpus";
}

function gateForGraphEvent(event: string, type: DistillationEventType, node: DistillationNodeKind | undefined, details: Record<string, unknown>): { name: import("./distillationGraph.js").QualityGateAssessment["name"]; critical: boolean; status: "passed" | "failed" | "blocked"; reason?: string } | undefined {
  const name = node === "development_eval" ? "development"
    : node === "regression_eval" ? "regression"
      : node === "heldout_eval" ? "heldout"
        : event === "corpus_completeness_failed" ? "completeness"
          : undefined;
  if (!name) return undefined;
  const failures = Number(details.failures ?? 0);
  const failed = type === "node_failed" || type === "correction_requested" || failures > 0;
  return {
    name,
    critical: true,
    status: failed ? "failed" : "passed",
    ...(failed ? { reason: typeof details.diagnosis === "string" ? details.diagnosis : `${name} gate failed` } : {})
  };
}

function collectArtifactIds(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const row = item as Record<string, unknown>;
    if (typeof row.artifactId === "string") found.add(row.artifactId);
    Object.values(row).forEach(visit);
  };
  visit(value);
  return [...found];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sanitizeGraphPayload(details: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set(["error", "raw", "content", "answer", "answers", "prompt", "result", "diagnosis"]);
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (blocked.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) copy[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null)) copy[key] = value;
  }
  return copy;
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
    || !["running", "completed", "failed", "aborted", "abandoned"].includes(String(status))
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
  const isAbandoned = status === "abandoned";
  if (isRunning && (row.completedAt !== undefined || row.elapsedMs !== undefined)) {
    throw new Error("Running Factory execution timing cannot contain a completion");
  }
  if (isAbandoned && (typeof row.completedAt !== "string" || row.elapsedMs !== undefined)) {
    throw new Error("Abandoned Factory execution timing requires completedAt and no invented elapsedMs");
  }
  if (!isRunning && !isAbandoned && (
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
    "finalizerValidationCode",
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
    || (last.finalizerValidationCode !== undefined
      && !/^[A-Z][A-Z0-9_]{0,63}$/.test(String(last.finalizerValidationCode)))
    || !["absent", "last", "not_last", "multiple"].includes(String(last.finalizerPosition))
    || !["finalized", "retained", "cleared", "rolled_back", "no_draft"].includes(String(last.transaction))
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
