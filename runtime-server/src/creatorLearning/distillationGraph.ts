import { createHash, randomUUID } from "node:crypto";

/**
 * The control-plane model for Creator Distillation.
 *
 * The worker may cache a derived state, but these four records are the
 * authority boundary:
 *   immutable artifacts -> append-only graph events -> gate assessments
 *   -> derived state
 *
 * A Run is a stable Task lineage. Every material change creates a Revision
 * under that Run and pins exactly one immutable Source Snapshot.
 */

export type DistillationNodeKind =
  | "intake"
  | "evidence"
  | "questions"
  | "calibration"
  | "corpus"
  | "development_eval"
  | "regression_eval"
  | "heldout_eval"
  | "release";

export type DistillationActor = "creator" | "worker" | "system";

export type DistillationEventType =
  | "task_created"
  | "source_uploaded"
  | "snapshot_locked"
  | "run_created"
  | "revision_created"
  | "node_started"
  | "node_completed"
  | "node_failed"
  | "artifact_emitted"
  | "creator_answers_requested"
  | "creator_answers_submitted"
  | "correction_requested"
  | "correction_submitted"
  | "gate_assessed"
  | "revision_ready"
  | "revision_rejected"
  | "run_rewound"
  | "release_created"
  | "release_withdrawn";

export type ArtifactKind =
  | "source_original"
  | "source_projection"
  | "source_snapshot"
  | "llm_output"
  | "evaluation_report"
  | "correction"
  | "corpus_bundle"
  | "release_manifest"
  | "trace";

export type ImmutableArtifactRecord = {
  artifactId: string;
  taskId: string;
  runId?: string;
  revisionId?: string;
  kind: ArtifactKind;
  objectKey: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  createdAt: string;
};

export type DistillationEvent = {
  id: string;
  eventKey: string;
  sequence: number;
  taskId: string;
  runId: string;
  revisionId?: string;
  type: DistillationEventType;
  node?: DistillationNodeKind;
  actor: DistillationActor;
  parentEventIds: string[];
  artifactIds: string[];
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type DistillationRun = {
  id: string;
  taskId: string;
  creatorId: string;
  productId?: string;
  createdAt: string;
};

export type DistillationRunRevision = {
  id: string;
  runId: string;
  taskId: string;
  revision: number;
  sourceSnapshotId: string;
  parentRevisionId?: string;
  createdAt: string;
};

export type NodeExecutionStatus = "queued" | "running" | "completed" | "failed" | "blocked";

export type DistillationNodeExecution = {
  id: string;
  taskId: string;
  runId: string;
  revisionId: string;
  node: DistillationNodeKind;
  attempt: number;
  status: NodeExecutionStatus;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  startedAt?: string;
  completedAt?: string;
  errorCode?: string;
};

export type QualityGateStatus = "pending" | "passed" | "failed" | "blocked";

export type QualityGateAssessment = {
  id: string;
  gateKey: string;
  taskId: string;
  runId: string;
  revisionId: string;
  name: "schema" | "development" | "regression" | "heldout" | "completeness" | "release";
  critical: boolean;
  status: QualityGateStatus;
  evidenceArtifactIds: string[];
  reason?: string;
  assessedAt: string;
};

export type DistillationRelease = {
  id: string;
  taskId: string;
  runId: string;
  revisionId: string;
  productId: string;
  corpusArtifactId: string;
  createdAt: string;
};

export type DistillationGraphState = {
  taskId: string;
  runId?: string;
  currentRevisionId?: string;
  currentNode?: DistillationNodeKind;
  nodeStatus: Partial<Record<DistillationNodeKind, "pending" | "running" | "completed" | "failed">>;
  gates: QualityGateAssessment[];
  criticalGateFailures: string[];
  correctionRequired: boolean;
  latestRelease?: DistillationRelease;
  status: "not_started" | "running" | "waiting_for_creator" | "needs_correction" | "ready" | "released";
};

export type RevisionContext = {
  parentRevisionId?: string;
  parentCorpusArtifactId?: string;
  currentLoopFeedbackArtifactIds: string[];
  cumulativeRegressionArtifactIds: string[];
};

export type DistillationGraphStore = {
  initialize(): Promise<void>;
  ensureRun(run: DistillationRun): Promise<DistillationRun>;
  createRevision(revision: DistillationRunRevision): Promise<DistillationRunRevision>;
  recordNodeExecution(execution: DistillationNodeExecution): Promise<DistillationNodeExecution>;
  registerArtifact(record: ImmutableArtifactRecord): Promise<ImmutableArtifactRecord>;
  getArtifact(artifactId: string): Promise<ImmutableArtifactRecord | undefined>;
  appendEvent(input: Omit<DistillationEvent, "sequence" | "occurredAt"> & { occurredAt?: string }): Promise<DistillationEvent>;
  listEvents(taskId: string): Promise<DistillationEvent[]>;
  recordGate(input: Omit<QualityGateAssessment, "assessedAt"> & { assessedAt?: string }): Promise<QualityGateAssessment>;
  listGates(revisionId: string): Promise<QualityGateAssessment[]>;
  recordRelease(release: DistillationRelease): Promise<DistillationRelease>;
  derive(taskId: string): Promise<DistillationGraphState>;
};

/** A small real in-memory implementation for deterministic unit tests. */
export class InMemoryDistillationGraphStore implements DistillationGraphStore {
  private readonly artifacts = new Map<string, ImmutableArtifactRecord>();
  private readonly events = new Map<string, DistillationEvent>();
  private readonly eventKeys = new Map<string, string>();
  private readonly gates = new Map<string, QualityGateAssessment>();
  private readonly releases = new Map<string, DistillationRelease>();
  private readonly runs = new Map<string, DistillationRun>();
  private readonly revisions = new Map<string, DistillationRunRevision>();
  private readonly executions = new Map<string, DistillationNodeExecution>();
  private sequence = 0;

  async initialize(): Promise<void> {}

  async ensureRun(run: DistillationRun): Promise<DistillationRun> {
    const existing = this.runs.get(run.id);
    if (existing) {
      // `createdAt` is an immutable fact owned by the first insertion. Later
      // revisions re-ensure the same lineage with a fresh request timestamp;
      // compare only the stable identity and return the stored record.
      assertSameJson(runIdentity(existing), runIdentity(run), `Distillation Run ${run.id} is immutable`);
      return structuredClone(existing);
    }
    const taskRun = [...this.runs.values()].find((item) => item.taskId === run.taskId);
    if (taskRun) throw new Error(`Task ${run.taskId} is already attached to another Distillation Run`);
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  async createRevision(revision: DistillationRunRevision): Promise<DistillationRunRevision> {
    const existing = this.revisions.get(revision.id);
    if (existing) { assertSameJson(existing, revision, `RunRevision ${revision.id} is immutable`); return structuredClone(existing); }
    const run = this.runs.get(revision.runId);
    if (!run || run.taskId !== revision.taskId) throw new Error(`RunRevision references an unknown Distillation Run ${revision.runId}`);
    const parent = revision.parentRevisionId ? this.revisions.get(revision.parentRevisionId) : undefined;
    if (revision.parentRevisionId && (!parent || parent.runId !== revision.runId || parent.taskId !== revision.taskId || parent.revision >= revision.revision)) {
      throw new Error(`RunRevision parent ${revision.parentRevisionId} is invalid`);
    }
    if (![...this.revisions.values()].every((item) => item.runId !== revision.runId || item.revision !== revision.revision)) throw new Error(`RunRevision ${revision.runId}/${revision.revision} already exists`);
    this.revisions.set(revision.id, structuredClone(revision));
    return structuredClone(revision);
  }

  async recordNodeExecution(execution: DistillationNodeExecution): Promise<DistillationNodeExecution> {
    const existing = this.executions.get(execution.id);
    if (existing) { assertSameJson(existing, execution, `Node execution ${execution.id} is immutable`); return structuredClone(existing); }
    const revision = this.revisions.get(execution.revisionId);
    if (!revision) throw new Error(`Node execution references unknown RunRevision ${execution.revisionId}`);
    if (revision.taskId !== execution.taskId || revision.runId !== execution.runId) throw new Error(`Node execution ${execution.id} is not attached to its RunRevision`);
    assertArtifactRefs(this.artifacts, execution.taskId, execution.revisionId, [...execution.inputArtifactIds, ...execution.outputArtifactIds]);
    this.executions.set(execution.id, structuredClone(execution));
    return structuredClone(execution);
  }

  async registerArtifact(record: ImmutableArtifactRecord): Promise<ImmutableArtifactRecord> {
    validateArtifact(record);
    const existing = this.artifacts.get(record.artifactId);
    if (existing) {
      // `createdAt` is owned by the first graph insertion. A retry may rebuild
      // the same content-addressed ArtifactRef with a fresh local timestamp;
      // that must remain an idempotent read, not a false immutability conflict.
      assertSameJson(artifactIdentity(existing), artifactIdentity(record), `Artifact ${record.artifactId} is immutable`);
      return structuredClone(existing);
    }
    if (record.runId) {
      const run = this.runs.get(record.runId);
      if (run && run.taskId !== record.taskId) throw new Error(`Artifact ${record.artifactId} belongs to another Task Run`);
    }
    if (record.revisionId) {
      const revision = this.revisions.get(record.revisionId);
      if (!revision || revision.taskId !== record.taskId || (record.runId && revision.runId !== record.runId)) {
        throw new Error(`Artifact ${record.artifactId} references an invalid RunRevision ${record.revisionId}`);
      }
    }
    const sameObject = [...this.artifacts.values()].find((item) => item.objectKey === record.objectKey);
    if (sameObject) throw new Error(`Object key ${record.objectKey} is already bound to another immutable Artifact`);
    this.artifacts.set(record.artifactId, structuredClone(record));
    return structuredClone(record);
  }

  async getArtifact(artifactId: string): Promise<ImmutableArtifactRecord | undefined> {
    const record = this.artifacts.get(artifactId);
    return record ? structuredClone(record) : undefined;
  }

  async appendEvent(input: Omit<DistillationEvent, "sequence" | "occurredAt"> & { occurredAt?: string }): Promise<DistillationEvent> {
    validateEventInput(input);
    const sameId = this.events.get(input.id);
    if (sameId) {
      const { sequence: _sequence, occurredAt: _occurredAt, ...existingInput } = sameId;
      const { occurredAt: _inputOccurredAt, ...requestedInput } = input;
      assertSameJson(existingInput, requestedInput, `Event ${input.id} is immutable`);
      return structuredClone(sameId);
    }
    const existingId = this.eventKeys.get(`${input.taskId}:${input.eventKey}`);
    if (existingId) return structuredClone(this.events.get(existingId)!);
    const run = this.runs.get(input.runId);
    if (run && run.taskId !== input.taskId) throw new Error(`Event ${input.id} belongs to another Task Run`);
    if (input.revisionId) {
      const revision = this.revisions.get(input.revisionId);
      if (!revision || revision.taskId !== input.taskId || revision.runId !== input.runId) {
        throw new Error(`Event ${input.id} references an invalid RunRevision ${input.revisionId}`);
      }
    }
    for (const parentId of input.parentEventIds) {
      const parent = this.events.get(parentId);
      if (!parent || parent.taskId !== input.taskId) throw new Error(`Event parent ${parentId} is not in this Task graph`);
    }
    assertArtifactRefs(this.artifacts, input.taskId, input.revisionId, input.artifactIds);
    const event: DistillationEvent = {
      ...structuredClone(input),
      sequence: ++this.sequence,
      occurredAt: input.occurredAt ?? new Date().toISOString()
    };
    this.events.set(event.id, event);
    this.eventKeys.set(`${event.taskId}:${event.eventKey}`, event.id);
    return structuredClone(event);
  }

  async listEvents(taskId: string): Promise<DistillationEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.taskId === taskId)
      .sort(compareEvents)
      .map((event) => structuredClone(event));
  }

  async recordGate(input: Omit<QualityGateAssessment, "assessedAt"> & { assessedAt?: string }): Promise<QualityGateAssessment> {
    validateGate(input);
    const existing = this.gates.get(input.id);
    if (existing) {
      assertSameJson(existing, { ...input, assessedAt: existing.assessedAt }, `Gate assessment ${input.id} is immutable`);
      return structuredClone(existing);
    }
    const revision = this.revisions.get(input.revisionId);
    if (!revision || revision.taskId !== input.taskId || revision.runId !== input.runId) throw new Error(`Gate assessment ${input.id} references an invalid RunRevision ${input.revisionId}`);
    const assessment: QualityGateAssessment = {
      ...structuredClone(input),
      assessedAt: input.assessedAt ?? new Date().toISOString()
    };
    assertArtifactRefs(this.artifacts, assessment.taskId, assessment.revisionId, assessment.evidenceArtifactIds);
    this.gates.set(assessment.id, assessment);
    return structuredClone(assessment);
  }

  async listGates(revisionId: string): Promise<QualityGateAssessment[]> {
    return [...this.gates.values()]
      .filter((gate) => gate.revisionId === revisionId)
      .sort((left, right) => left.assessedAt.localeCompare(right.assessedAt) || left.id.localeCompare(right.id))
      .map((gate) => structuredClone(gate));
  }

  async recordRelease(release: DistillationRelease): Promise<DistillationRelease> {
    if (!release.id || !release.taskId || !release.runId || !release.revisionId || !release.productId || !release.corpusArtifactId) {
      throw new Error("Invalid Distillation Release");
    }
    const existing = this.releases.get(release.id);
    if (existing) {
      assertSameJson(existing, release, `Release ${release.id} is immutable`);
      return structuredClone(existing);
    }
    const revision = this.revisions.get(release.revisionId);
    if (!revision || revision.taskId !== release.taskId || revision.runId !== release.runId) {
      throw new Error(`Release references unknown RunRevision ${release.revisionId}`);
    }
    assertArtifactRefs(this.artifacts, release.taskId, release.revisionId, [release.corpusArtifactId]);
    const corpus = this.artifacts.get(release.corpusArtifactId);
    if (!corpus || corpus.kind !== "corpus_bundle") throw new Error(`Release references a non-corpus Artifact ${release.corpusArtifactId}`);
    this.releases.set(release.id, structuredClone(release));
    return structuredClone(release);
  }

  async derive(taskId: string): Promise<DistillationGraphState> {
    const events = await this.listEvents(taskId);
    const gates = [...this.gates.values()].filter((gate) => gate.taskId === taskId).sort(compareGates);
    const releases = [...this.releases.values()].filter((release) => release.taskId === taskId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return deriveDistillationState(taskId, events, gates, releases.at(-1));
  }
}

export function deriveDistillationState(
  taskId: string,
  events: DistillationEvent[],
  assessments: QualityGateAssessment[],
  latestRelease?: DistillationRelease
): DistillationGraphState {
  const orderedEvents = events.filter((event) => event.taskId === taskId).sort(compareEvents);
  // A Task is a stable lineage, while every correction/recompile creates a
  // new Revision. Derived state must never let a failed gate or a stale node
  // from revision N-1 block revision N.
  const latestRevisionMarker = [...orderedEvents].reverse().find((event) => event.type === "revision_created" && event.revisionId);
  const currentRevisionId = latestRevisionMarker?.revisionId
    ?? [...orderedEvents].reverse().find((event) => event.revisionId)?.revisionId;
  const revisionEvents = currentRevisionId
    ? orderedEvents.filter((event) => event.revisionId === currentRevisionId)
    : orderedEvents;
  const nodeStatus: DistillationGraphState["nodeStatus"] = {};
  const runAnchor = [...orderedEvents].reverse().find((event) => (
    event.runId && (event.type === "run_created" || event.type === "revision_created")
  ));
  let runId: string | undefined = runAnchor?.runId;
  let currentNode: DistillationNodeKind | undefined;
  let correctionRequestedAt = -1;
  let correctionSubmittedAt = -1;
  let waitingAt = -1;
  let readyAt = -1;
  if (!runId) runId = [...orderedEvents].reverse().find((event) => event.runId)?.runId;
  for (const event of revisionEvents) {
    if (event.node) currentNode = event.node;
    if (event.node && event.type === "node_started") nodeStatus[event.node] = "running";
    if (event.node && event.type === "node_completed") nodeStatus[event.node] = "completed";
    if (event.node && event.type === "node_failed") nodeStatus[event.node] = "failed";
    if (event.type === "creator_answers_requested") waitingAt = event.sequence;
    if (event.type === "creator_answers_submitted") waitingAt = -1;
    if (event.type === "correction_requested") correctionRequestedAt = event.sequence;
    if (event.type === "correction_submitted") correctionSubmittedAt = event.sequence;
    if (event.type === "revision_ready") readyAt = event.sequence;
    if (event.type === "revision_created") {
      correctionRequestedAt = -1;
      correctionSubmittedAt = -1;
      readyAt = -1;
    }
  }
  const latestByGate = new Map<string, QualityGateAssessment>();
  for (const gate of assessments
    .filter((gate) => gate.taskId === taskId && (!currentRevisionId || gate.revisionId === currentRevisionId))
    .sort(compareGates)) latestByGate.set(gate.gateKey, gate);
  const gates = [...latestByGate.values()];
  const criticalGateFailures = gates.filter((gate) => gate.critical && ["failed", "blocked"].includes(gate.status)).map((gate) => gate.name);
  const correctionRequired = correctionRequestedAt > correctionSubmittedAt;
  const activeRelease = latestRelease && (!currentRevisionId || latestRelease.revisionId === currentRevisionId)
    ? latestRelease
    : undefined;
  const criticalGates = gates.filter((gate) => gate.critical);
  const allCriticalGatesPassed = criticalGates.length > 0 && criticalGates.every((gate) => gate.status === "passed");
  const status: DistillationGraphState["status"] = correctionRequired || criticalGateFailures.length > 0
      ? "needs_correction"
        : waitingAt >= 0
          ? "waiting_for_creator"
          : activeRelease
            ? "released"
            : readyAt >= 0 && allCriticalGatesPassed
            ? "ready"
          : revisionEvents.length
            ? "running"
            : "not_started";
  return {
    taskId,
    ...(runId ? { runId } : {}),
    ...(currentRevisionId ? { currentRevisionId } : {}),
    ...(currentNode ? { currentNode } : {}),
    nodeStatus,
    gates,
    criticalGateFailures,
    correctionRequired,
    ...(activeRelease ? { latestRelease: structuredClone(activeRelease) } : {}),
    status
  };
}

/**
 * Context fed to Corpus vN. Historical calibration is audit-only; only the
 * current loop and the cumulative regression set are semantic inputs.
 */
export function deriveRevisionContext(
  revision: DistillationRunRevision,
  revisions: DistillationRunRevision[],
  events: DistillationEvent[],
  artifacts: ImmutableArtifactRecord[]
): RevisionContext {
  const revisionsById = new Map(revisions
    .filter((item) => item.taskId === revision.taskId && item.runId === revision.runId)
    .map((item) => [item.id, item]));
  const lineage: DistillationRunRevision[] = [];
  const seen = new Set<string>();
  let cursor: DistillationRunRevision | undefined = revision;
  while (cursor && !seen.has(cursor.id)) {
    lineage.push(cursor);
    seen.add(cursor.id);
    cursor = cursor.parentRevisionId ? revisionsById.get(cursor.parentRevisionId) : undefined;
  }
  lineage.reverse();
  const parent = revision.parentRevisionId ? revisionsById.get(revision.parentRevisionId) : undefined;
  const currentEvents = events
    .filter((event) => event.taskId === revision.taskId && event.runId === revision.runId && event.revisionId === revision.id)
    .sort(compareEvents);
  const parentEvents = parent
    ? events.filter((event) => event.taskId === revision.taskId && event.runId === revision.runId && event.revisionId === parent.id).sort(compareEvents)
    : [];
  const currentLoopFeedbackArtifactIds = currentEvents
    .filter((event) => event.type === "correction_submitted" || event.type === "node_failed")
    .flatMap((event) => event.artifactIds);
  const lineageIndex = new Map(lineage.map((item, index) => [item.id, index]));
  const regressionArtifactIds = events
    .filter((event) => event.taskId === revision.taskId && event.runId === revision.runId && event.type === "gate_assessed" && event.node === "regression_eval" && lineageIndex.has(event.revisionId ?? ""))
    .sort((left, right) => (lineageIndex.get(left.revisionId ?? "") ?? 0) - (lineageIndex.get(right.revisionId ?? "") ?? 0) || compareEvents(left, right))
    .flatMap((event) => event.artifactIds)
    .filter((artifactId, index, values) => values.indexOf(artifactId) === index);
  const parentCorpusArtifactId = parentEvents
    .filter((event) => event.type === "node_completed" && event.node === "corpus")
    .flatMap((event) => event.artifactIds)
    .find((artifactId) => artifacts.some((artifact) => artifact.artifactId === artifactId && artifact.kind === "corpus_bundle"));
  return {
    ...(parent ? { parentRevisionId: parent.id } : {}),
    ...(parentCorpusArtifactId ? { parentCorpusArtifactId } : {}),
    currentLoopFeedbackArtifactIds: [...new Set(currentLoopFeedbackArtifactIds)],
    cumulativeRegressionArtifactIds: [...new Set(regressionArtifactIds)]
  };
}

export function graphEventKey(type: DistillationEventType, runId: string, revisionId: string | undefined, payload: Record<string, unknown>): string {
  const digest = createHash("sha256").update(JSON.stringify({ type, runId, revisionId, payload })).digest("hex").slice(0, 24);
  return `${runId}:${type}:${digest}`;
}

export function newGraphEventId(): string { return `evt_${randomUUID().replaceAll("-", "")}`; }

function compareEvents(left: DistillationEvent, right: DistillationEvent): number {
  return left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function compareGates(left: QualityGateAssessment, right: QualityGateAssessment): number {
  return left.assessedAt.localeCompare(right.assessedAt) || left.id.localeCompare(right.id);
}

export function validateArtifact(record: ImmutableArtifactRecord): void {
  if (!record.artifactId || !record.taskId || !record.objectKey || !/^sha256:[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !record.mediaType) {
    throw new Error("Invalid immutable Artifact record");
  }
}

function validateEventInput(input: Omit<DistillationEvent, "sequence" | "occurredAt"> & { occurredAt?: string }): void {
  if (!input.id || !input.eventKey || !input.taskId || !input.runId || !input.type || !input.actor || !Array.isArray(input.parentEventIds) || !Array.isArray(input.artifactIds)) {
    throw new Error("Invalid Distillation graph event");
  }
}

function validateGate(input: Omit<QualityGateAssessment, "assessedAt"> & { assessedAt?: string }): void {
  if (!input.id || !input.gateKey || !input.taskId || !input.runId || !input.revisionId || !input.name || !input.status || !Array.isArray(input.evidenceArtifactIds)) {
    throw new Error("Invalid Quality Gate assessment");
  }
}

function assertArtifactRefs(
  artifacts: Map<string, ImmutableArtifactRecord>,
  taskId: string,
  revisionId: string | undefined,
  artifactIds: string[]
): void {
  for (const artifactId of artifactIds) {
    const artifact = artifacts.get(artifactId);
    if (!artifact) throw new Error(`Event or gate references unknown Artifact ${artifactId}`);
    if (artifact.taskId !== taskId) throw new Error(`Artifact ${artifactId} belongs to another Task`);
    if (revisionId && artifact.revisionId && artifact.revisionId !== revisionId) {
      throw new Error(`Artifact ${artifactId} belongs to another RunRevision`);
    }
  }
}

function assertSameJson(left: unknown, right: unknown, message: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(message);
}

/**
 * Compare immutable records by value rather than by object insertion order.
 * Postgres row mappers and retry paths can materialize the same record with a
 * different property order; that is not a mutation of the record.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function artifactIdentity(record: ImmutableArtifactRecord): Omit<ImmutableArtifactRecord, "createdAt"> {
  const { createdAt: _createdAt, ...identity } = record;
  return identity;
}

function runIdentity(run: DistillationRun): Omit<DistillationRun, "createdAt"> {
  const { createdAt: _createdAt, ...identity } = run;
  return identity;
}
